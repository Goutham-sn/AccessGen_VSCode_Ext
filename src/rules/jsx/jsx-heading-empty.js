const { walkJSX } = require('../../parsers/jsxParser');
const { getJsxAccessibleName } = require('../shared/jsxAccessibleName');

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
}

function hasTextContent(children) {
  if (!children || !children.length) return false;
  for (const child of children) {
    if (child.type === 'JSXText' && child.value.trim()) return true;
    if (child.type === 'JSXElement') return true;
    if (child.type === 'JSXExpressionContainer' && child.expression &&
        child.expression.type !== 'JSXEmptyExpression') return true;
  }
  return false;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

module.exports = {
  id: 'jsx-heading-empty',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.6 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXElement') return;
      if (!node.openingElement) return;

      const name = getElementName(node.openingElement);
      if (!HEADING_TAGS.includes(name.toLowerCase())) return;

      // aria-label / aria-labelledby only (no content, no title): aria-label="" is absent,
      // a dynamic value is assumed present. Child content is judged by hasTextContent below.
      const ariaName = getJsxAccessibleName(node, ast, { content: false, title: false });
      if (ariaName.name || ariaName.unknown) return;

      if (hasTextContent(node.children)) return;

      const loc = node.openingElement.loc || node.loc;
      if (!loc) return;

      violations.push({
        ruleId: 'jsx-heading-empty',
        severity: 'critical',
        startLine: loc.start.line - 1,
        endLine: loc.end.line - 1,
        startChar: loc.start.column,
        endChar: loc.end.column,
        message: {
          what: 'This heading element is empty.',
          why: 'Screen readers announce headings to help users navigate. An empty heading is announced as a heading with no text — confusing and useless for navigation.',
          fix: "Add visible text content inside the heading element, or add aria-label='Heading text' if you need a visually hidden heading.",
          wcag: 'WCAG 2.1 - 2.4.6 (Level AA)'
        }
      });
    });

    return violations;
  }
};
