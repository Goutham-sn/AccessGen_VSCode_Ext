const { walkJSX } = require('../../parsers/jsxParser');

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

      const hasClick = hasJSXAttr(node, 'onClick');
      const hasKeyDown = hasJSXAttr(node, 'onKeyDown');
      if (!hasClick && !hasKeyDown) return;

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
