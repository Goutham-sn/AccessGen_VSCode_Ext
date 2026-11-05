const { walkJSX } = require('../../parsers/jsxParser');

// Literal positive integer only: tabIndex="3", tabIndex={3}, tabIndex={"3"}.
// Dynamic expressions (tabIndex={computed}) and negatives (-1, a UnaryExpression) are skipped.
function getPositiveTabIndex(attr) {
  const v = attr.value;
  if (!v) return null;
  let literal = v;
  if (v.type === 'JSXExpressionContainer') literal = v.expression;
  if (!literal) return null;
  if (literal.type === 'NumericLiteral') {
    return Number.isInteger(literal.value) && literal.value > 0 ? literal.value : null;
  }
  if (literal.type === 'StringLiteral' && /^\s*\+?\d+\s*$/.test(literal.value)) {
    const n = parseInt(literal.value, 10);
    return n > 0 ? n : null;
  }
  return null;
}

module.exports = {
  id: 'jsx-tabindex-positive',
  language: 'jsx',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 2.4.3 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;
      if (!node.attributes) return;

      const attr = node.attributes.find(
        a => a.type === 'JSXAttribute' && a.name && a.name.name === 'tabIndex'
      );
      if (!attr) return;
      if (getPositiveTabIndex(attr) === null) return;

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-tabindex-positive',
        severity: 'warning',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: 'A positive tabIndex value is used on this element.',
          why: 'Positive tabIndex values override the natural tab order of the page, creating a confusing keyboard navigation experience that jumps around the page unpredictably.',
          fix: "Remove the tabIndex prop to use natural document order, or use tabIndex={0} to make an element focusable without disrupting tab order.",
          wcag: 'WCAG 2.1 - 2.4.3 (Level A)'
        }
      });
    });

    return violations;
  }
};
