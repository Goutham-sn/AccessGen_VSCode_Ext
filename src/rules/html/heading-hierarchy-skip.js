const { walkNode } = require('../../parsers/htmlParser');

const HEADING_TAGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

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
  id: 'heading-hierarchy-skip',
  language: 'html',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    const headings = [];

    walkNode(ast, (node) => {
      if (node.tagName && HEADING_TAGS[node.tagName]) {
        headings.push({
          node,
          level: HEADING_TAGS[node.tagName]
        });
      }
    });

    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1];
      const curr = headings[i];

      if (curr.level > prev.level + 1) {
        const loc = getLoc(curr.node);
        if (!loc) continue;

        violations.push({
          ruleId: 'heading-hierarchy-skip',
          severity: 'warning',
          startLine: loc.startLine,
          endLine: loc.endLine,
          startChar: loc.startChar,
          endChar: loc.endChar,
          message: {
            what: `Heading level skipped from h${prev.level} to h${curr.level}.`,
            why: 'Screen reader users navigate pages by heading structure. A skipped level breaks the outline and makes navigation confusing — like a book jumping from chapter 1 to section 1.3 with no 1.1 or 1.2.',
            fix: `Use h${prev.level + 1} here instead of h${curr.level}, or restructure your heading hierarchy so levels are sequential.`,
            wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
          }
        });
      }
    }

    return violations;
  }
};
