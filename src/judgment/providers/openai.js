// OpenAI Chat Completions provider.
//
// DEFAULT_MODEL is a cost-efficient model chosen as a default only: change it here, or per
// workspace with the accessgen.aiModel setting.
//
// Output is requested in JSON mode (response_format: json_object) and then validated against
// the shared contract, so a model that ignores the format still produces a typed error instead
// of a wrong result. JSON mode (rather than strict json_schema) is used so any chat model works.
//
// Two operations share one request path: judge() (is this text acceptable?) and generate()
// (write the missing text). Only the prompt and the validation differ.

const { buildPrompt, buildFixPrompt, buildGenericFixPrompt } = require('../prompts');
const { parseJudgment, parseSuggestion, parseGenericSuggestion, throwForStatus, MAX_OUTPUT_TOKENS, MAX_GENERIC_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } = require('./contract');
const { AiError } = require('./errors');

const NAME = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Sends one system+user prompt and returns the model's text (undefined/empty is for the caller's parser to reject).
async function requestText({ system, user, apiKey, model, postJson, maxTokens }) {
  const res = await postJson(ENDPOINT, { Authorization: `Bearer ${apiKey}` }, {
    model,
    temperature: 0,
    max_tokens: maxTokens || MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  }, { timeoutMs: REQUEST_TIMEOUT_MS });

  throwForStatus(res, apiKey);

  const message = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message;
  if (message && message.refusal) {
    throw new AiError('BAD_RESPONSE', 'The AI provider declined to judge this content.');
  }
  return message && message.content;
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

module.exports = { NAME, DEFAULT_MODEL, ENDPOINT, judge, generate, generateGeneric };
