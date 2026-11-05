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

module.exports = {
  id: 'autofocus-used',
  language: 'html',
  severity: 'advisory',
  wcag: 'WCAG 2.1 - 3.2.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (!node.attrs) return;

      const autofocus = getAttr(node, 'autofocus');
      if (!autofocus && !(node.attrs || []).some(a => a.name === 'autofocus')) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'autofocus-used',
        severity: 'advisory',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'The autofocus attribute is used on this element.',
          why: 'Auto-focusing an element on page load disorients screen reader users who are not expecting focus to move, and can disrupt users who have already navigated elsewhere on the page.',
          fix: 'Remove autofocus unless there is a strong user experience reason for it. If needed on a dialog, manage focus programmatically after the dialog opens.',
          wcag: 'WCAG 2.1 - 3.2.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
