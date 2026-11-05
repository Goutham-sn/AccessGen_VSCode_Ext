const { walkNode } = require('../../parsers/htmlParser');

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

const VALID_INTERACTIVE_ROLES = ['button', 'link', 'menuitem'];

module.exports = {
  id: 'div-used-as-button',
  language: 'html',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 4.1.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'div' && node.tagName !== 'span') return;

      const onclick = getAttr(node, 'onclick');
      if (!onclick) return;

      const roleAttr = getAttr(node, 'role');
      const tabindexAttr = getAttr(node, 'tabindex');

      if (roleAttr && VALID_INTERACTIVE_ROLES.includes(roleAttr.value) && tabindexAttr) {
        return;
      }

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'div-used-as-button',
        severity: 'warning',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'A <' + node.tagName + '> is being used as a clickable element without proper accessibility attributes.',
          why: 'Keyboard users cannot reach or activate this element. Screen readers will not announce it as interactive. Only mouse users can use it.',
          fix: "Replace with a <button> element — it handles keyboard and screen reader support automatically. If you must use a div, add role='button' tabindex='0' and handle both onclick and onkeydown events.",
          wcag: 'WCAG 2.1 - 4.1.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
