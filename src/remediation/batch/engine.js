// Batch remediation: fix many issues with few requests. vscode-free; the extension supplies files, gates and I/O.
//
// engine.remediate({ files, config, gates, readAssetFor, projectFacts, onProgress, isCancelled }) -> {
//   proposals: [proposal], requests, cached, deferred, errors: [{ file, message }], stopped: null | 'no-key' | 'declined' | 'cancelled' | 'auth'
// }
// files: [{ filePath, languageId, source, violations }]
//
// Per file, in order:
//   1. a rule's own deterministic fix (outline-removed) is used as is: free, exact, verified like the rest;
//   2. every other issue goes to the model, ALL issues of a file in one request (chunked at MAX_ISSUES_PER_REQUEST);
//      an issue whose code, context and model are unchanged since it was last answered is served from the cache;
//   3. each answer is verified locally (verify.js) before it becomes a proposal.
// The consent gates run once, right before the first request of a run: no key -> nothing sent; disclosure cancelled
// -> nothing sent. A run stops at the first AUTH failure (every request would fail alike).
//
// proposal = { id, file, languageId, ruleId, severity, wcag, line, source: 'ai' | 'deterministic', status, confidence,
//              summary, steps, testing, needsInput, coveredBy, ranges, verification, model, issueKey, problem }
// status: 'fixed' | 'needs-input' | 'false-positive' | 'cannot-fix' | 'covered' | 'error'

const crypto = require('crypto');
const { buildFileContext } = require('./context');
const { buildBatchRequest, chunkIssues, parseBatchReply, MAX_ISSUES_PER_REQUEST } = require('./prompt');
const { verifyFix, makeAnalyzer } = require('./verify');
const { getRuleById } = require('../../analyzer');

const MAX_ISSUES_PER_RUN = 80;
const MAX_IMAGES_PER_REQUEST = 6;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Identifies "the same issue" across rescans: rule + the exact flagged text.
const matchKeyOf = (ruleId, flaggedText) => sha(ruleId + '\u0000' + flaggedText);

function matchKeysFor(source, violations) {
  return new Set(violations.map(v => { const r = rangeFromViolation(source, v); return matchKeyOf(v.ruleId, source.slice(r.start, r.end)); }));
}

function rangeFromViolation(source, v) {
  const { lineStarts, offsetOf } = require('../../rules/shared/genericContext');
  const starts = lineStarts(source);
  return { start: offsetOf(starts, source, v.startLine, v.startChar), end: offsetOf(starts, source, v.endLine, v.endChar) };
}

