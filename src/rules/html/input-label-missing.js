const { walkNode } = require('../../parsers/htmlParser');
const { getControlName } = require('../shared/formLabel');
const { isHiddenHtml } = require('../shared/visibility');

function getAttr(node, name) {
  return (node.attrs || []).find(a => a.name === name);
}

function getLoc(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  const tag = loc.startTag || loc;
  return {
    startLine: tag.startLine - 1,
    endLine: (tag.endLine || tag.startLine) - 1,
    startChar: tag.startCol - 1,
    endChar: (tag.endCol || tag.startCol + 10) - 1
  };
}

const EXEMPT_TYPES = ['hidden', 'submit', 'button', 'reset', 'image'];

module.exports = {
  id: 'input-label-missing',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    const controls = [];

    walkNode(ast, (node) => {
      if (node.tagName === 'input' || node.tagName === 'textarea') controls.push(node);
    });

    for (const control of controls) {
      if (control.tagName === 'input') {
        const typeAttr = getAttr(control, 'type');
        const typeVal = typeAttr ? typeAttr.value.toLowerCase() : 'text';
        if (EXEMPT_TYPES.includes(typeVal)) continue;
      }

      if (isHiddenHtml(control)) continue;
      if (getControlName(control, ast).name) continue;

      // A placeholder does give the field a name, but it disappears as soon as the user types: a weaker problem.
      const placeholder = getAttr(control, 'placeholder');
      const placeholderOnly = !!(placeholder && placeholder.value && placeholder.value.trim());

      const loc = getLoc(control);
      if (!loc) continue;

      violations.push({
        ruleId: 'input-label-missing',
        severity: placeholderOnly ? 'warning' : 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: placeholderOnly ? 'This field is labelled only by its placeholder text.' : 'This input field has no label.',
          why: placeholderOnly ? 'The placeholder disappears as soon as the user starts typing, and its usually low contrast is hard to read, so users lose track of what the field is for.' : 'When a screen reader focuses this field, it will only say \'edit text\' or the input type with no context. The user has no idea what to type.',
          fix: "Add <label for='your-input-id'>Field Name</label> before this input, or wrap the input inside a <label> element, or add aria-label='Field Name' directly on the input.",
          wcag: placeholderOnly ? 'WCAG 2.1 - 3.3.2 (Level A)' : 'WCAG 2.1 - 1.3.1 (Level A)'
        }
      });
    }

    return violations;
  }
};
