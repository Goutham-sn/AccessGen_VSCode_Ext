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

const REFERENCE_ATTRS = ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto', 'headers', 'list', 'form'];

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

    // Ids that something points at: a duplicate of one of these really breaks a label, a description or a table
    // header for assistive technology. Any other duplicate is invalid HTML (WCAG 2.2 removed 4.1.1) and only
    // worth tidying up.
    const referenced = new Set();
    walkNode(ast, (node) => {
      for (const a of node.attrs || []) {
        if (REFERENCE_ATTRS.includes(a.name)) String(a.value).split(/\s+/).filter(Boolean).forEach(id => referenced.add(id));
        else if (a.name === 'href' && /^#./.test(a.value)) referenced.add(a.value.slice(1));
      }
    });

    for (const [idVal, nodes] of idMap) {
      if (nodes.length < 2) continue;
      const breaksReference = referenced.has(idVal);

      for (let i = 1; i < nodes.length; i++) {
        const loc = getLoc(nodes[i]);
        if (!loc) continue;

        violations.push({
          ruleId: 'duplicate-id',
          severity: breaksReference ? 'critical' : 'advisory',
          startLine: loc.startLine,
          endLine: loc.endLine,
          startChar: loc.startChar,
          endChar: loc.endChar,
          message: {
            what: breaksReference ? `Duplicate id '${idVal}', and a label or ARIA attribute points at it.` : `Duplicate id '${idVal}' (nothing in this file refers to it).`,
            why: breaksReference ? 'The label, description or header that refers to this id may be attached to the wrong element, so screen readers announce the wrong text.' : 'Ids must be unique for valid HTML and for scripts and styles to target the right element. It does not affect assistive technology unless something refers to the id.',
            fix: 'Every id must be unique within the page. Rename this id to something distinct.',
            wcag: breaksReference ? 'WCAG 2.1 - 1.3.1 (Level A)' : 'WCAG 2.1 - 4.1.1 (Level A)'
          }
        });
      }
    }

    return violations;
  }
};
