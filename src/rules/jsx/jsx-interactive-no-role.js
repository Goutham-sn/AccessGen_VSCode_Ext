const { walkJSX } = require('../../parsers/jsxParser');
const { isHiddenJsx, hasJsxSpread } = require('../shared/visibility');

const isDomElement = (node) => node.name && node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name);
const KEY_HANDLERS = ['onKeyDown', 'onKeyUp', 'onKeyPress'];
const roleOf = (node) => { const r = (node.attributes || []).find(a => a.type === 'JSXAttribute' && a.name && a.name.name === 'role'); return r && r.value && r.value.type === 'StringLiteral' ? r.value.value.trim().toLowerCase() : null; };

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
}

function hasJSXAttr(node, name) {
  if (!node.attributes) return false;
  return node.attributes.some(
    a => a.type === 'JSXAttribute' && a.name && a.name.name === name
  );
}

const NON_SEMANTIC_TAGS = ['div', 'span', 'li', 'td', 'section'];

module.exports = {
  id: 'jsx-interactive-no-role',
  language: 'jsx',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 4.1.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;

      const name = getElementName(node);
      if (!NON_SEMANTIC_TAGS.includes(name.toLowerCase())) return;

      // Without a keyboard handler jsx-onclick-no-keyboard already reports this element (one issue per element, not two):
      // this rule is for elements that already work with the keyboard but are not announced as interactive.
      if (!KEY_HANDLERS.some(h => hasJSXAttr(node, h))) return;
      if (!isDomElement(node) || isHiddenJsx(node) || hasJsxSpread(node)) return;

      if (hasJSXAttr(node, 'role')) return;

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-interactive-no-role',
        severity: 'warning',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: 'This interactive element has no ARIA role.',
          why: 'Screen readers announce elements by their role. A div with a click handler is announced as nothing — it is completely invisible to screen reader users as an interactive element.',
          fix: "Add role='button' for clickable actions, role='link' for navigation, or role='menuitem' for menu items. Include tabIndex={0} so keyboard users can reach it.",
          wcag: 'WCAG 2.1 - 4.1.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