function createRemediationEngine({ requestFix, salt }) {
  if (typeof requestFix !== 'function') throw new Error('createRemediationEngine: requestFix is required');
  const cache = new Map(); // salt + issue cacheKey -> parsed answer for that issue

  async function remediate({ files, config, gates, readAssetFor, projectFacts, onProgress, isCancelled, maxIssues, retryUnresolved }) {
    const out = { proposals: [], requests: 0, cached: 0, deferred: 0, errors: [], stopped: null };
    const analyze = makeAnalyzer(config);
    const keySalt = typeof salt === 'function' ? salt(config) : (salt || '');
    const budget = { left: maxIssues || MAX_ISSUES_PER_RUN };
    let gated = false;
    const progress = (msg) => { if (typeof onProgress === 'function') { try { onProgress(msg); } catch (e) { /* visibility only */ } } };
    const cancelled = () => typeof isCancelled === 'function' && isCancelled();

    async function passGates() {
      if (gated) return true;
      const g = gates || {};
      if (g.hasKey && !(await g.hasKey(config))) { out.stopped = 'no-key'; return false; }
      if (g.confirm && !(await g.confirm())) { out.stopped = 'declined'; return false; }
      gated = true;
      return true;
    }

    for (const file of files) {
      if (out.stopped || cancelled()) { out.stopped = out.stopped || 'cancelled'; break; }
      const { filePath, languageId, source } = file;
      const violations = file.violations || [];
      if (!violations.length) continue;
      const ctx = buildFileContext({
        source, languageId, violations, fileName: filePath,
        readAsset: typeof readAssetFor === 'function' ? readAssetFor(filePath) : null, projectFacts
      });
      if (!ctx) continue;

      const base = (it) => ({
        id: sha(filePath + '\u0000' + it.cacheKey), issueKey: it.cacheKey, matchKey: matchKeyOf(it.ruleId, source.slice(it.offsets.start, it.offsets.end)), file: filePath, languageId,
        ruleId: it.ruleId, severity: it.severity, wcag: it.wcag, line: it.line, problem: it.problem
      });

      // 1. deterministic fixes
      const aiIssues = [];
      for (const it of ctx.issues) {
        const rule = getRuleById(it.ruleId);
        if (rule && typeof rule.fix === 'function' && (rule.fixTier === 'safe' || rule.fixTier === 'medium')) {
          let r = null;
          try { r = rule.fix(it.violation, source); } catch (e) { r = null; }
          if (r && typeof r.newText === 'string') {
            const span = rangeFromViolation(source, it.violation);
            const ranges = [{ start: span.start, end: span.end, oldText: source.slice(span.start, span.end), newText: r.newText }];
            const verification = await verifyFix({ source, languageId, ruleId: it.ruleId, ranges, analyze });
            out.proposals.push({ ...base(it), source: 'deterministic', status: 'fixed', confidence: 1, summary: 'Computed fix from the ' + it.ruleId + ' rule.', steps: [], testing: 'Tab to the element and check the focus indicator is clearly visible.', needsInput: '', coveredBy: '', ranges: verification.ranges, verification, model: 'deterministic' });
            continue;
          }
        }
        aiIssues.push(it);
      }
      if (!aiIssues.length) continue;

      // 2. cache, budget, then requests
      const todo = [];
      for (const it of aiIssues) {
        const hit = cache.get(keySalt + it.cacheKey);
        // A fix is re-verified against the current text below, so it is reused as is. An answer that fixed nothing is
        // asked again once the code around the issue changed: the new context may settle it.
        // Only on a run the developer started: a proactive run must not pay again on every edit.
        const unresolved = hit && retryUnresolved && (hit.status === 'cannot-fix' || hit.status === 'needs-input');
        if (hit && !(unresolved && hit.regionHash !== it.regionHash)) { out.cached++; it._answer = hit; continue; }
        if (budget.left <= 0) { out.deferred++; it._deferred = true; continue; }
        budget.left--;
        todo.push(it);
      }

      const queue = chunkIssues(todo, MAX_ISSUES_PER_REQUEST);
      while (queue.length && !out.stopped) {
        if (cancelled()) { out.stopped = 'cancelled'; break; }
        const chunk = queue.shift();
        if (!(await passGates())) break;
        const request = buildBatchRequest(ctx, chunk, { source });
        if (request.images.length > MAX_IMAGES_PER_REQUEST) request.images = request.images.slice(0, MAX_IMAGES_PER_REQUEST);
        progress('Asking AI to fix ' + chunk.length + ' issue' + (chunk.length === 1 ? '' : 's') + ' in ' + require('path').basename(filePath));
        let reply;
        try {
          out.requests++;
          reply = await requestFix(request, config);
        } catch (e) {
          if (e && e.code === 'TRUNCATED' && chunk.length > 1) {
            const half = Math.ceil(chunk.length / 2);
            queue.unshift(chunk.slice(0, half), chunk.slice(half));
            continue;
          }
          if (e && e.code === 'AUTH') out.stopped = 'auth';
          const message = (e && e.message) || 'request failed';
          out.errors.push({ file: filePath, message });
          for (const it of chunk) it._error = message;
          continue;
        }
        const parsed = parseBatchReply(reply, chunk.map(c => c.id));
        if (!parsed) {
          out.errors.push({ file: filePath, message: 'The AI reply did not match the expected format.' });
          for (const it of chunk) it._error = 'unusable reply';
          continue;
        }
        for (const it of chunk) {
          const a = parsed.get(it.id);
          if (a) { it._answer = { ...a, model: keySalt, regionHash: it.regionHash }; cache.set(keySalt + it.cacheKey, it._answer); }
          else it._error = 'the AI did not answer this issue';
        }
      }

      // 3. verify and build proposals
      const byLocalId = new Map(aiIssues.map(it => [it.id, it]));
      for (const it of aiIssues) {
        if (it._deferred) continue;
        if (!it._answer) {
          if (it._error) out.proposals.push({ ...base(it), source: 'ai', status: 'error', confidence: 0, summary: it._error, steps: [], testing: '', needsInput: '', coveredBy: '', ranges: [], verification: null, model: keySalt });
          continue;
        }
        const a = it._answer;
        let status = a.status;
        let verification = null;
        let coveredBy = '';
        if (a.coveredBy && byLocalId.has(a.coveredBy)) {
          status = 'covered';
          coveredBy = sha(filePath + '\u0000' + byLocalId.get(a.coveredBy).cacheKey);
        } else if ((status === 'fixed' || status === 'needs-input') && a.edits.length) {
          verification = await verifyFix({ source, languageId, ruleId: it.ruleId, edits: a.edits, near: [it.region.start, it.region.end], analyze });
        } else if (status === 'fixed' || status === 'needs-input') {
          status = 'cannot-fix';
        }
        out.proposals.push({
          ...base(it), source: 'ai', status, confidence: a.confidence, summary: a.summary, steps: a.steps, testing: a.testing,
          needsInput: a.needsInput, coveredBy, ranges: verification ? verification.ranges : [], verification, model: a.model || keySalt
        });
      }
    }
    return out;
  }

  return { remediate, _cache: cache };
}

module.exports = { createRemediationEngine, matchKeysFor, MAX_ISSUES_PER_RUN };
