const { walkNode } = require('../../parsers/htmlParser');
const { getAccessibleName } = require('../shared/accessibleName');
const { isHiddenHtml } = require('../shared/visibility');

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

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

// Mirrors jsx-heading-empty's hasTextContent: non-whitespace text, or any child
// element, counts as content. Comments and whitespace-only text do not.

module.exports = {
  id: 'heading-empty',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.6 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (!node.tagName) return;

      const roleAttr = getAttr(node, 'role');
      const isRoleHeading = !!roleAttr && roleAttr.value.trim().toLowerCase() === 'heading';
      if (!HEADING_TAGS.includes(node.tagName) && !isRoleHeading) return;

      const ariaLabel = getAttr(node, 'aria-label');
      if (ariaLabel && ariaLabel.value && ariaLabel.value.trim()) return;

      if (isHiddenHtml(node)) return;
      if (getAccessibleName(node, ast, { title: false }).name) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'heading-empty',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This heading element is empty.',
          why: 'Screen readers announce headings to help users navigate. An empty heading is announced as a heading with no text — confusing and useless for navigation.',
          fix: "Add visible text content inside the heading element, or add aria-label='Heading text' if you need a visually hidden heading.",
          wcag: 'WCAG 2.1 - 2.4.6 (Level AA)'
        }
      });
    });

    return violations;
  }
};
