// Context about ONE element, used for two things: the AI judgment candidates (candidateSelector) and the
// AI-suggested fixes (the img/anchor rules' fix()). Everything here is the minimum a reviewer may see,
// already clipped and sanitised: the prompts add their own whitelist on top (judgment/prompts.js).
//
//   structural path   "html[0]>body[0]>div[1]>a[2]": tag + index among same-tag siblings, stable under
//                     blank lines and reformatting; used as an element's identity (changeTracker, caches)
//   figcaption        text of the <figcaption> in the nearest enclosing <figure>
//   nearest heading   text of the closest heading that precedes the element in document order
//   surrounding text  the prose around the element in its nearest block, with the element itself shown as
//                     a marker ("[IMAGE]" / "[LINK]"), in a short window around that marker
//   file name         base name of an image src (no directories, query or data: payloads)
//   href              sanitised: no query string, no credentials, no javascript:/data:, mailto/tel as scheme

const { walkNode } = require('../../parsers/htmlParser');
const { getAccessibleName } = require('./accessibleName');
const { getJsxAccessibleName } = require('./jsxAccessibleName');

const MAX_CONTEXT_CHARS = 200;
const SURROUNDING_RADIUS = 110; // characters kept on each side of the marker
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const BLOCK_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', 'blockquote', 'figure', 'figcaption', 'label', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'body']);
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'template', 'noscript']);

function clipText(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > MAX_CONTEXT_CHARS ? t.slice(0, MAX_CONTEXT_CHARS - 1) + '…' : t;
}

// An href is the only URL-ish thing a prompt may carry, so it is reduced to what describes the
// destination: no query string (tokens), no credentials, no javascript:/data: payloads, and
// mailto:/tel: reduced to the bare scheme (they hold an email address / phone number).
function sanitizeHref(href) {
  if (typeof href !== 'string') return undefined;
  let h = href.trim();
  if (!h) return undefined;
  const scheme = h.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const sc = scheme[1].toLowerCase();
    if (sc === 'mailto' || sc === 'tel' || sc === 'sms') return sc + ':';
    if (sc !== 'http' && sc !== 'https') return undefined;
  }
  h = h.replace(/^(\w+:)?\/\/[^/@]*@/, '$1//').split('?')[0];
  return h ? h.slice(0, MAX_CONTEXT_CHARS) : undefined;
}

