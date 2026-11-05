const { walkNode } = require('../../parsers/htmlParser');
const { getAccessibleName } = require('../shared/accessibleName');

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
  id: 'form-missing-landmark',
  language: 'html',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'form') return;

      // A form's children are never its name: aria-labelledby, aria-label, title only.
      if (getAccessibleName(node, ast, { content: false }).name) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'form-missing-landmark',
        severity: 'warning',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This form has no accessible name.',
          why: 'When a page has multiple forms, screen reader users cannot tell them apart. They navigate landmarks by name — \'Login form\', \'Search form\' — and unnamed forms create confusion.',
          fix: "Add aria-label='Form purpose' to the form element, for example: <form aria-label='Contact form'>.",
          wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
