// Is an element hidden from every user, so that accessibility checks do not apply to it?
// Hidden means: the hidden attribute, aria-hidden="true", an inline style with display:none or visibility:hidden,
// <input type="hidden">, or being inside any such element, a <template> or a <noscript>. Static analysis cannot see
// stylesheet rules, so only these explicit markers count.

const HIDING_TAGS = new Set(['template', 'noscript']);

function attr(node, name) {
  const a = (node.attrs || []).find(x => x.name === name);
  return a ? a.value : undefined;
}

function hidesItself(node) {
  if (!node || !node.attrs) return false;
  if (attr(node, 'hidden') !== undefined) return true;
  if (String(attr(node, 'aria-hidden') || '').trim().toLowerCase() === 'true') return true;
  const style = String(attr(node, 'style') || '').toLowerCase().replace(/\s+/g, '');
  if (/(^|;)display:none(!important)?(;|$)/.test(style) || /(^|;)visibility:hidden(!important)?(;|$)/.test(style)) return true;
  if (node.tagName === 'input' && String(attr(node, 'type') || '').toLowerCase() === 'hidden') return true;
  return false;
}

// parse5 node (with parentNode links).
function isHiddenHtml(node) {
  for (let n = node; n; n = n.parentNode) {
    if (HIDING_TAGS.has(n.tagName) || n.nodeName === '#document-fragment') return true;
    if (hidesItself(n)) return true;
  }
  return false;
}

// JSX opening element: aria-hidden / hidden props set to a static true value.
function isHiddenJsx(opening) {
  for (const a of (opening && opening.attributes) || []) {
    if (a.type !== 'JSXAttribute' || !a.name) continue;
    const name = a.name.name;
    if (name !== 'aria-hidden' && name !== 'hidden') continue;
    if (!a.value) return true; // <div hidden> / <div aria-hidden>
    let v = a.value;
    if (v.type === 'JSXExpressionContainer') v = v.expression;
    if (v.type === 'BooleanLiteral' && v.value) return true;
    if (v.type === 'StringLiteral' && v.value.trim().toLowerCase() === 'true') return true;
  }
  return false;
}

const hasJsxSpread = (opening) => ((opening && opening.attributes) || []).some(a => a.type === 'JSXSpreadAttribute');

module.exports = { isHiddenHtml, isHiddenJsx, hasJsxSpread, hidesItself };
