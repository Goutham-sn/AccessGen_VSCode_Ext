const { walkCSS } = require('../../parsers/cssParser');

const { parseColor, getLuminance, getContrastRatio } = require('../shared/colorMath');

function getLoc(node) {
  if (!node.source || !node.source.start) return null;
  const start = node.source.start;
  const end = node.source.end || start;
  return {
    startLine: start.line - 1,
    endLine: end.line - 1,
    startChar: start.column - 1,
    endChar: end.column
  };
}

module.exports = {
  id: 'color-contrast-low',
  language: 'css',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 1.4.3 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];

    ast.walkRules((rule) => {
      let textColor = null;
      let bgColor = null;
      let textDecl = null;

      rule.walkDecls((decl) => {
        if (decl.prop === 'color') {
          textColor = decl.value;
          textDecl = decl;
        }
        if (decl.prop === 'background-color') {
          bgColor = decl.value;
        }
      });

      if (!textColor || !bgColor || !textDecl) return;

      const fg = parseColor(textColor);
      const bg = parseColor(bgColor);
      if (!fg || !bg) return;

      const fgLum = getLuminance(fg.r, fg.g, fg.b);
      const bgLum = getLuminance(bg.r, bg.g, bg.b);
      const ratio = getContrastRatio(fgLum, bgLum);

      if (ratio >= 4.5) return;

      const loc = getLoc(textDecl);
      if (!loc) return;

      const ratioStr = ratio.toFixed(2);

      violations.push({
        ruleId: 'color-contrast-low',
        severity: 'warning',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: `Text color contrast ratio is ${ratioStr}:1, below the required 4.5:1 minimum.`,
          why: 'Low contrast text is difficult or impossible to read for users with low vision, color blindness, or anyone using their screen in bright sunlight. Approximately 300 million people have color vision deficiency.',
          fix: 'Increase the contrast between your text color and background color until it reaches at least 4.5:1. Use a contrast checker like the WebAIM Contrast Checker to test your values.',
          wcag: 'WCAG 2.1 - 1.4.3 (Level AA)'
        }
      });
    });

    return violations;
  }
};
