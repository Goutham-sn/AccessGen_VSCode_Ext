const { walkJSX } = require('../../parsers/jsxParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');
const { findAttr, attrValue, getJsxAccessibleName } = require('../shared/jsxAccessibleName');
const { isGenericLinkText } = require('../shared/genericLinkText');
const { judgeLinkText, CONTEXT_BLOCKS } = require('../shared/linkPurpose');
const { isHiddenJsx, hasJsxSpread } = require('../shared/visibility');

// JSXElement -> its nearest JSXElement ancestor, for the whole file.
function parentMap(ast) {
  const parents = new WeakMap();
  (function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, parent)); return; }
    if (typeof node.type !== 'string') return;
    let next = parent;
    if (node.type === 'JSXElement') { parents.set(node, parent); next = node; }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
      const c = node[k];
      if (c && typeof c === 'object') visit(c, next);
    }
  })(ast, null);
  return parents;
}

// Text around the link in its sentence-like block. A dynamic {expression} may well hold the explaining text, so it
// counts as text: a link is never reported because of content AccessGen cannot read.
function jsxLinkContext(link, parents) {
  let block = parents.get(link);
  while (block && !CONTEXT_BLOCKS.has(getElementName(block.openingElement).toLowerCase())) block = parents.get(block);
  const from = block || parents.get(link);
  if (!from) return '';
  let out = '';
  (function visit(children) {
    for (const c of children || []) {
      if (c === link) continue;
      if (c.type === 'JSXText') out += ' ' + c.value;
      else if (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression') out += c.expression.type === 'StringLiteral' ? ' ' + c.expression.value : ' dynamic text ';
      else if (c.type === 'JSXElement' || c.type === 'JSXFragment') visit(c.children);
    }
  })(from.children);
  return out;
}

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
}

module.exports = {
  id: 'jsx-anchor-no-content',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.4 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];
    let parents = null;

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXElement') return;
      if (!node.openingElement) return;

      const name = getElementName(node.openingElement);
      if (name !== 'a') return;
      const opening = node.openingElement;
      // Only real links: no href (and no role="link") is not a link; spread props may supply href or a name.
      const role = findAttr(opening, 'role');
      const roleVal = role ? attrValue(role) : { state: 'absent' };
      if (!findAttr(opening, 'href') && !(roleVal.state === 'static' && roleVal.text.trim().toLowerCase() === 'link')) return;
      if (hasJsxSpread(opening) || isHiddenJsx(opening)) return;

      // Resolved name: aria-labelledby, aria-label, content, title. A name that can't be
      // read statically ({children}, aria-label={x}, <Icon/>, ...) is assumed to be fine.
      const resolved = getJsxAccessibleName(node, ast);
      if (resolved.unknown) return;

      if (resolved.name && !isGenericLinkText(resolved.name)) return;
      if (!parents) parents = parentMap(ast);
      const verdict = judgeLinkText(resolved.name, jsxLinkContext(node, parents), config && config.complianceLevel, isGenericLinkText);
      if (!verdict) return;
      const message = verdict.message;

      const loc = node.openingElement.loc || node.loc;
      if (!loc) return;

      violations.push({
        ruleId: 'jsx-anchor-no-content',
        severity: verdict.severity,
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
