const { walkNode } = require('../../parsers/htmlParser');
const { getAccessibleName } = require('../shared/accessibleName');

function getAttr(node, name) {
  return (node.attrs || []).find(a => a.name === name);
}

function getLoc(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  return {
    startLine: (loc.startTag ? loc.startTag.startLine : loc.startLine) - 1,
    endLine: (loc.endTag ? loc.endTag.endLine : loc.endLine || loc.startLine) - 1,
    startChar: (loc.startTag ? loc.startTag.startCol : loc.startCol) - 1,
    endChar: (loc.endTag ? loc.endTag.endCol : loc.endCol || loc.startCol + 10) - 1
  };
}

// <input type="..."> kinds whose name is their value attribute.
// NOTE: browsers supply a default label ("Submit") for a type=submit input that has no
// value attribute at all. It is included here on request; remove 'submit' to exempt it.
const BUTTON_INPUT_TYPES = ['button', 'submit'];

// Which structural kind of button this is, or null when the element isn't one.
function buttonKind(node) {
  if (node.tagName === 'button') return 'button';
  if (node.tagName === 'input') {
    const type = (getAttr(node, 'type') || { value: '' }).value.trim().toLowerCase();
    return BUTTON_INPUT_TYPES.includes(type) ? 'input' : null;
  }
  const role = getAttr(node, 'role');
  if (role && role.value.trim().toLowerCase().split(/\s+/)[0] === 'button') return 'role';
  return null;
}

module.exports = {
  id: 'button-empty',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 4.1.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (!node.tagName) return;

      const kind = buttonKind(node);
      if (!kind) return;

      if (kind === 'input') {
        const value = getAttr(node, 'value');
        if (value && value.value.trim()) return;
        if (getAccessibleName(node, ast, { content: false }).name) return;
      } else if (getAccessibleName(node, ast).name) {
        return;
      }

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'button-empty',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This button has no accessible name.',
          why: 'A screen reader will announce \'button\' with no description. The user cannot know what this button does without clicking it blindly.',
          fix: kind === 'input'
            ? "Add a value attribute like <input type='submit' value='Send'>, or add aria-label='What this button does'."
            : "Add visible text inside the button like <button>Submit</button>, or add aria-label='What this button does' if you need an icon-only button.",
          wcag: 'WCAG 2.1 - 4.1.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
