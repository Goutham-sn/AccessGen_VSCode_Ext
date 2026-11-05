const { walkNode } = require('../../parsers/htmlParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');
const { getAccessibleName } = require('../shared/accessibleName');
const { isGenericLinkText } = require('../shared/genericLinkText');
const { judgeLinkText, htmlLinkContext } = require('../shared/linkPurpose');
const { isHiddenHtml } = require('../shared/visibility');

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

const getAttr = (node, name) => { const a = (node.attrs || []).find(x => x.name === name); return a ? a.value : undefined; };

// Visible text of `block` with the `link` subtree left out.
function textWithout(block, link) {
  let out = '';
  (function visit(n) {
    for (const c of n.childNodes || []) {
      if (c === link) continue;
      if (c.nodeName === '#text') out += ' ' + (c.value || '');
      else if (c.tagName && !['script', 'style'].includes(c.tagName)) visit(c);
    }
  })(block);
  return out;
}

module.exports = {
  id: 'anchor-no-text',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'a') return;
      // Only real links: an <a> without href (a placeholder or named anchor) is not focusable and not a link.
      const role = getAttr(node, 'role');
      if (getAttr(node, 'href') === undefined && !(role && role.trim().toLowerCase() === 'link')) return;
      if (isHiddenHtml(node)) return;

      const loc = getLoc(node);
      if (!loc) return;

      // The link's resolved name (aria-labelledby, aria-label, content, title). A URL or domain as the text is a
      // valid name: it says exactly where the link goes. A generic phrase fails only when its sentence does not
      // explain it (see shared/linkPurpose.js).
      const { name } = getAccessibleName(node, ast);
      const verdict = judgeLinkText(name, htmlLinkContext(node, (block, link) => textWithout(block, link)), config && config.complianceLevel, isGenericLinkText);
      if (!verdict) return;
      const message = verdict.message;

      violations.push({
        ruleId: 'anchor-no-text',
        severity: verdict.severity,
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
