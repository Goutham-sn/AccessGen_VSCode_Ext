const { walkJSX } = require('../../parsers/jsxParser');

// autoFocus is "on" when bare (autoFocus) or autoFocus={true}.
// autoFocus={false} is off; dynamic expressions are out of scope and skipped.
function isAutoFocusOn(attr) {
  if (!attr.value) return true;
  if (attr.value.type === 'JSXExpressionContainer') {
    const e = attr.value.expression;
    return !!e && e.type === 'BooleanLiteral' && e.value === true;
  }
  return false;
}

module.exports = {
  id: 'jsx-autofocus-used',
  language: 'jsx',
  severity: 'advisory',
  wcag: 'WCAG 2.1 - 3.2.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;
      if (!node.attributes) return;

      // <dialog> moves focus on open by design.
      if (node.name && node.name.type === 'JSXIdentifier' && node.name.name === 'dialog') return;

      const attr = node.attributes.find(
        a => a.type === 'JSXAttribute' && a.name && a.name.name === 'autoFocus'
      );
      if (!attr || !isAutoFocusOn(attr)) return;

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-autofocus-used',
        severity: 'advisory',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: 'The autoFocus prop is used on this element.',
          why: 'Auto-focusing an element on page load disorients screen reader users who are not expecting focus to move, and can disrupt users who have already navigated elsewhere on the page.',
          fix: 'Remove autoFocus unless there is a strong user experience reason for it. If needed on a dialog, manage focus programmatically after the dialog opens.',
          wcag: 'WCAG 2.1 - 3.2.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
