const { walkJSX } = require('../../parsers/jsxParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');
const { findAttr, attrValue, getJsxAccessibleName } = require('../shared/jsxAccessibleName');
const { isGenericLinkText, isUrlLinkText } = require('../shared/genericLinkText');

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
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
  id: 'jsx-anchor-no-content',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXElement') return;
      if (!node.openingElement) return;

      const name = getElementName(node.openingElement);
      if (name !== 'a') return;

      // Resolved name: aria-labelledby, aria-label, content, title. A name that can't be
      // read statically ({children}, aria-label={x}, <Icon/>, ...) is assumed to be fine.
      const resolved = getJsxAccessibleName(node, ast);
      if (resolved.unknown) return;

      let message = null;
      if (!resolved.name) message = NO_TEXT_MESSAGE;
      else if (isUrlLinkText(resolved.name)) message = URL_MESSAGE;
      else if (isGenericLinkText(resolved.name)) message = NO_TEXT_MESSAGE;
      if (!message) return;

      const loc = node.openingElement.loc || node.loc;
      if (!loc) return;

      violations.push({
        ruleId: 'jsx-anchor-no-content',
        severity: 'critical',
        startLine: loc.start.line - 1,
        endLine: loc.end.line - 1,
        startChar: loc.start.column,
        endChar: loc.end.column,
        message
      });
    });

    return violations;
  },

  // ---- AI-suggested fix --------------------------------------------------------------------------
  // fixTier 'ai-suggested': never auto-applied in ANY remediationMode; a quick fix selected by hand.
  // No visible text (empty / icon only): adds aria-label to the opening element.
  // One static text child that is a generic phrase or a bare URL: replaces that text.
  // Anything else (spread props, an existing aria-label, mixed content) is reported as unavailable.
  fixTier: 'ai-suggested',
  aiFixLabel: 'link text',
  async fix(violation, sourceCode, services) {
    if (!services || typeof services.generate !== 'function') return null;
    const found = aiFix.findJsxElement(sourceCode, violation);
    if (!found) return null;
    const { ast, node } = found;
    const opening = node.openingElement;
    if (opening.name.type !== 'JSXIdentifier' || opening.name.name !== 'a') return null;

    const shape = aiFix.classifyJsxAnchor(node);
    if (shape.kind === 'unsupported') return { unavailable: 'No AI suggestion for this link: ' + shape.why + '.' };

    const info = ctx.buildJsxInfo(ast);
    const meta = info.get(node) || {};
    const href = attrValue(findAttr(opening, 'href'));
    const suggestion = await services.generate({
      kind: 'link-text-fix',
      content: shape.kind === 'text' ? shape.text : '',
      path: meta.path,
      context: ctx.pick({
        href: href.state === 'static' ? ctx.sanitizeHref(href.text) : undefined,
        surroundingText: ctx.jsxSurroundingText(node, info, '[LINK]')
      })
    });

    const text = aiFix.cleanLinkSuggestion(suggestion.suggestedText);
    if (!text) return { unavailable: 'The AI suggestion was not usable as link text (it was empty, generic or a URL). Write the link text yourself.' };
    const edit = shape.kind === 'text'
      ? aiFix.jsxReplaceChildren(sourceCode, node, text)
      : aiFix.jsxAddAttribute(sourceCode, node, 'aria-label', text);
    if (!edit) return { unavailable: 'No AI suggestion for this link: it has no closing tag to edit.' };
    return { ...edit, suggestion: { ...suggestion, suggestedText: text } };
  }
};
