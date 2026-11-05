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
  id: 'positive-tabindex',
  language: 'html',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 2.4.3 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (!node.attrs) return;

      const tabindexAttr = getAttr(node, 'tabindex');
      if (!tabindexAttr) return;

      const val = parseInt(tabindexAttr.value, 10);
      if (isNaN(val) || val < 1) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'positive-tabindex',
        severity: 'warning',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'A positive tabindex value is used on this element.',
          why: 'Positive tabindex values override the natural tab order of the page, creating a confusing keyboard navigation experience that jumps around the page unpredictably.',
          fix: "Remove the tabindex attribute to use natural document order, or use tabindex='0' to make an element focusable without disrupting tab order.",
          wcag: 'WCAG 2.1 - 2.4.3 (Level A)'
        }
      });
    });

    return violations;
  }
};
