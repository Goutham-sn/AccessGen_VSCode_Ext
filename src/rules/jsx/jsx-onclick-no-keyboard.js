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

const NATIVE_INTERACTIVE = ['button', 'a', 'input', 'select', 'textarea'];

module.exports = {
  id: 'jsx-onclick-no-keyboard',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;

      const name = getElementName(node);
      if (!name) return;

      if (config.isTrustedComponent && config.isTrustedComponent(name)) return;

      // JSX native elements are always lowercase identifiers in source. A capitalised tag
      // (<A>, <Select>) or a member expression (<Foo.A>) is a component, never native,
      // so it must not be exempted by the native-element list.
      const isNative = node.name.type === 'JSXIdentifier' && NATIVE_INTERACTIVE.includes(name);
      if (isNative) return;

      if (!hasJSXAttr(node, 'onClick')) return;

      if (hasJSXAttr(node, 'onKeyDown') || hasJSXAttr(node, 'onKeyUp') || hasJSXAttr(node, 'onKeyPress')) {
        return;
      }

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-onclick-no-keyboard',
        severity: 'critical',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: 'This element has onClick but no keyboard event handler.',
          why: 'Keyboard-only users and screen reader users activate elements using Enter or Space. Without a keyboard handler, they cannot trigger this action at all.',
          fix: "Add onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { yourHandler(); }}} alongside the onClick handler. Or better — replace the element with a <button> which handles this automatically.",
          wcag: 'WCAG 2.1 - 2.1.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
