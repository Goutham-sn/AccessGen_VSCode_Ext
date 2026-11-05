const { walkNode } = require('../../parsers/htmlParser');
const { isHiddenHtml } = require('../shared/visibility');
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
  id: 'iframe-missing-title',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 4.1.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'iframe') return;
      if (isHiddenHtml(node)) return;

      // title, aria-label or aria-labelledby; the fallback text between the tags is not
      // a frame name.
      if (getAccessibleName(node, ast, { content: false }).name) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'iframe-missing-title',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This iframe has no title.',
          why: 'Screen reader users cannot know what embedded content is inside the frame. They will hear \'frame\' with no description.',
          fix: "Add title='Description of iframe content' to the iframe, for example: <iframe title='Payment form'>",
          wcag: 'WCAG 2.1 - 4.1.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
