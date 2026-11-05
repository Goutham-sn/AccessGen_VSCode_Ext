// Anthropic Messages API provider. Same output contracts as the OpenAI provider.
//
// DEFAULT_MODEL is a small, cost-efficient model chosen as a default only: change it here, or
// with the accessgen.aiModel setting. The Messages API has no JSON mode, so the strict-JSON
// instruction lives in the prompt and the reply is validated against the shared contract.
//
// Two operations share one request path: judge() (is this text acceptable?) and generate()
// (write the missing text). Only the prompt and the validation differ.

const { buildPrompt, buildFixPrompt, buildGenericFixPrompt } = require('../prompts');
const { parseJudgment, parseSuggestion, parseGenericSuggestion, throwForStatus, MAX_OUTPUT_TOKENS, MAX_GENERIC_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } = require('./contract');
const { AiError } = require('./errors');

const NAME = 'anthropic';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Sends one system+user prompt and returns the model's text blocks joined.
async function requestText({ system, user, apiKey, model, postJson, maxTokens }) {
  const res = await postJson(ENDPOINT, { 'x-api-key': apiKey, 'anthropic-version': API_VERSION }, {
    model,
    max_tokens: maxTokens || MAX_OUTPUT_TOKENS,
    temperature: 0,
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

module.exports = { NAME, DEFAULT_MODEL, ENDPOINT, API_VERSION, judge, generate, generateGeneric };
