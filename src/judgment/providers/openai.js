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
const { parseJudgment, parseSuggestion, parseGenericSuggestion, throwForStatus, extractObject, MAX_OUTPUT_TOKENS, MAX_GENERIC_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, REMEDIATION_TIMEOUT_MS, REMEDIATION_MAX_BYTES } = require('./contract');
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

// Batch remediation (see anthropic.js for the request shape). Strict structured output (json_schema) when the model
// supports it, JSON mode otherwise; images as data URLs. Reasoning models (o-series, gpt-5) take no temperature.
async function remediate({ request, apiKey, model, postJson }) {
  const content = [
    { type: 'text', text: request.text },
    ...request.images.map(img => ({ type: 'image_url', image_url: { url: 'data:' + img.mediaType + ';base64,' + img.data, detail: 'high' } }))
  ];
  const body = {
    model,
    max_completion_tokens: request.maxTokens,
    response_format: { type: 'json_schema', json_schema: { name: 'accessgen_remediation', strict: true, schema: request.schema } },
    messages: [{ role: 'system', content: request.system }, { role: 'user', content }]
  };
  if (!/^(o\d|gpt-5)/i.test(model)) body.temperature = 0;
  const send = (b) => postJson(ENDPOINT, { Authorization: `Bearer ${apiKey}` }, b, { timeoutMs: REMEDIATION_TIMEOUT_MS, maxBytes: REMEDIATION_MAX_BYTES });
  let res = await send(body);
  if (res.status === 400 && /response_format|json_schema/i.test(res.text || '')) res = await send({ ...body, response_format: { type: 'json_object' } });
  throwForStatus(res, apiKey);
  const choice = res.json && res.json.choices && res.json.choices[0];
  const message = choice && choice.message;
  if (message && message.refusal) throw new AiError('BAD_RESPONSE', 'The AI provider declined this request.');
  if (choice && choice.finish_reason === 'length') throw new AiError('TRUNCATED', 'The AI reply was cut off at the output limit.');
  return extractObject(message && message.content);
}

module.exports = { NAME, DEFAULT_MODEL, REMEDIATION_MODEL: 'gpt-4.1', ENDPOINT, judge, generate, generateGeneric, remediate };
