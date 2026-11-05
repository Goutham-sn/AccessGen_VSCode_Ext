// The output contract shared by every provider, plus the helpers that enforce it.
//
//   { verdict: 'pass' | 'fail' | 'uncertain', confidence: 0.20..0.98, reasoning: string }
//
// The confidence range matches the Python engine's _compute_contrast_confidence.

const { AiError } = require('./errors');

const VERDICTS = ['pass', 'fail', 'uncertain'];
const MIN_CONFIDENCE = 0.20;
const MAX_CONFIDENCE = 0.98;
const MAX_REASONING_CHARS = 500;
const MAX_SUGGESTION_CHARS = 200;
// A generic fix replaces a whole flagged range of markup/CSS, so it is far longer than a piece of alt text.
const MAX_GENERIC_CHARS = 2000;
// The model only sees the heading text, never the section it introduces, so it is not
// allowed to be very sure. Enforced here as well as asked for in the prompt.
const KIND_CONFIDENCE_CEILING = { 'heading-text': 0.75 };

// Shared request limits.
const MAX_OUTPUT_TOKENS = 300;
const MAX_GENERIC_OUTPUT_TOKENS = 900;
const REQUEST_TIMEOUT_MS = 30000;

// Pulls the first JSON object out of a model reply (tolerates code fences and stray prose).
// Throws AiError('BAD_RESPONSE') when there isn't a usable object.
function extractObject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AiError('BAD_RESPONSE', 'The AI provider returned an empty response.');
  }
  let text = raw.trim();
  // A well-formed reply is parsed as it is: a code fence INSIDE a string value (a generic fix can contain one) must not be mistaken for the reply's own.
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole;
  } catch (e) { /* fall through to the tolerant extraction */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) {
    throw new AiError('BAD_RESPONSE', 'The AI provider did not return JSON.');
  }
  let obj;
  try {
    obj = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    throw new AiError('BAD_RESPONSE', 'The AI provider returned malformed JSON.');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AiError('BAD_RESPONSE', 'The AI provider returned JSON of the wrong shape.');
  }
  return obj;
}

// Same range for judgments and suggestions: 0.20-0.98 (the Python engine's contrast-confidence range).
function normalizeConfidence(value, ceiling) {
  let confidence = typeof value === 'string' ? Number(value) : value;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new AiError('BAD_RESPONSE', 'The AI response had no valid confidence.');
  }
  if (confidence > 1 && confidence <= 100) confidence /= 100; // "85" meant 85%
  const cap = Math.min(MAX_CONFIDENCE, ceiling || MAX_CONFIDENCE);
  return Math.round(Math.min(Math.max(confidence, MIN_CONFIDENCE), cap) * 100) / 100;
}

function normalizeReasoning(value) {
  const reasoning = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!reasoning) {
    throw new AiError('BAD_RESPONSE', 'The AI response had no reasoning.');
  }
  return reasoning.slice(0, MAX_REASONING_CHARS);
}

// Validates a judgment against the contract:
//   { verdict: 'pass' | 'fail' | 'uncertain', confidence: 0.20..0.98, reasoning: string }
function parseJudgment(raw, kind) {
  const obj = extractObject(raw);

  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  if (!VERDICTS.includes(verdict)) {
    throw new AiError('BAD_RESPONSE', 'The AI response had no valid verdict.');
  }

  return {
    verdict,
    confidence: normalizeConfidence(obj.confidence, KIND_CONFIDENCE_CEILING[kind]),
    reasoning: normalizeReasoning(obj.reasoning)
  };
}

// Validates a generated fix against its contract:
//   { suggestedText: string, confidence: 0.20..0.98, reasoning: string }
// suggestedText may be "" - that is the model saying it has nothing to go on (see the fix prompts), and
// the caller must treat it as "no suggestion", not as an error. Wrapping quotes and line breaks are
// removed; text over MAX_SUGGESTION_CHARS is cut at a word boundary.
function parseSuggestion(raw) {
  const obj = extractObject(raw);

  if (typeof obj.suggestedText !== 'string') {
    throw new AiError('BAD_RESPONSE', 'The AI response had no suggested text.');
  }
  let text = obj.suggestedText.replace(/\s+/g, ' ').trim().replace(/^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d]+$/g, '').trim();
  if (text.length > MAX_SUGGESTION_CHARS) text = text.slice(0, MAX_SUGGESTION_CHARS).replace(/\s+\S*$/, '').trim();

  return {
    suggestedText: text,
    confidence: normalizeConfidence(obj.confidence),
    reasoning: normalizeReasoning(obj.reasoning)
  };
}

// Validates a generic (any-rule) fix:  { suggestedText: string, confidence: 0.20..0.98, reasoning: string }
// Unlike parseSuggestion the text is CODE, so quotes, indentation and line breaks are kept exactly. Only a wrapping
// code fence is removed. "" means the model had nothing safe to propose. A reply longer than MAX_GENERIC_CHARS is
// rejected as a bad response rather than silently cut (a truncated replacement would corrupt the file).
function parseGenericSuggestion(raw) {
  const obj = extractObject(raw);
  if (typeof obj.suggestedText !== 'string') {
    throw new AiError('BAD_RESPONSE', 'The AI response had no suggested text.');
  }
  let text = obj.suggestedText;
  const fenced = text.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1];
  if (!text.trim()) text = '';
  if (text.length > MAX_GENERIC_CHARS) {
    throw new AiError('BAD_RESPONSE', 'The AI suggestion was too long to apply safely.');
  }
  return {
    suggestedText: text,
    confidence: normalizeConfidence(obj.confidence),
    reasoning: normalizeReasoning(obj.reasoning)
  };
}

// Removes the key (and anything shaped like a provider key) from text that may be shown.
function redact(text, apiKey) {
  let out = String(text == null ? '' : text);
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(/\b(sk|key)-[A-Za-z0-9_-]{6,}/g, '[redacted]');
}

// Maps a non-2xx HTTP response to a typed error. Provider error bodies are NOT echoed for
// auth failures (OpenAI quotes part of the key back); other bodies are redacted and trimmed.
function throwForStatus(res, apiKey) {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 401 || res.status === 403) {
    throw new AiError('AUTH', 'The AI provider rejected the API key. Run "AccessGen: Set AI API Key" to update it.', { status: res.status });
  }
  if (res.status === 429) {
    throw new AiError('RATE_LIMIT', 'The AI provider rate-limited the request. It will be retried on the next review.', { status: res.status });
  }
  const detail = res.json && res.json.error && typeof res.json.error.message === 'string' ? res.json.error.message : '';
  const suffix = detail ? `: ${redact(detail, apiKey).slice(0, 200)}` : '';
  throw new AiError('HTTP_ERROR', `The AI provider returned HTTP ${res.status}${suffix}`, { status: res.status });
}

module.exports = {
  VERDICTS, MIN_CONFIDENCE, MAX_CONFIDENCE, MAX_REASONING_CHARS, KIND_CONFIDENCE_CEILING,
  MAX_OUTPUT_TOKENS, MAX_GENERIC_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS,
  MAX_SUGGESTION_CHARS, MAX_GENERIC_CHARS,
  parseJudgment, parseSuggestion, parseGenericSuggestion, redact, throwForStatus
};
