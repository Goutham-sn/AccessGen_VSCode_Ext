// Provider-agnostic entry point for the AI judgment call.
//
//   judgeContent(candidate, config) -> Promise<{ verdict, confidence, reasoning }>
//   generateFix(candidate, config)  -> Promise<{ suggestedText, confidence, reasoning }>
//   generateGenericFix(violation, sourceCode, config) -> Promise<{ suggestedText, confidence, reasoning }>
//                                      a replacement for the violation's flagged range, for ANY rule
//
// Both go through the same key / model / transport resolution, so a provider switch, the SecretStorage key
// and the accessgen.aiModel setting apply to both. generateFix is only ever reached from an explicit user
// action (selecting an AI quick fix); nothing here decides whether a send is allowed - callers apply the
// consent gate first.
//
// config fields used:
//   aiProvider  'openai' (default) | 'anthropic'
//   aiModel     optional; the provider's DEFAULT_MODEL when unset/blank
//   secrets     a vscode.SecretStorage-like { get(key) } - the ONLY place API keys are read from
//   postJson    optional transport override (tests); defaults to the built-in https client
//
// Failures reject with a typed AiError (see errors.js); they are never turned into a fake
// "uncertain" verdict, so the caller can tell "the model was unsure" from "the call failed"
// and retry the latter.

const openai = require('./openai');
const anthropic = require('./anthropic');
const http = require('./http');
const { AiError } = require('./errors');

const PROVIDERS = { [openai.NAME]: openai, [anthropic.NAME]: anthropic };
const DEFAULT_PROVIDER = openai.NAME;

// Provider-scoped SecretStorage key. Switching providers never reuses another provider's key.
function secretKeyFor(provider) {
  return `accessgen.apiKey.${provider}`;
}

function providerName(config) {
  return (config && config.aiProvider) || DEFAULT_PROVIDER;
}

function resolveModel(config) {
  const provider = PROVIDERS[providerName(config)];
  const configured = config && typeof config.aiModel === 'string' ? config.aiModel.trim() : '';
  return configured || (provider ? provider.DEFAULT_MODEL : '');
}

async function getApiKey(config) {
  const secrets = config && config.secrets;
  if (!secrets || typeof secrets.get !== 'function') return '';
  try {
    const value = await secrets.get(secretKeyFor(providerName(config)));
    return typeof value === 'string' ? value.trim() : '';
  } catch (e) {
    return '';
  }
}

// Everything a request needs, or a typed error. Shared by judgeContent and generateFix.
async function resolveRequest(config) {
  const name = providerName(config);
  const provider = PROVIDERS[name];
  if (!provider) throw new AiError('UNKNOWN_PROVIDER', `Unknown AI provider "${name}".`);

  const apiKey = await getApiKey(config);
  if (!apiKey) {
    throw new AiError('NO_API_KEY', `No API key is set for ${name}. Run "AccessGen: Set AI API Key" (accessgen.setAiApiKey).`);
  }

  // Looked up on the module at call time so tests can replace http.postJson.
  const postJson = (config && config.postJson) || http.postJson;
  return { provider, apiKey, model: resolveModel(config), postJson };
}

async function judgeContent(candidate, config) {
  const { provider, apiKey, model, postJson } = await resolveRequest(config);
  return provider.judge({ candidate, apiKey, model, postJson });
}

async function generateFix(candidate, config) {
  const { provider, apiKey, model, postJson } = await resolveRequest(config);
  return provider.generate({ candidate, apiKey, model, postJson });
}

// A fix for ANY rule: the model sees the rule's own message, the WCAG criterion, the flagged code and a context window
// (see rules/shared/genericContext.js) and proposes a replacement for only the flagged range. Same key / model /
// transport plumbing as generateFix; like it, only reached after the caller's consent gate.
async function generateGenericFix(violation, sourceCode, config) {
  // Lazy: the analyzer loads every rule, and nothing else in this module needs it.
  const { getRuleById } = require('../../analyzer');
  const { buildGenericRequest } = require('../../rules/shared/genericContext');
  const rule = getRuleById(violation && violation.ruleId);
  if (!rule) throw new AiError('BAD_REQUEST', 'Unknown rule "' + (violation && violation.ruleId) + '".');
  const request = buildGenericRequest(violation, sourceCode, rule.language);
  if (request.tooLarge) throw new AiError('BAD_REQUEST', 'The flagged range is too large to send for a generic fix.');
  const { provider, apiKey, model, postJson } = await resolveRequest(config);
  return provider.generateGeneric({ request, apiKey, model, postJson });
}

module.exports = { judgeContent, generateFix, generateGenericFix, getApiKey, secretKeyFor, resolveModel, providerName, PROVIDERS, DEFAULT_PROVIDER };
