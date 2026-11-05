// Automatic SUGGESTION of fixes (remediationMode "hybrid" / "auto"). Nothing here edits a document: every
// fix is computed and handed to remediation/inlineDiff.js, which renders it inline and waits for Accept.
//
// WHAT MAY BE SUGGESTED WITHOUT A CLICK is decided per rule, never by the mode alone:
//   fixTier 'safe'    additive, no behaviour change (a straight value swap)
//   fixTier 'medium'  behaviour-adding; a human would normally choose between options
//   fixTier 'ai-suggested'  written by an AI provider; suggested proactively ONLY in mode 'auto', and only
//                     through the AI pipeline's cost controls and consent gates (runAi below)
//   no / invalid tier NEVER suggested automatically, in any mode (a fixer must be tiered explicitly)
//   mode manual  -> nothing is suggested automatically (the click-based Quick Fix is unchanged)
//   mode hybrid  -> 'safe' only     mode auto -> 'safe' + 'medium' (+ 'ai-suggested' via runAi)
//
// Scope: only the open document that was just analysed, never the workspace. In-session only:
// nothing is persisted or sent anywhere (this is visibility, not an audit trail).
//
// LOOP / SAFETY GUARDS
//   - Each instance is identified like changeTracker identifies candidates: rule + file + structural path +
//     content hash. An instance that was accepted OR dismissed is never suggested again this session (so an
//     undo is respected instead of fought). Editing the violating content gives a new identity: a new suggestion.
//   - After an Accept, the next scan must no longer report that rule at that structural slot. If it does,
//     the fix did not resolve it: it is logged once, marked failed, and never suggested again (manual quick
//     fix only) for the rest of the session.
//   - If the edit is rejected by the workspace, the same applies (no retry loop).
//   - Nothing is suggested if the text changed since it was analysed, or if a debounced rescan is already
//     pending (the user is typing).
//   - A pending suggestion whose violation disappeared (fixed by hand, edited away) is dropped on the next scan.

const { getRuleById } = require('../analyzer');
const { buildFixEdit, buildAiFixEdit } = require('../codeActions');
const { createChangeTracker } = require('../judgment/changeTracker');
const { effectiveFixer } = require('../judgment/genericFix');
const { MAX_CANDIDATES_PER_BATCH } = require('../judgment/aiReview');
const { parseCSS } = require('../parsers/cssParser');
const { parseHTML, walkNode } = require('../parsers/htmlParser');
const { parseJSX, walkJSX } = require('../parsers/jsxParser');
const { htmlPath, buildJsxInfo } = require('../rules/shared/elementContext');

// Every tier a fix may declare. Only some of them may ever run without a click.
const AI_SUGGESTED = 'ai-suggested';
const FIX_TIERS = ['safe', 'medium', AI_SUGGESTED];
// The tiers whose fix is computed synchronously and may be suggested inline on every scan. 'ai-suggested' is
// deliberately NOT here: it costs a paid request, so it takes the separate runAi path (mode 'auto' only).
// Enforced where eligibility is decided AND again where edits are assembled (buildFixEdit refuses it too).
const AUTO_APPLY_TIERS = ['safe', 'medium'];
const REMEDIATION_MODES = ['manual', 'hybrid', 'auto'];

// The rule's tier, or null when it has no fix() or no valid explicit tag.
function fixTierOf(rule) {
  return rule && typeof rule.fix === 'function' && FIX_TIERS.includes(rule.fixTier) ? rule.fixTier : null;
}

function isAutoEligible(rule, mode) {
  const tier = fixTierOf(rule);
  if (!tier) return false; // the per-rule gate: no mode can override it
  if (!AUTO_APPLY_TIERS.includes(tier)) return false; // 'ai-suggested': never on the synchronous path
  if (mode === 'hybrid') return tier === 'safe';
  if (mode === 'auto') return true; // 'safe' or 'medium'
  return false;
}

// ---- structural identity of a violation ---------------------------------------------------
// "rule(selector)[n]>decl(prop)[n]": each segment is a descriptor plus its index among same-
// descriptor siblings, so inserting or removing lines elsewhere never changes it.
function descriptor(n) {
  if (n.type === 'rule') return 'rule(' + n.selector + ')';
  if (n.type === 'atrule') return '@' + n.name + '(' + n.params + ')';
  if (n.type === 'decl') return 'decl(' + String(n.prop).toLowerCase() + ')';
  return n.type;
}

