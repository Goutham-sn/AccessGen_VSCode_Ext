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
  id: 'duplicate-id',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 4.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    const idMap = new Map();

    walkNode(ast, (node) => {
      if (!node.attrs) return;
      const idAttr = getAttr(node, 'id');
      if (!idAttr || !idAttr.value) return;

      const idVal = idAttr.value;
      if (!idMap.has(idVal)) {
        idMap.set(idVal, []);
      }
      idMap.get(idVal).push(node);
    });

    for (const [idVal, nodes] of idMap) {
      if (nodes.length < 2) continue;

      for (let i = 1; i < nodes.length; i++) {
        const loc = getLoc(nodes[i]);
        if (!loc) continue;

        violations.push({
          ruleId: 'duplicate-id',
          severity: 'critical',
          startLine: loc.startLine,
          endLine: loc.endLine,
          startChar: loc.startChar,
          endChar: loc.endChar,
          message: {
            what: `Duplicate id '${idVal}' found on this element.`,
            why: 'ARIA attributes like aria-labelledby and aria-describedby reference elements by id. Duplicate ids break these references unpredictably and cause screen readers to read wrong content.',
            fix: 'Every id must be unique within the page. Rename this id to something distinct.',
            wcag: 'WCAG 2.1 - 4.1.1 (Level A)'
          }
        });
      }
    }

    return violations;
  }
};
