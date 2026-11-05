const { walkNode } = require('../../parsers/htmlParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');
const { getAccessibleName } = require('../shared/accessibleName');
const { isGenericLinkText, isUrlLinkText } = require('../shared/genericLinkText');

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

const NO_TEXT_MESSAGE = {
  what: 'This link has no descriptive text.',
  why: 'Screen reader users often navigate by listing all links on a page. Hearing \'click here\' or \'read more\' multiple times gives them no idea where each link goes.',
  fix: "Replace with descriptive text like <a href='...'>Read our accessibility guide</a>, or add aria-label='Descriptive link purpose' to the anchor.",
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)'
};

const URL_MESSAGE = {
  what: "This link's text is a raw URL.",
  why: 'Screen readers read a URL character by character, which is slow and tells the user nothing about where the link leads.',
  fix: "Replace the URL with a description of the destination, e.g. <a href='...'>Our accessibility guide</a>.",
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)'
};

module.exports = {
  id: 'anchor-no-text',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'a') return;

      const loc = getLoc(node);
      if (!loc) return;

      // The link's resolved name (aria-labelledby, aria-label, content, title), then the
      // empty / generic-phrase / raw-URL checks layered on top of it.
      const { name } = getAccessibleName(node, ast);

      let message = null;
      if (!name) message = NO_TEXT_MESSAGE;
      else if (isUrlLinkText(name)) message = URL_MESSAGE;
      else if (isGenericLinkText(name)) message = NO_TEXT_MESSAGE;
      if (!message) return;

      violations.push({
        ruleId: 'anchor-no-text',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message
      });
    });

    return violations;
  },

  // ---- AI-suggested fix --------------------------------------------------------------------------
  // fixTier 'ai-suggested': never auto-applied in ANY remediationMode; a quick fix selected by hand.
  // No visible text (empty / icon only): adds aria-label="..." to the start tag.
  // One plain text child that is a generic phrase or a bare URL: replaces that text.
  // Anything else is reported as unavailable instead of being guessed at (see shared/aiFix.js).
  fixTier: 'ai-suggested',
  aiFixLabel: 'link text',
  async fix(violation, sourceCode, services) {
    if (!services || typeof services.generate !== 'function') return null;
    const found = aiFix.findHtmlElement(sourceCode, violation, 'a');
    if (!found) return null;
    const { node } = found;

    const shape = aiFix.classifyHtmlAnchor(node);
    if (shape.kind === 'unsupported') return { unavailable: 'No AI suggestion for this link: ' + shape.why + '.' };

    const href = node.attrs.find(a => a.name === 'href');
    const suggestion = await services.generate({
      kind: 'link-text-fix',
      content: shape.kind === 'text' ? shape.text : '',
      path: ctx.htmlPath(node),
      context: ctx.pick({
        href: ctx.sanitizeHref(href && href.value),
        surroundingText: ctx.htmlSurroundingText(node, '[LINK]')
      })
    });

    const text = aiFix.cleanLinkSuggestion(suggestion.suggestedText);
    if (!text) return { unavailable: 'The AI suggestion was not usable as link text (it was empty, generic or a URL). Write the link text yourself.' };
    const edit = shape.kind === 'text'
      ? aiFix.htmlReplaceInner(sourceCode, node, text)
      : aiFix.htmlAddAttribute(sourceCode, node, 'aria-label', text);
    if (!edit) return { unavailable: 'No AI suggestion for this link: it has no closing tag to edit.' };
    return { ...edit, suggestion: { ...suggestion, suggestedText: text } };
  }
};
