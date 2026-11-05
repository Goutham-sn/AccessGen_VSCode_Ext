// Orchestration for the AI judgment layer: select candidates, ask the configured provider to
// judge the ones that are new or changed, and report the results. vscode-free so it can be
// tested directly; extension.js supplies the output sink and the config (incl. SecretStorage).
//
// What leaves the machine: only what prompts.js builds from a candidate (its own text plus the
// minimal context named there). Nothing here sends a file path, source, or key.

const { parseHTML } = require('../parsers/htmlParser');
const { parseJSX } = require('../parsers/jsxParser');
const { selectCandidates } = require('./candidateSelector');
const { createChangeTracker } = require('./changeTracker');
const providers = require('./providers');

// Hard cap on provider calls per review run. A big page can't turn one scan into hundreds of
// paid calls; the remainder is not marked reviewed, so the next run picks it up.
const MAX_CANDIDATES_PER_BATCH = 25;

const tracker = createChangeTracker();
const inFlight = new Set(); // identities currently being judged (scans overlap while typing)

function parseFor(languageId, sourceCode) {
  if (languageId === 'html') return parseHTML(sourceCode);
  if (languageId === 'javascriptreact' || languageId === 'typescriptreact') return parseJSX(sourceCode);
  return null;
}

// All current candidates for a document (no change-skip).
function collectCandidates({ sourceCode, languageId, violations, config }) {
  const ast = parseFor(languageId, sourceCode);
  if (!ast) return [];
  return selectCandidates({ violations, ast, languageId, config });
}

function where(c) {
  return `${c.location.startLine + 1}:${c.location.startChar + 1}`;
}

function formatCandidate(c) {
  return `  [${c.ruleId}] ${c.wcag}  line ${where(c)}  (${c.source}) ${JSON.stringify(c.content)}`;
}

function formatResult(c, r, cached) {
  const tag = r.verdict.toUpperCase();
  return `  [${c.ruleId}] ${where(c)}  ${JSON.stringify(c.content)}  -> ${tag} (${r.confidence.toFixed(2)})${cached ? ' (cached)' : ''}: ${r.reasoning}`;
}

function formatFailure(c, e) {
  const code = (e && e.code) || 'ERROR';
  // AiError messages are written to be safe to show; anything else gets a generic line.
  const msg = e && e.name === 'AiError' ? e.message : 'Unexpected error while judging this candidate.';
  return `  [${c.ruleId}] ${where(c)}  ${JSON.stringify(c.content)}  -> review failed (${code}): ${msg}`;
}

// mode: 'manual' lists every current candidate (cached verdicts are shown, not re-requested);
//       'auto'   reports only candidates that were judged during this run.
// Resolves { status: 'ok' | 'no-key' | 'declined', provider, judged, failed, cached, deferred, aborted }.
// input.confirmFirstSend (optional): async () => boolean, asked right before the first send; false => 'declined'.
// Individual call failures never reject: each is reported and the rest of the batch continues.
async function runReview(mode, input, write) {
  const { sourceCode, languageId, violations, config, filePath, confirmFirstSend } = input;
  const providerName = providers.providerName(config);
  const candidates = collectCandidates({ sourceCode, languageId, violations, config });
  const label = `${providerName}/${providers.resolveModel(config)}`;
  const salt = label; // a stored verdict belongs to the provider/model that gave it
  const pending = tracker.pending(filePath, candidates, salt);
  const pendingSet = new Set(pending);
  const cachedList = candidates.filter(c => !pendingSet.has(c));
  const out = { status: 'ok', provider: providerName, judged: 0, failed: 0, cached: cachedList.length, deferred: 0, aborted: false };

  // A key is only needed if something actually has to be judged.
  if (pending.length > 0 && !(await providers.getApiKey(config))) {
    return { ...out, status: 'no-key' };
  }

  const todo = pending.filter(c => !inFlight.has(tracker.identity(filePath, c, salt)));
  const batch = todo.slice(0, MAX_CANDIDATES_PER_BATCH);
  out.deferred = todo.length - batch.length;
  // Reserve the WHOLE batch now, in the same synchronous step as the filter above. Reserving
  // one candidate at a time would let an overlapping scan claim the ones not reached yet.
  const reserved = batch.map(c => tracker.identity(filePath, c, salt));
  reserved.forEach(id => inFlight.add(id));

  try {
    // The caller may require an explicit OK before the FIRST candidate in this install goes to
    // a provider. It is asked only when something is actually about to be sent (never for "no
    // key", "nothing new" or "all cached"), and before anything is written or requested.
    // Declining sends nothing; the batch stays pending and its reservation is released below.
    if (batch.length > 0 && typeof confirmFirstSend === 'function') {
      let allowed = false;
      try { allowed = (await confirmFirstSend()) === true; } catch (e) { allowed = false; }
      if (!allowed) return { ...out, status: 'declined' };
    }

    if (mode === 'manual' || batch.length > 0 || out.deferred > 0) {
      write(`AI review (${label}, ${mode}) — ${filePath}: ${batch.length} to judge, ${cachedList.length} unchanged`);
    } else {
      write(`AI review (${label}, ${mode}) — ${filePath}: nothing new to judge, ${cachedList.length} unchanged`);
    }

    if (mode === 'manual') {
      for (const c of cachedList) write(formatResult(c, tracker.getResult(filePath, c, salt), true));
    }

    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      try {
        const result = await providers.judgeContent(c, config);
        tracker.recordResult(filePath, c, result, salt);
        out.judged++;
        write(formatResult(c, result, false));
      } catch (e) {
        out.failed++;
        write(formatFailure(c, e));
        // A rejected key fails every remaining call identically; stop instead of repeating it.
        if (e && e.code === 'AUTH') { out.aborted = true; break; }
      } finally {
        inFlight.delete(reserved[i]);
      }
    }
  } finally {
    reserved.forEach(id => inFlight.delete(id)); // anything not reached (abort, unexpected throw)
  }

  if (out.deferred > 0) {
    write(`  ${out.deferred} more candidate${out.deferred === 1 ? '' : 's'} not reviewed (limit ${MAX_CANDIDATES_PER_BATCH} per run); run the review again to continue.`);
  }
  if (batch.length > 0) {
    write(`  done: ${out.judged} judged, ${out.failed} failed${out.aborted ? ' (stopped: API key rejected)' : ''}.`);
  }
  return out;
}

const runManualReview = (input, write) => runReview('manual', input, write);
const runAutoReview = (input, write) => runReview('auto', input, write);

module.exports = {
  collectCandidates, runManualReview, runAutoReview, formatCandidate, formatResult, formatFailure,
  MAX_CANDIDATES_PER_BATCH,
  _tracker: tracker, _inFlight: inFlight
};
