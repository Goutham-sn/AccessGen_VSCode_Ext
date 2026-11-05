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

    return applySuppressions(sourceCode, violations);
  } catch (e) {
    console.error('AccessGen: Analysis failed:', e.message);
    return [];
  }
}

// Inline suppression comments, in any comment syntax of the file (<!-- -->, {/* */}, /* */, //):
//   accessgen-disable-file [rule ...]       anywhere in the first 10 lines: the whole file
//   accessgen-disable-next-line [rule ...]  the line after the comment
//   accessgen-disable-line [rule ...]       the comment's own line
// With no rule ids every rule is suppressed; ids are separated by spaces or commas.
const SUPPRESS = /accessgen-disable-(file|next-line|line)\b([^\n]*)/g;

function suppressedRules(tail) {
  const ids = (tail.replace(/(-->|\*\/|\}).*$/, '').match(/[a-z][a-z0-9-]*/g) || []).filter(id => id.includes('-'));
  return ids.length ? new Set(ids) : null; // null = all rules
}

function applySuppressions(sourceCode, violations) {
  if (!violations.length || !sourceCode.includes('accessgen-disable')) return violations;
  const lines = sourceCode.split(/\r\n|\r|\n/);
  const byLine = new Map(); // line -> Set | null (all)
  let fileRules;            // undefined = none, null = all, Set = those rules
  const add = (line, rules) => {
    if (byLine.has(line) && byLine.get(line) === null) return;
    if (rules === null) { byLine.set(line, null); return; }
    const prev = byLine.get(line);
    byLine.set(line, prev ? new Set([...prev, ...rules]) : rules);
  };
  lines.forEach((text, i) => {
    SUPPRESS.lastIndex = 0;
    let m;
    while ((m = SUPPRESS.exec(text))) {
      const rules = suppressedRules(m[2]);
      if (m[1] === 'file' && i < 10) fileRules = rules === null ? null : new Set([...(fileRules || []), ...rules]);
      else if (m[1] === 'next-line') add(i + 1, rules);
      else if (m[1] === 'line') add(i, rules);
    }
  });
  const hit = (rules, id) => rules === null || (rules && rules.has(id));
  return violations.filter(v => !(fileRules !== undefined && hit(fileRules, v.ruleId)) && !(byLine.has(v.startLine) && hit(byLine.get(v.startLine), v.ruleId)));
}

function getRuleById(ruleId) {
  const all = [...getHtmlRules(), ...getJsxRules(), ...getCssRules()];
  return all.find(r => r.id === ruleId) || null;
}

function allRules() {
  return [...getHtmlRules(), ...getJsxRules(), ...getCssRules()];
}

module.exports = { analyzeDocument, getRuleById, shouldRunAtLevel, applySuppressions, allRules };
