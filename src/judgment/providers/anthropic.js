// Anthropic Messages API provider. Same output contracts as the OpenAI provider.
//
// DEFAULT_MODEL is a small, cost-efficient model chosen as a default only: change it here, or
// with the accessgen.aiModel setting. The Messages API has no JSON mode, so the strict-JSON
// instruction lives in the prompt and the reply is validated against the shared contract.
//
// Two operations share one request path: judge() (is this text acceptable?) and generate()
// (write the missing text). Only the prompt and the validation differ.

const { buildPrompt, buildFixPrompt, buildGenericFixPrompt } = require('../prompts');
const { parseJudgment, parseSuggestion, parseGenericSuggestion, throwForStatus, extractObject, MAX_OUTPUT_TOKENS, MAX_GENERIC_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, REMEDIATION_TIMEOUT_MS, REMEDIATION_MAX_BYTES } = require('./contract');
const { AiError } = require('./errors');

const NAME = 'anthropic';
const DEFAULT_MODEL = 'claude-haiku-5-5';
// Batch remediation writes code for many issues at once and benefits most from the strongest model.
const REMEDIATION_MODEL = 'claude-opus-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Current-generation models: accept output_config.effort, and reject non-default sampling parameters (so no
// temperature is sent to any model). Server-side refusal fallback exists for the Opus 5 / Sonnet 5.5 / Fable 5 lines.
const supportsEffort = (model) => /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model);
const supportsFallback = (model) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

// Sends one system+user prompt and returns the model's text blocks joined.
async function requestText({ system, user, apiKey, model, postJson, maxTokens }) {
  const res = await postJson(ENDPOINT, { 'x-api-key': apiKey, 'anthropic-version': API_VERSION }, {
    model,
    max_tokens: maxTokens || MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: 'user', content: user }]
  }, { timeoutMs: REQUEST_TIMEOUT_MS });

  throwForStatus(res, apiKey);

  const blocks = res.json && Array.isArray(res.json.content) ? res.json.content : [];
  if (res.json && res.json.stop_reason === 'refusal') {
    throw new AiError('BAD_RESPONSE', 'The AI provider declined to judge this content.');
  }
  return blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

async function judge({ candidate, apiKey, model, postJson }) {
  const { system, user } = buildPrompt(candidate);
  return parseJudgment(await requestText({ system, user, apiKey, model, postJson }), candidate.kind);
}

async function generate({ candidate, apiKey, model, postJson }) {
  const { system, user } = buildFixPrompt(candidate);
  return parseSuggestion(await requestText({ system, user, apiKey, model, postJson }));
}

// Generic fix: `request` is what rules/shared/genericContext.buildGenericRequest produced.
async function generateGeneric({ request, apiKey, model, postJson }) {
  const { system, user } = buildGenericFixPrompt(request);
  return parseGenericSuggestion(await requestText({ system, user, apiKey, model, postJson, maxTokens: MAX_GENERIC_OUTPUT_TOKENS }));
}

// Batch remediation. request = { system, text, images: [{ mediaType, data }], schema, maxTokens } (remediation/batch/prompt.js).
// The reply is constrained with structured outputs (output_config.format); a model that does not support it gets the
// same request without the format and the JSON instruction in the prompt does the work. -> the parsed object.
async function remediate({ request, apiKey, model, postJson }) {
  const content = [
    ...request.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text: request.text }
  ];
  const headers = { 'x-api-key': apiKey, 'anthropic-version': API_VERSION };
  const body = {
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: request.schema } }
  };
  if (supportsEffort(model)) body.output_config.effort = 'high';
  if (supportsFallback(model)) { headers['anthropic-beta'] = FALLBACK_BETA; body.fallbacks = 'default'; }

  const send = (b) => postJson(ENDPOINT, headers, b, { timeoutMs: REMEDIATION_TIMEOUT_MS, maxBytes: REMEDIATION_MAX_BYTES });
  let res = await send(body);
  if (res.status === 400 && /output_config|format|json_schema|effort/i.test(res.text || '')) {
    const { output_config, ...rest } = body; // an older model: same request without structured output / effort
    res = await send(rest);
  }
  throwForStatus(res, apiKey);
  const json = res.json || {};
  if (json.stop_reason === 'refusal') throw new AiError('BAD_RESPONSE', 'The AI provider declined this request.');
  if (json.stop_reason === 'max_tokens') throw new AiError('TRUNCATED', 'The AI reply was cut off at the output limit.');
  const text = (Array.isArray(json.content) ? json.content : []).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  return extractObject(text);
}

module.exports = { NAME, DEFAULT_MODEL, REMEDIATION_MODEL, ENDPOINT, API_VERSION, judge, generate, generateGeneric, remediate };
