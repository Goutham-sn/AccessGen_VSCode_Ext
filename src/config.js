const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let cachedConfig = null;

const AI_REVIEW_MODES = ['off', 'manual', 'auto'];
const AI_PROVIDERS = ['openai', 'anthropic'];
const REMEDIATION_MODES = ['manual', 'hybrid', 'auto'];

function validAiProvider(value) {
  return AI_PROVIDERS.includes(value) ? value : null;
}

// Same rule as the AI mode: only a recognised value counts, so a typo can never enable auto-apply.
function validRemediationMode(value) {
  return REMEDIATION_MODES.includes(value) ? value : null;
}

// How AI fixes are requested: 'batch' (all issues of a file in one request) or 'per-issue'.
function validStrategy(value) {
  return value === 'batch' || value === 'per-issue' ? value : null;
}

// A delay in milliseconds: a finite number >= 0, otherwise the default.
function validDelay(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// A model id is free text; blank means "use the provider's default".
function cleanModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Only a recognised mode counts; anything else is ignored so a typo can never turn AI review on.
function validAiReviewMode(value) {
  return AI_REVIEW_MODES.includes(value) ? value : null;
}

function loadConfig() {
  const wsConfig = vscode.workspace.getConfiguration('accessgen');

  let fileConfig = null;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const configPath = path.join(folders[0].uri.fsPath, 'accessgen.config.json');
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(raw);
      }
    } catch (e) {
      console.error('AccessGen: Failed to read config file:', e.message);
    }
  }

  cachedConfig = {
    complianceLevel: (fileConfig && fileConfig.complianceLevel) || wsConfig.get('complianceLevel', 'AA'),
    trustedComponents: (fileConfig && fileConfig.trustedComponents) || wsConfig.get('trustedComponents', []),
    remediationMode: validRemediationMode(fileConfig && fileConfig.remediationMode) ||
      validRemediationMode(wsConfig.get('remediationMode', 'manual')) || 'manual',
    aiReviewMode: validAiReviewMode(fileConfig && fileConfig.aiReviewMode) ||
      validAiReviewMode(wsConfig.get('aiReviewMode', 'off')) || 'off',
    aiProvider: validAiProvider(fileConfig && fileConfig.aiProvider) ||
      validAiProvider(wsConfig.get('aiProvider', 'openai')) || 'openai',
    aiModel: cleanModel(fileConfig && fileConfig.aiModel) || cleanModel(wsConfig.get('aiModel', '')) || '',
    aiRemediationModel: cleanModel(fileConfig && fileConfig.aiRemediationModel) || cleanModel(wsConfig.get('aiRemediationModel', '')) || '',
    aiRemediationStrategy: validStrategy(fileConfig && fileConfig.aiRemediationStrategy) || validStrategy(wsConfig.get('aiRemediationStrategy', 'batch')) || 'batch',
    aiSendImages: typeof (fileConfig && fileConfig.aiSendImages) === 'boolean' ? fileConfig.aiSendImages : wsConfig.get('aiSendImages', true) !== false,
    disabledRules: (fileConfig && fileConfig.disabledRules) || [],
    languages: (fileConfig && fileConfig.languages) || ['html', 'jsx', 'tsx', 'css'],
    enabled: wsConfig.get('enabled', true),
    showTooltips: wsConfig.get('showTooltips', true),
    debounceMs: wsConfig.get('debounceMs', 800),
    aiReviewDebounceMs: validDelay(wsConfig.get('aiReviewDebounceMs', 3000), 3000),
    stateScope: wsConfig.get('stateScope', 'global')
  };

  return cachedConfig;
}

function getConfig() {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

function reloadConfig() {
  cachedConfig = null;
  return loadConfig();
}

function isTrustedComponent(name) {
  const config = getConfig();
  return config.trustedComponents.includes(name);
}

function isRuleDisabled(ruleId) {
  const config = getConfig();
  return config.disabledRules.includes(ruleId);
}

module.exports = {
  getConfig,
  reloadConfig,
  loadConfig,
  isTrustedComponent,
  isRuleDisabled
};
