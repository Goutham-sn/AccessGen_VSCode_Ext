const { walkJSX } = require('../../parsers/jsxParser');
const { isHiddenJsx, hasJsxSpread } = require('../shared/visibility');

const isDomElement = (node) => node.name && node.name.type === 'JSXIdentifier' && /^[a-z]/.test(node.name.name);
const KEY_HANDLERS = ['onKeyDown', 'onKeyUp', 'onKeyPress'];
const roleOf = (node) => { const r = (node.attributes || []).find(a => a.type === 'JSXAttribute' && a.name && a.name.name === 'role'); return r && r.value && r.value.type === 'StringLiteral' ? r.value.value.trim().toLowerCase() : null; };

function hasJSXAttr(node, name) {
  if (!node.attributes) return false;
  return node.attributes.some(
    a => a.type === 'JSXAttribute' && a.name && a.name.name === name
  );
}

module.exports = {
  id: 'jsx-mouse-events-no-focus',
  language: 'jsx',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 2.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;
      if (!node.loc) return;
      if (!isDomElement(node) || isHiddenJsx(node) || hasJsxSpread(node)) return;

      const hasMouseOver = hasJSXAttr(node, 'onMouseOver');
      const hasFocus = hasJSXAttr(node, 'onFocus');
      const hasMouseOut = hasJSXAttr(node, 'onMouseOut');
      const hasBlur = hasJSXAttr(node, 'onBlur');

      if (hasMouseOver && !hasFocus) {
        violations.push({
          ruleId: 'jsx-mouse-events-no-focus',
          severity: 'warning',
          startLine: node.loc.start.line - 1,
          endLine: node.loc.end.line - 1,
          startChar: node.loc.start.column,
          endChar: node.loc.end.column,
          message: {
            what: 'Mouse event has no keyboard/focus equivalent.',
            why: 'Users who navigate by keyboard or switch access cannot trigger mouse events. Tooltips, dropdowns, or interactions that only respond to mouse hover are completely inaccessible.',
            fix: 'Add onFocus alongside onMouseOver and onBlur alongside onMouseOut so the same behavior works for keyboard users.',
            wcag: 'WCAG 2.1 - 2.1.1 (Level A)'
          }
        });
        return;
      }

      if (hasMouseOut && !hasBlur) {
        violations.push({
          ruleId: 'jsx-mouse-events-no-focus',
          severity: 'warning',
          startLine: node.loc.start.line - 1,
          endLine: node.loc.end.line - 1,
          startChar: node.loc.start.column,
          endChar: node.loc.end.column,
          message: {
            what: 'Mouse event has no keyboard/focus equivalent.',
            why: 'Users who navigate by keyboard or switch access cannot trigger mouse events. Tooltips, dropdowns, or interactions that only respond to mouse hover are completely inaccessible.',
            fix: 'Add onFocus alongside onMouseOver and onBlur alongside onMouseOut so the same behavior works for keyboard users.',
            wcag: 'WCAG 2.1 - 2.1.1 (Level A)'
          }
        });
      }
    });

    return violations;
  }
};
