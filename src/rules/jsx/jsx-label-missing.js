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

function getJSXAttr(node, name) {
  if (!node.attributes) return null;
  return node.attributes.find(
    a => a.type === 'JSXAttribute' && a.name && a.name.name === name
  );
}

function getJSXAttrValue(attr) {
  if (!attr || !attr.value) return null;
  if (attr.value.type === 'StringLiteral') return attr.value.value;
  if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression) {
    if (attr.value.expression.type === 'StringLiteral') return attr.value.expression.value;
  }
  return undefined;
}

// Source text of a JSX expression attribute value (htmlFor={x}, id={x}), whitespace-
// normalised, or null when the value is not an expression container. Two attributes
// with identical source text are treated as the same reference.
function getJSXAttrExprText(attr, sourceCode) {
  if (!attr || !attr.value || attr.value.type !== 'JSXExpressionContainer') return null;
  const expr = attr.value.expression;
  if (!expr || expr.type === 'JSXEmptyExpression' || expr.type === 'StringLiteral') return null;
  if (typeof expr.start !== 'number' || typeof expr.end !== 'number') return null;
  return sourceCode.slice(expr.start, expr.end).replace(/\s+/g, '');
}

// Maps each opening element to the <label> JSXElements that wrap it.
function collectWrappingLabels(ast) {
  const wrapping = new WeakMap();
  (function visit(node, labels) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, labels)); return; }
    if (typeof node.type !== 'string') return;
    let next = labels;
    if (node.type === 'JSXElement' && node.openingElement) {
      if (labels.length) wrapping.set(node.openingElement, labels);
      const n = node.openingElement.name;
      if (n && n.type === 'JSXIdentifier' && n.name === 'label') next = [...labels, node];
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = node[key];
      if (child && typeof child === 'object') visit(child, next);
    }
  })(ast, []);
  return wrapping;
}

const INPUT_ELEMENTS = ['input', 'select', 'textarea'];
const EXEMPT_TYPES = ['hidden', 'submit', 'button', 'reset'];

module.exports = {
  id: 'jsx-label-missing',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    const labelsByFor = new Map();     // literal htmlFor value -> [label JSXElement]
    const labelsByForExpr = new Map(); // htmlFor={expr} source text -> [label JSXElement]
    const inputElements = [];
    const wrapping = collectWrappingLabels(ast);

    const push = (map, key, label) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(label);
    };

    walkJSX(ast, (node) => {
      if (node.type === 'JSXElement' && node.openingElement) {
        if (getElementName(node.openingElement) === 'label') {
          const htmlFor = getJSXAttr(node.openingElement, 'htmlFor');
          if (htmlFor) {
            const val = getJSXAttrValue(htmlFor);
            if (val) push(labelsByFor, val, node);
            const exprText = getJSXAttrExprText(htmlFor, sourceCode);
            if (exprText) push(labelsByForExpr, exprText, node);
          }
        }
      }
      if (node.type !== 'JSXOpeningElement') return;
      if (INPUT_ELEMENTS.includes(getElementName(node).toLowerCase())) {
        inputElements.push(node);
      }
    });

    // A label only counts if it has a name of its own (or one we can't read statically).
    const labelHasName = (label) => {
      const r = getJsxAccessibleName(label, ast);
      return !!r.name || r.unknown;
    };

    for (const el of inputElements) {
      const name = getElementName(el);

      if (config.isTrustedComponent && config.isTrustedComponent(name)) continue;

      if (name.toLowerCase() === 'input') {
        const typeAttr = getJSXAttr(el, 'type');
        if (typeAttr) {
          const typeVal = getJSXAttrValue(typeAttr);
          if (typeVal && EXEMPT_TYPES.includes(typeVal.toLowerCase())) continue;
        }
      }

      // The control's own aria-labelledby / aria-label / title (its children are never its name).
      const own = getJsxAccessibleName(el, ast, { content: false });
      if (own.name || own.unknown) continue;

      const candidates = [...(wrapping.get(el) || [])];
      const idAttr = getJSXAttr(el, 'id');
      if (idAttr) {
        const idVal = getJSXAttrValue(idAttr);
        if (idVal && labelsByFor.has(idVal)) candidates.push(...labelsByFor.get(idVal));
        const idExpr = getJSXAttrExprText(idAttr, sourceCode);
        if (idExpr && labelsByForExpr.has(idExpr)) candidates.push(...labelsByForExpr.get(idExpr));
      }
      if (candidates.some(labelHasName)) continue;

      if (!el.loc) continue;

      violations.push({
        ruleId: 'jsx-label-missing',
        severity: 'critical',
        startLine: el.loc.start.line - 1,
        endLine: el.loc.end.line - 1,
        startChar: el.loc.start.column,
        endChar: el.loc.end.column,
        message: {
          what: 'This input field has no label.',
          why: 'When a screen reader focuses this field, it will only say \'edit text\' or the input type with no context. The user has no idea what to type.',
          fix: "Add a <label htmlFor='input-id'>Label text</label>, or add aria-label='Field Name' directly on the element.",
          wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
        }
      });
    }

    return violations;
  }
};
