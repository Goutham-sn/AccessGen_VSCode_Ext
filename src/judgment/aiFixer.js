// Runs an AI-suggested fix: asks the rule's async fix() for an edit, supplying it with a gated, cached,
// de-duplicated way to call the provider. vscode-free: extension.js / codeActions.js turn the result
// into messages and a WorkspaceEdit.
//
// resolve({ rule, violation, sourceCode, filePath, config, gates }) never rejects. It resolves one of:
//   { status: 'ok',             newText, range, suggestion, cached }
//   { status: 'no-key',         provider }          no API key stored; nothing was sent
//   { status: 'declined' }                          the first-send disclosure dialog was cancelled; nothing was sent
//   { status: 'low-confidence', message, suggestion }   the model had too little to go on (or said so)
//   { status: 'unavailable',    message }           nothing sensible can be offered for this element
//   { status: 'error',          code, message }     the provider call failed (network, rate limit, bad reply, ...)
//
// The consent gates are the SAME ones the judgment layer uses, applied at the same point: only when a
// request is actually about to be sent (a cache hit sends nothing, so it asks nothing), key check first,
// then the one-time disclosure dialog. gates = { hasKey(config) -> Promise<bool>, confirm() -> Promise<bool> }.

const providers = require('./providers');
const { createChangeTracker } = require('./changeTracker');

// Below this the suggestion is treated as a guess and no edit is offered. The prompts tell the model to
// answer with an empty text and 0.20 rather than invent a description, so this is the backstop for a model
// that returns something anyway. Tunable.
const AI_FIX_MIN_CONFIDENCE = 0.40;

// Control flow out of services.generate() back to resolve(); not a failure.
class Stop extends Error {
  constructor(status, extra) { super(status); this.stopStatus = status; Object.assign(this, extra || {}); }
}

const oneLine = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 220);

function createAiFixer() {
  const identity = createChangeTracker(); // reused for its slot+hash identity recipe
  const cache = new Map();                // identity -> suggestion (successful calls only)
  const inFlight = new Map();             // identity -> Promise<suggestion>

  async function resolve({ rule, violation, sourceCode, filePath, config, gates }) {
    const g = gates || {};
    const hasKey = g.hasKey || ((cfg) => providers.getApiKey(cfg));
    const confirm = g.confirm || (async () => true);
    const salt = providers.providerName(config) + '/' + providers.resolveModel(config);
    let calls = 0;
    let usedCache = false;

    const services = {
      config, // read-only: lets a fix verify its result with the same rule configuration the scan used
      // candidate = { kind, content, path, context } - exactly what the prompt may be built from.
      async generate(candidate) {
        calls++;
        const key = identity.identity(filePath, {
          ruleId: rule.id,
          content: JSON.stringify([candidate.kind, candidate.content, candidate.context]),
          path: candidate.path || 'unknown'
        }, salt);

        let suggestion = cache.get(key);
        if (suggestion) {
          usedCache = true;
        } else {
          // The whole "gates, then send" sequence is registered as ONE in-flight promise before anything is
          // awaited, so overlapping selections of the same candidate share it: one key check, at most one
          // disclosure dialog, one request. (Registering only after the gates would let every concurrent
          // caller slip past the check and send its own.)
          let pending = inFlight.get(key);
          if (!pending) {
            pending = (async () => {
              // A request is about to be sent: key first, then the one-time disclosure dialog.
              if (!(await hasKey(config))) throw new Stop('no-key', { provider: providers.providerName(config) });
              if (!(await confirm())) throw new Stop('declined');
              // A generic fix (any rule without its own fix()) is generated from the violation itself.
          if (candidate.kind === 'generic-fix') return providers.generateGenericFix(candidate.violation, candidate.sourceCode, config);
          return providers.generateFix(candidate, config);
            })();
            inFlight.set(key, pending);
            const clear = () => { if (inFlight.get(key) === pending) inFlight.delete(key); };
            pending.then(clear, clear);
          }
          suggestion = await pending;
          cache.set(key, suggestion); // failed calls are not cached: the next attempt retries
        }

        if (!suggestion.suggestedText || suggestion.confidence < AI_FIX_MIN_CONFIDENCE) {
          throw new Stop('low-confidence', { suggestion });
        }
        return suggestion;
      }
    };

    try {
      const out = await rule.fix(violation, sourceCode, services);
      if (!out) {
        return { status: 'unavailable', message: 'AccessGen: the code at this location has changed since the last scan, so no AI suggestion was made. Save or edit the file to rescan, then try again.' };
      }
      if (out.unavailable) return { status: 'unavailable', message: 'AccessGen: ' + oneLine(out.unavailable) };
      return { status: 'ok', newText: out.newText, range: out.range, suggestion: out.suggestion, cached: usedCache && calls > 0 };
    } catch (e) {
      if (e instanceof Stop) {
        if (e.stopStatus === 'low-confidence') {
          const why = e.suggestion && e.suggestion.reasoning ? ' (' + oneLine(e.suggestion.reasoning, 160) + ')' : '';
          return {
            status: 'low-confidence', suggestion: e.suggestion,
            message: 'AccessGen: not enough context to suggest ' + (rule.aiFixPhrase || rule.aiFixLabel || 'text') + ' for this element' + why + '. Write it yourself.'
          };
        }
        return { status: e.stopStatus, provider: e.provider };
      }
      if (e && e.name === 'AiError') {
        // AiError messages are written to be safe to show: they never contain the key or the request.
        return { status: 'error', code: e.code, message: 'AccessGen: could not generate an AI suggestion (' + e.code + '): ' + oneLine(e.message, 160) };
      }
      return { status: 'error', code: 'ERROR', message: 'AccessGen: could not generate an AI suggestion (unexpected error).' };
    }
  }

  return { resolve, _cache: cache };
}

module.exports = { createAiFixer, AI_FIX_MIN_CONFIDENCE };
