const { walkNode } = require('../../parsers/htmlParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');

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
  id: 'img-alt-missing',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'img') return;

      const roleAttr = getAttr(node, 'role');
      if (roleAttr && (roleAttr.value === 'presentation' || roleAttr.value === 'none')) {
        return;
      }

      const altAttr = getAttr(node, 'alt');
      if (altAttr && altAttr.value !== undefined && altAttr.value !== null) {
        return;
      }

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'img-alt-missing',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This image has no alt attribute.',
          why: 'Screen reader users will hear the file name or URL read aloud instead of a meaningful description. This makes the image useless or confusing for blind users.',
          fix: "Add alt='describe what the image shows' to the img tag. If the image is purely decorative, use alt='' (empty string) to tell screen readers to skip it.",
          wcag: 'WCAG 2.1 - 1.1.1 (Level A)'
        }
      });
    });

    return violations;
  },

  // ---- AI-suggested fix --------------------------------------------------------------------------
  // fixTier 'ai-suggested' means: never auto-applied in ANY remediationMode. It is offered as a quick
  // fix whose edit is only produced (and previewed) when the developer selects it.
  // fix(violation, sourceCode, services) is async; services.generate(candidate) is the (gated, cached)
  // AI call and is supplied by the caller. The edit adds alt="..." to the start tag.
  fixTier: 'ai-suggested',
  aiFixLabel: 'alt text',
  async fix(violation, sourceCode, services) {
    if (!services || typeof services.generate !== 'function') return null;
    const found = aiFix.findHtmlElement(sourceCode, violation, 'img');
    if (!found) return null;
    const { ast, node } = found;

    // Stale check: the violation was "no alt attribute at all" (and not marked presentational).
    const role = getAttr(node, 'role');
    if (getAttr(node, 'alt') || (role && (role.value === 'presentation' || role.value === 'none'))) return null;

    const src = getAttr(node, 'src');
    const suggestion = await services.generate({
      kind: 'image-alt-fix',
      content: '',
      path: ctx.htmlPath(node),
      context: ctx.pick({
        fileName: ctx.imageFileName(src && src.value),
        figcaption: ctx.htmlFigcaption(node, ast),
        nearestHeading: ctx.htmlNearestHeading(ast, node),
        surroundingText: ctx.htmlSurroundingText(node, '[IMAGE]')
      })
    });

    const text = aiFix.cleanAltSuggestion(suggestion.suggestedText);
    if (!text) return { unavailable: 'The AI suggestion was not usable as alt text (it was a file name or a single generic word). Write the alt text yourself.' };
    return { ...aiFix.htmlAddAttribute(sourceCode, node, 'alt', text), suggestion: { ...suggestion, suggestedText: text } };
  }
};
