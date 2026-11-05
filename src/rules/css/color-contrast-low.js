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

// px size of a font-size value, assuming a 16px root for rem/em/%; null when it cannot be known statically.
function fontSizePx(value) {
  const m = String(value || '').trim().toLowerCase().match(/^(\d*\.?\d+)(px|pt|rem|em|%)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { px: n, pt: n * 4 / 3, rem: n * 16, em: n * 16, '%': n * 0.16 }[m[2]];
}

function isBold(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'bold' || v === 'bolder' || (/^\d+$/.test(v) && parseInt(v, 10) >= 700);
}

// The colors this rule block sets directly, their contrast, and the WCAG minimum for its text size:
// 3:1 for large text (at least 24px, or 18.66px bold), 4.5:1 otherwise. A `background` shorthand counts
// only when it is a single color. null when the block does not set both colors to evaluable literals.
function contrastFacts(rule) {
  let textDecl = null, bgValue = null, size = null, weight = null;
  for (const decl of rule.nodes || []) {
    if (decl.type !== 'decl') continue;
    const prop = String(decl.prop).toLowerCase();
    if (prop === 'color') textDecl = decl;
    else if (prop === 'background-color') bgValue = decl.value;
    else if (prop === 'background' && parseColor(decl.value)) bgValue = decl.value;
    else if (prop === 'font-size') size = decl.value;
    else if (prop === 'font-weight') weight = decl.value;
  }
  if (!textDecl || !bgValue) return null;
  const fg = parseColor(textDecl.value);
  const bg = parseColor(bgValue);
  if (!fg || !bg) return null;
  const px = fontSizePx(size);
  const large = px !== null && (px >= 24 || (px >= 18.66 && isBold(weight)));
  const ratio = getContrastRatio(getLuminance(fg.r, fg.g, fg.b), getLuminance(bg.r, bg.g, bg.b));
  return { fg, bg, fgValue: textDecl.value, bgValue, ratio, required: large ? 3 : 4.5, large, textDecl };
}

module.exports = {
  contrastFacts,
  id: 'color-contrast-low',
  language: 'css',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 1.4.3 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];

    ast.walkRules((rule) => {
      const facts = contrastFacts(rule);
      if (!facts) return;
      const { ratio, required, textDecl } = facts;
      if (ratio >= required) return;

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
          what: `Text color contrast ratio is ${ratioStr}:1, below the required ${required}:1 minimum${facts.large ? ' for large text' : ''}.`,
          why: 'Low contrast text is difficult or impossible to read for users with low vision, color blindness, or anyone using their screen in bright sunlight. Approximately 300 million people have color vision deficiency.',
          fix: `Increase the contrast between your text color and background color until it reaches at least ${required}:1. Use a contrast checker like the WebAIM Contrast Checker to test your values.`,
          wcag: 'WCAG 2.1 - 1.4.3 (Level AA)'
        }
      });
    });

    return violations;
  }
};
