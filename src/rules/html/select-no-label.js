const { walkNode } = require('../../parsers/htmlParser');
const { getControlName } = require('../shared/formLabel');

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
  id: 'select-no-label',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    const selects = [];

    walkNode(ast, (node) => {
      if (node.tagName === 'select') selects.push(node);
    });

    for (const sel of selects) {
      // <option> text is the select's value, not its name, so content is never used.
      if (getControlName(sel, ast).name) continue;

      const loc = getLoc(sel);
      if (!loc) continue;

      violations.push({
        ruleId: 'select-no-label',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This dropdown has no label.',
          why: 'Screen readers will only say \'combo box\' with no context. The user cannot know what they are selecting.',
          fix: "Add a <label for='select-id'>Label text</label> or add aria-label='Label text' to the select element.",
          wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
        }
      });
    }

    return violations;
  }
};
