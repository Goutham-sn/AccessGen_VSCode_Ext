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
  id: 'html-missing-lang',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 3.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'html') return;

      const langAttr = getAttr(node, 'lang');
      if (langAttr && langAttr.value && langAttr.value.trim()) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'html-missing-lang',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'The <html> element is missing a lang attribute.',
          why: 'Screen readers use the lang attribute to select the correct voice and pronunciation engine. Without it, content may be read in the wrong language with wrong pronunciation.',
          fix: "Add lang='en' to the html element: <html lang='en'>. Use the correct BCP 47 language code for your content.",
          wcag: 'WCAG 2.1 - 3.1.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
