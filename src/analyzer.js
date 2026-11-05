const { parseHTML, walkNode } = require('./parsers/htmlParser');
const { parseJSX, walkJSX } = require('./parsers/jsxParser');
const { parseCSS, walkCSS } = require('./parsers/cssParser');
const path = require('path');
const fs = require('fs');

const htmlRuleFiles = [
  'img-alt-missing', 'input-label-missing', 'button-empty',
  'anchor-no-text', 'heading-hierarchy-skip', 'div-used-as-button',
  'form-missing-landmark', 'select-no-label', 'table-missing-headers',
  'iframe-missing-title', 'html-missing-lang', 'duplicate-id',
  'positive-tabindex', 'autofocus-used', 'media-missing-captions',
  'heading-empty'
];

const jsxRuleFiles = [
  'jsx-img-alt-missing', 'jsx-onclick-no-keyboard', 'jsx-interactive-no-role',
  'jsx-anchor-no-content', 'jsx-label-missing', 'jsx-aria-invalid-role',
  'jsx-mouse-events-no-focus', 'jsx-heading-empty',
  'jsx-tabindex-positive', 'jsx-autofocus-used'
];

const cssRuleFiles = [
  'outline-removed', 'color-contrast-low',
  'motion-no-preference-check', 'focus-visible-missing'
];

let htmlRules = null;
let jsxRules = null;
let cssRules = null;

function loadRules(fileNames, subdir) {
  return fileNames.map(name => {
    try {
      return require(path.join(__dirname, 'rules', subdir, name));
    } catch (e) {
      console.error(`AccessGen: Failed to load rule ${subdir}/${name}:`, e.message);
      return null;
    }
  }).filter(Boolean);
}

function getHtmlRules() {
  if (!htmlRules) htmlRules = loadRules(htmlRuleFiles, 'html');
  return htmlRules;
}

function getJsxRules() {
  if (!jsxRules) jsxRules = loadRules(jsxRuleFiles, 'jsx');
  return jsxRules;
}

function getCssRules() {
  if (!cssRules) cssRules = loadRules(cssRuleFiles, 'css');
  return cssRules;
}

function getWcagLevel(wcagStr) {
  const match = wcagStr.match(/Level\s+(A{1,3})/);
  return match ? match[1] : 'A';
}

function shouldRunAtLevel(ruleWcag, complianceLevel) {
  const ruleLevel = getWcagLevel(ruleWcag);
  if (complianceLevel === 'A') return ruleLevel === 'A';
  if (complianceLevel === 'AA') return ruleLevel === 'A' || ruleLevel === 'AA';
  return true;
}

const MAX_FILE_SIZE = 500 * 1024;

async function analyzeDocument(document, config) {
  try {
    const sourceCode = document.getText();

    if (sourceCode.length > MAX_FILE_SIZE) {
      return [];
    }

    const languageId = document.languageId;
    let ast = null;
    let rules = [];

    switch (languageId) {
      case 'html':
        ast = parseHTML(sourceCode);
        rules = getHtmlRules();
        break;
      case 'javascriptreact':
      case 'typescriptreact':
        ast = parseJSX(sourceCode);
        rules = getJsxRules();
        break;
      case 'css':
        ast = parseCSS(sourceCode);
        rules = getCssRules();
        break;
      default:
        return [];
    }

    if (!ast) return [];

    const complianceLevel = config.complianceLevel || 'AA';
    const violations = [];

    for (const rule of rules) {
      try {
        if (config.isRuleDisabled && config.isRuleDisabled(rule.id)) continue;

        if (!shouldRunAtLevel(rule.wcag, complianceLevel)) continue;

        const ruleViolations = rule.check(ast, sourceCode, config);
        if (Array.isArray(ruleViolations)) {
          violations.push(...ruleViolations);
        }
      } catch (e) {
        console.error(`AccessGen: Rule ${rule.id} threw an error:`, e.message);
      }
    }

    return violations;
  } catch (e) {
    console.error('AccessGen: Analysis failed:', e.message);
    return [];
  }
}

function getRuleById(ruleId) {
  const all = [...getHtmlRules(), ...getJsxRules(), ...getCssRules()];
  return all.find(r => r.id === ruleId) || null;
}

module.exports = { analyzeDocument, getRuleById, shouldRunAtLevel };