// Only defined, non-empty entries; an image with no figcaption/heading gets {}.
function pick(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

// Base name of an image src: no directories (they can reveal project layout), no query string, and
// nothing at all for data:/javascript: URLs.
function imageFileName(src) {
  if (typeof src !== 'string') return '';
  const s = src.trim();
  if (!s || /^(data|javascript|blob):/i.test(s)) return '';
  let file = s.split(/[?#]/)[0].split('/').pop() || '';
  try { file = decodeURIComponent(file); } catch (e) { /* keep as is */ }
  return clipText(file);
}

// A short window of `text` centred on `marker`, trimmed with ellipses.
function windowAround(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return clipText(text);
  const start = Math.max(0, idx - SURROUNDING_RADIUS);
  const end = Math.min(text.length, idx + marker.length + SURROUNDING_RADIUS);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ---- HTML (parse5) ------------------------------------------------------------------------------

// Text of the <figcaption> that belongs to the nearest enclosing <figure>, if any.
function htmlFigcaption(node, ast) {
  let figure = node.parentNode;
  while (figure && figure.tagName !== 'figure') figure = figure.parentNode;
  if (!figure) return undefined;
  let caption = null;
  walkNode(figure, (n) => { if (!caption && n.tagName === 'figcaption') caption = n; });
  return caption ? clipText(getAccessibleName(caption, ast).name) : undefined;
}

// "html[0]>body[0]>div[1]>a[2]": each segment is the tag and its index among the parent's
// children with the same tag. Text/whitespace nodes are not counted, so blank lines and
// reformatting never change a path; only structural edits do.
function htmlPath(node) {
  const segs = [];
  for (let n = node; n && n.tagName; n = n.parentNode) {
    const siblings = (n.parentNode && n.parentNode.childNodes) || [];
    let idx = 0;
    for (const s of siblings) {
      if (s === n) break;
      if (s.tagName === n.tagName) idx++;
    }
    segs.unshift(`${n.tagName}[${idx}]`);
  }
  return segs.join('>');
}

// Text of the closest heading before `target` in document order.
function htmlNearestHeading(ast, target) {
  let last;
  let reached = false;
  walkNode(ast, (n) => {
    if (reached) return;
    if (n === target) { reached = true; return; }
    if (!n.tagName) return;
    const role = (n.attrs || []).find(a => a.name === 'role');
    if (HEADING_TAGS.includes(n.tagName) || (role && role.value.trim().toLowerCase() === 'heading')) {
      const name = getAccessibleName(n, ast).name;
      if (name) last = clipText(name);
    }
  });
  return last;
}

// The prose around `target` inside its nearest block element, with the target shown as `marker`.
function htmlSurroundingText(target, marker) {
  let block = target.parentNode;
  while (block && !(block.tagName && BLOCK_TAGS.has(block.tagName))) block = block.parentNode;
  if (!block) return '';
  let text = '';
  (function visit(n) {
    for (const c of n.childNodes || []) {
      if (c === target) text += ' ' + marker + ' ';
      else if (c.nodeName === '#text') text += c.value || '';
      else if (c.tagName && !SKIP_TEXT_TAGS.has(c.tagName)) visit(c);
    }
  })(block);
  return windowAround(text.replace(/\s+/g, ' ').trim(), marker);
}

// ---- JSX (Babel) --------------------------------------------------------------------------------

function jsxTagName(opening) {
  const n = opening && opening.name;
  if (!n) return '?';
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') {
    const parts = [];
    for (let m = n; m; m = m.object) parts.unshift(m.property ? m.property.name : m.name);
    return parts.join('.');
  }
  return '?';
}

// Same idea for JSX, over JSXElement ancestors only (Babel nodes carry no parent pointer, so
// everything is gathered in one document-order pass). Elements with no JSX ancestor are indexed
// across the file. Each element gets { path, figcaption, nearestHeading, parent }: its structural
// path, its enclosing <figure>'s figcaption, the nearest preceding heading's text, and its nearest
// JSX ancestor element.
function buildJsxInfo(ast) {
  const info = new WeakMap();
  let lastHeading;

  function staticName(el, opts) {
    const r = getJsxAccessibleName(el, ast, opts);
    return r.unknown ? '' : clipText(r.name);
  }
  function figcaptionOf(figure) {
    let found = '';
    (function scan(n) {
      if (found || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(scan); return; }
      if (n.type === 'JSXElement') {
        if (jsxTagName(n.openingElement) === 'figcaption') { found = staticName(n, { title: false }); return; }
        scan(n.children);
      }
    })(figure.children);
    return found;
  }

  (function visit(node, parentPath, counts, figcaption, parentEl) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, parentPath, counts, figcaption, parentEl)); return; }
    if (typeof node.type !== 'string') return;
    let nextPath = parentPath, nextCounts = counts, nextFig = figcaption, nextParent = parentEl;
    if (node.type === 'JSXElement') {
      const name = jsxTagName(node.openingElement);
      const idx = counts.get(name) || 0;
      counts.set(name, idx + 1);
      nextPath = (parentPath ? parentPath + '>' : '') + name + '[' + idx + ']';
      nextCounts = new Map();
      nextParent = node;
      info.set(node, { path: nextPath, figcaption, nearestHeading: lastHeading, parent: parentEl });
      const lower = name.toLowerCase();
      if (lower === 'figure') nextFig = figcaptionOf(node) || undefined;
      if (HEADING_TAGS.includes(lower)) {
        const text = staticName(node, { title: false });
        if (text) lastHeading = text;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = node[key];
      if (child && typeof child === 'object') visit(child, nextPath, nextCounts, nextFig, nextParent);
    }
  })(ast, '', new Map(), undefined, undefined);
  return info;
}

// The prose around the JSX element `target` inside its nearest block element. Static text only:
// a dynamic {expression} or a custom component is shown as "…" rather than guessed at.
function jsxSurroundingText(target, info, marker) {
  const meta = info.get(target);
  let block = meta && meta.parent;
  while (block && !BLOCK_TAGS.has(jsxTagName(block.openingElement).toLowerCase())) {
    const m = info.get(block);
    block = m && m.parent;
  }
  if (!block) return '';
  let text = '';
  (function add(children) {
    for (const c of children || []) {
      if (c.type === 'JSXText') text += c.value;
      else if (c.type === 'JSXExpressionContainer') {
        const e = c.expression;
        if (e.type === 'StringLiteral') text += e.value;
        else if (e.type !== 'JSXEmptyExpression') text += ' … ';
      } else if (c.type === 'JSXFragment') add(c.children);
      else if (c.type === 'JSXElement') {
        if (c === target) { text += ' ' + marker + ' '; continue; }
        const nm = jsxTagName(c.openingElement);
        if (/^[a-z]/.test(nm) && !SKIP_TEXT_TAGS.has(nm)) add(c.children);
        else text += ' … ';
      }
    }
  })(block.children);
  return windowAround(text.replace(/\s+/g, ' ').trim(), marker);
}

module.exports = {
  MAX_CONTEXT_CHARS, HEADING_TAGS, BLOCK_TAGS,
  clipText, sanitizeHref, pick, imageFileName, windowAround,
  htmlFigcaption, htmlPath, htmlNearestHeading, htmlSurroundingText,
  jsxTagName, buildJsxInfo, jsxSurroundingText
};