function cssLocator(sourceCode) {
  const root = parseCSS(sourceCode);
  if (!root) return () => null;
  const byStart = new Map();
  root.walk((node) => {
    const s = node.source && node.source.start;
    if (s && !byStart.has((s.line - 1) + ':' + (s.column - 1))) byStart.set((s.line - 1) + ':' + (s.column - 1), node);
  });
  return (v) => {
    let node = byStart.get(v.startLine + ':' + v.startChar);
    if (!node) return null;
    const segs = [];
    for (; node && node.type !== 'root'; node = node.parent) {
      const key = descriptor(node);
      let idx = 0;
      for (const sib of (node.parent && node.parent.nodes) || []) {
        if (sib === node) break;
        if (sib.type === node.type && descriptor(sib) === key) idx++;
      }
      segs.unshift(key + '[' + idx + ']');
    }
    return segs.join('>');
  };
}

// HTML: the element whose START TAG begins at the violation, as candidateSelector's "html[0]>body[0]>a[2]" path.
function htmlLocator(sourceCode) {
  const ast = parseHTML(sourceCode);
  if (!ast) return () => null;
  const byStart = new Map();
  walkNode(ast, (n) => {
    const t = n.tagName && n.sourceCodeLocation && n.sourceCodeLocation.startTag;
    if (t) byStart.set((t.startLine - 1) + ':' + (t.startCol - 1), n);
  });
  return (v) => {
    const node = byStart.get(v.startLine + ':' + v.startChar);
    return node ? htmlPath(node) : null;
  };
}

// JSX/TSX: the element whose OPENING element begins at the violation, as candidateSelector's path.
function jsxLocator(sourceCode) {
  const ast = parseJSX(sourceCode);
  if (!ast) return () => null;
  const info = buildJsxInfo(ast);
  const byStart = new Map();
  walkJSX(ast, (n) => {
    if (n.type === 'JSXElement' && n.openingElement && n.openingElement.loc) {
      const l = n.openingElement.loc.start;
      byStart.set((l.line - 1) + ':' + l.column, n);
    }
  });
  return (v) => {
    const node = byStart.get(v.startLine + ':' + v.startChar);
    const i = node && info.get(node);
    return i && i.path ? i.path : null;
  };
}

// A structural path per language, so inserting or removing lines elsewhere never changes an instance's identity
// (a dismissed suggestion stays dismissed). A position that matches no node falls back to "pos:L:C", which is
// stable only until lines move.
function makeLocator(languageId, sourceCode) {
  let structural = () => null;
  try {
    if (languageId === 'css') structural = cssLocator(sourceCode);
    else if (languageId === 'html') structural = htmlLocator(sourceCode);
    else if (languageId === 'javascriptreact' || languageId === 'typescriptreact') structural = jsxLocator(sourceCode);
  } catch (e) { structural = () => null; }
  return (v) => structural(v) || ('pos:' + v.startLine + ':' + v.startChar);
}

function rangeText(sourceCode, v) {
  const lines = sourceCode.split(/\r\n|\r|\n/);
  if (v.startLine === v.endLine) return (lines[v.startLine] || '').slice(v.startChar, v.endChar);
  const out = [(lines[v.startLine] || '').slice(v.startChar)];
  for (let i = v.startLine + 1; i < v.endLine; i++) out.push(lines[i] || '');
  out.push((lines[v.endLine] || '').slice(0, v.endChar));
  return out.join('\n');
}

const SEP = '\u0002';

// True for a rule whose fix is AI-written and may be suggested proactively in this mode (only 'auto').
function isAiAutoEligible(rule, mode) {
  return mode === 'auto' && fixTierOf(rule) === AI_SUGGESTED;
}

// options.inline  the inlineDiff instance suggestions go to (required)
// options.report  default { suggested, failed } callbacks (in-session visibility)
function createAutoFixer({ inline, report: defaultReport } = {}) {
  if (!inline) throw new Error('createAutoFixer: an inlineDiff instance is required');
  const identity = createChangeTracker();   // reused for its slot+hash identity recipe
  const aiAttempts = createChangeTracker(); // AI fixes that ended without an offer (low confidence / unavailable)
  const failedSlots = new Set();            // slots whose fix did not resolve: manual quick fix only
  const awaiting = new Map();               // filePath -> [{ slot, ruleId, tier, line }] accepted, not yet verified
  const running = new Set();                // filePaths with a synchronous run in progress
  const runningAi = new Set();              // filePaths with an AI run in progress
  const slotOf = (id) => id.split(SEP)[0];
  const rep = (report, name, rec) => {
    const r = report || defaultReport;
    if (r && typeof r[name] === 'function') { try { r[name](rec); } catch (e) { /* visibility only */ } }
  };

  // An accepted fix is verified by the NEXT scan: it must stop reporting that slot.
  inline.on('accepted', (rec) => {
    if (!awaiting.has(rec.filePath)) awaiting.set(rec.filePath, []);
    awaiting.get(rec.filePath).push(rec);
  });
  // The workspace refused the edit: do not offer it again.
  inline.on('applyFailed', (rec) => {
    failedSlots.add(rec.slot);
    rep(null, 'failed', { ...rec, reason: 'edit-rejected' });
  });

  const decided = (id) => inline.tracker.dispositionOf(id);

  // document        the analysed vscode.TextDocument (active editor)
  // violations      the scan's violations; sourceAtScan the exact text they describe
  // mode            'hybrid' | 'auto' (anything else does nothing)
  // canApplyNow     () => boolean; false while the user is mid-edit (a debounced rescan is pending)
  async function run({ document, languageId, violations, sourceAtScan, mode, canApplyNow, report }) {
    const out = { suggested: [], failed: [], skipped: 0 };
    if (mode !== 'hybrid' && mode !== 'auto') return out;
    const filePath = inline.fileKeyOf(document);
    if (running.has(filePath)) return out;
    running.add(filePath);
    try {
      const locate = makeLocator(languageId, sourceAtScan);
      const idOf = (v) => identity.identity(filePath, {
        ruleId: v.ruleId, content: rangeText(sourceAtScan, v), path: locate(v)
      });

      // 1. Verify the previous Accept on this file: did the rescan stop reporting those slots?
      const previous = awaiting.get(filePath);
      if (previous && previous.length) {
        awaiting.delete(filePath);
        const reportedNow = new Set(violations.map(v => slotOf(idOf(v))));
        for (const rec of previous) {
          if (reportedNow.has(rec.slot)) {
            failedSlots.add(rec.slot); // marked once; never suggested again
            out.failed.push({ ...rec, reason: 'not-resolved' });
            rep(report, 'failed', { ...rec, reason: 'not-resolved' });
          }
        }
      }

      // 2. Only work on exactly the text that was analysed, and never mid-keystroke.
      if (document.getText() !== sourceAtScan) return out;
      if (typeof canApplyNow === 'function' && !canApplyNow()) return out;

      // 3. Suggest the eligible, undecided violations, in document order, skipping any that overlaps another.
      const currentIds = new Set();
      const items = [];
      for (const v of violations) {
        const id = idOf(v);
        currentIds.add(id);
        const rule = getRuleById(v.ruleId);
        if (!isAutoEligible(rule, mode)) continue; // untagged, or tier not allowed by this mode
        const slot = slotOf(id);
        if (failedSlots.has(slot) || decided(id)) { out.skipped++; continue; }
        if (!AUTO_APPLY_TIERS.includes(fixTierOf(rule))) continue; // second, independent guard
        items.push({ v, rule, id, slot, tier: fixTierOf(rule) });
      }
      items.sort((a, b) => a.v.startLine - b.v.startLine || a.v.startChar - b.v.startChar);
      const keepSync = new Set();
      for (const it of items) {
        const built = buildFixEdit(document, it.v, it.rule); // fix() may decline (nothing computable): no suggestion
        if (!built) { out.skipped++; continue; }
        if (inline.overlaps(document, built.range, it.id)) { out.skipped++; continue; }
        // An already-pending instance is refreshed in place (its range may have moved); the fix is cheap and
        // deterministic, so it is recomputed, but it is only re-rendered if something actually changed.
        const res = inline.propose({
          document, id: it.id, slot: it.slot, ruleId: it.v.ruleId, tier: it.tier, kind: 'sync',
          built, oldText: rangeText(sourceAtScan, built.range)
        });
        keepSync.add(it.id);
        if (res === 'new') {
          const rec = { ruleId: it.v.ruleId, tier: it.tier, line: it.v.startLine + 1, slot: it.slot, filePath, id: it.id };
          out.suggested.push(rec);
          rep(report, 'suggested', rec);
        }
      }

      // 4. Drop pending suggestions that no longer apply: the violation is gone, it is no longer eligible in this
      //    mode, or (AI suggestions, which are not recomputed) the text under them moved.
      inline.reconcile(document, (e) => {
        if (e.kind === 'sync') return keepSync.has(e.id);
        // Batch-remediation suggestions are keyed by their own ids; they stay while their text is unchanged.
        if (e.kind === 'batch') return mode !== 'manual' && rangeText(sourceAtScan, e.range) === e.oldText;
        return currentIds.has(e.id) && mode === 'auto' && rangeText(sourceAtScan, e.range) === e.oldText;
      });
      inline.flush(document);
      return out;
    } finally {
      running.delete(filePath);
    }
  }

  // Proactive AI fix suggestions (mode 'auto' only). Costs money, so it goes through the same controls as the
  // judgment layer, and the caller (extension.js) runs it on the same aiReviewDebounceMs timer:
  //   - one identity per instance (changeTracker): anything pending, accepted, dismissed or failed is skipped,
  //     and an attempt that ended without an offer (low confidence / unavailable) is not repeated
  //   - at most MAX_CANDIDATES_PER_BATCH per run; the rest wait for the next scan
  //   - `resolve` is the quiet form of the AI fixer: it checks the API key first, then the one-time blocking
  //     disclosure, and only then sends. If either gate says no (no-key / declined) the batch stops there.
  // resolve({rule, violation, document}) -> aiFixer result; salt "provider/model" scopes the attempt memory.
  async function runAi({ document, languageId, violations, sourceAtScan, mode, resolve, salt, report, log }) {
    const out = { proposed: 0, attempted: 0, deferred: 0, stopped: null };
    if (mode !== 'auto' || typeof resolve !== 'function') return out;
    const filePath = inline.fileKeyOf(document);
    if (runningAi.has(filePath)) return { ...out, blocked: true }; // the caller re-schedules: this scan's content must not be lost
    runningAi.add(filePath);
    const say = (line) => { if (typeof log === 'function') { try { log(line); } catch (e) { /* visibility only */ } } };
    try {
      const locate = makeLocator(languageId, sourceAtScan);
      const candidates = [];
      for (const v of violations) {
        // The rule's own AI fix, or the generic AI fixer for a rule with no fix() (never both; outline-removed keeps its own).
        const rule = effectiveFixer(getRuleById(v.ruleId));
        if (!isAiAutoEligible(rule, mode)) continue;
        const content = rangeText(sourceAtScan, v);
        const path = locate(v);
        const id = identity.identity(filePath, { ruleId: v.ruleId, content, path });
        const slot = slotOf(id);
        if (failedSlots.has(slot) || decided(id) || inline.has(filePath, id)) continue;
        candidates.push({ ruleId: v.ruleId, content, path, v, rule, id, slot });
      }
      candidates.sort((a, b) => a.v.startLine - b.v.startLine || a.v.startChar - b.v.startChar);
      const todo = aiAttempts.pending(filePath, candidates, salt);
      const batch = todo.slice(0, MAX_CANDIDATES_PER_BATCH);
      out.deferred = todo.length - batch.length;

      for (const c of batch) {
        if (document.getText() !== sourceAtScan) { out.stopped = 'stale'; break; } // typed meanwhile: the next scan retries (cached)
        out.attempted++;
        const res = await resolve({ rule: c.rule, violation: c.v, document });
        if (!res || res.status === 'no-key' || res.status === 'declined') { out.stopped = res ? res.status : 'error'; break; }
        if (res.status === 'error') {
          if (res.code === 'AUTH') { out.stopped = 'auth'; break; } // a rejected key fails every call alike
          continue; // not remembered: retried on a later scan
        }
        if (res.status !== 'ok') { aiAttempts.recordResult(filePath, c, res.status, salt); continue; } // low-confidence / unavailable
        // A fix that "succeeded" without a replaceable range and text is unusable (never throw into the scan).
        const rg = res.range;
        if (typeof res.newText !== 'string' || !rg || ![rg.startLine, rg.startChar, rg.endLine, rg.endChar].every(Number.isInteger) || !res.suggestion) {
          aiAttempts.recordResult(filePath, c, 'unusable', salt);
          continue;
        }
        if (document.getText() !== sourceAtScan) { out.stopped = 'stale'; break; }
        const built = buildAiFixEdit(document, res, c.rule, { needsConfirmation: false }); // the inline diff is the review
        if (inline.overlaps(document, built.range, c.id)) continue;
        const detail = 'confidence ' + res.suggestion.confidence.toFixed(2) + ': ' + res.suggestion.reasoning;
        const r = inline.propose({
          document, id: c.id, slot: c.slot, ruleId: c.v.ruleId, tier: AI_SUGGESTED, kind: 'ai',
          built, oldText: rangeText(sourceAtScan, built.range), detail
        });
        if (r === 'new') {
          out.proposed++;
          rep(report, 'suggested', { ruleId: c.v.ruleId, tier: AI_SUGGESTED, line: c.v.startLine + 1, slot: c.slot, filePath, id: c.id });
        }
        inline.flush(document);
      }
      if (out.deferred > 0) say('  ' + out.deferred + ' more AI fix' + (out.deferred === 1 ? '' : 'es') + ' not requested (limit ' + MAX_CANDIDATES_PER_BATCH + ' per run); they are picked up on a later scan.');
      return out;
    } finally {
      runningAi.delete(filePath);
    }
  }

  return { run, runAi, _state: { failedSlots, awaiting } };
}

module.exports = { createAutoFixer, isAutoEligible, isAiAutoEligible, fixTierOf, makeLocator, rangeText, FIX_TIERS, AUTO_APPLY_TIERS, AI_SUGGESTED, REMEDIATION_MODES };
