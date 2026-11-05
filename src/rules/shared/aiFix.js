// Source-editing helpers for the AI-suggested fixes (img-alt-missing, jsx-img-alt-missing,
// anchor-no-text, jsx-anchor-no-content). Pure string work: no vscode, no network.
//
// A fix() returns one of:
//   { newText, range, suggestion }   the edit to preview; range = { startLine, startChar, endLine, endChar }
//   { unavailable: '<one line>' }    nothing sensible can be offered for this element, and why
//   null                             the element is no longer where the violation says (stale scan)
//
// Where the edit goes, per element:
//   <img> / <Img>   insert alt="..." into the start tag (no alt attribute exists at all)
//   <a>, no visible text (empty or icon only)
//                   insert aria-label="..." into the start tag: nothing visible changes, and there is
//                   no visible text for a label to contradict (WCAG 2.5.3)
//   <a>, one text child that is a generic phrase or a bare URL ("click here", "https://...")
//                   replace that text with the suggestion
//   anything else (mixed content, an existing aria-label, spread props, ...) -> unavailable: guessing
//                   at those would risk deleting content or overriding a name that is already there

const { parseHTML, walkNode } = require('../../parsers/htmlParser');
const { parseJSX, walkJSX } = require('../../parsers/jsxParser');
const { isGenericLinkText, isUrlLinkText } = require('./genericLinkText');
const { jsxTagName } = require('./elementContext');

const MAX_ALT_CHARS = 150;
const MAX_LINK_CHARS = 80;

// ---- offsets <-> positions ------------------------------------------------------------------------
function offsetToPos(src, offset) {
  let line = 0, last = 0;
  const re = /\r\n|\r|\n/g;
  let m;
  while ((m = re.exec(src)) && m.index + m[0].length <= offset) { line++; last = m.index + m[0].length; }
  return { line, character: offset - last };
}

function rangeOf(src, startOffset, endOffset) {
  const a = offsetToPos(src, startOffset), b = offsetToPos(src, endOffset);
  return { startLine: a.line, startChar: a.character, endLine: b.line, endChar: b.character };
}

// ---- suggestion hygiene ---------------------------------------------------------------------------
const FILE_EXT = /\.(jpe?g|png|gif|svg|webp|bmp|avif|tiff?|ico|heic)\b/i;
const GENERIC_ALT = /^(image|photo|picture|graphic|icon|logo|banner|img|thumbnail)$/i;

// Alt text: no leading "image of ...", no file name, not a lone generic noun. null = not usable.
function cleanAltSuggestion(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(an?\s+)?(image|picture|photo|photograph|graphic|screenshot)\s+(of|showing)\s+/i, '');
  t = t.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (!t) return null;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (FILE_EXT.test(t) || GENERIC_ALT.test(t)) return null;
  return t.length > MAX_ALT_CHARS ? t.slice(0, MAX_ALT_CHARS).replace(/\s+\S*$/, '').trim() : t;
}

// Link text: concise, and not itself a generic phrase or a URL (that would just re-create the violation).
function cleanLinkSuggestion(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (!t) return null;
  if (isGenericLinkText(t) || isUrlLinkText(t)) return null;
  return t.length > MAX_LINK_CHARS ? t.slice(0, MAX_LINK_CHARS).replace(/\s+\S*$/, '').trim() : t;
}

// ---- escaping -------------------------------------------------------------------------------------
const htmlAttrEscape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlTextEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// JSX: a plain string attribute / text when nothing in it needs escaping, otherwise a JS expression.
function jsxAttribute(name, value) {
  return /^[^"&<>{}\\\r\n]*$/.test(value) ? name + '="' + value + '"' : name + '={' + JSON.stringify(value) + '}';
}
function jsxText(value) {
  return /^[^{}<>&\r\n]*$/.test(value) ? value : '{' + JSON.stringify(value) + '}';
}

// ---- inserting an attribute into a start tag -----------------------------------------------------
// `<img src="x">` -> `<img src="x" alt="...">`, `<img src="x" />` -> `<img src="x" alt="..." />`
function insertAttribute(tagText, attribute) {
  const end = tagText.match(/\s*\/?>$/);
  const at = end ? tagText.length - end[0].length : tagText.length;
  return tagText.slice(0, at) + ' ' + attribute + tagText.slice(at);
}

// ---- HTML -----------------------------------------------------------------------------------------
const htmlAttr = (node, name) => (node.attrs || []).find(a => a.name === name);

// The element whose START TAG begins where the violation does.
function findHtmlElement(sourceCode, violation, tagName) {
  const ast = parseHTML(sourceCode);
  if (!ast) return null;
  let found = null;
  walkNode(ast, (n) => {
    if (found || n.tagName !== tagName) return;
    const t = n.sourceCodeLocation && n.sourceCodeLocation.startTag;
    if (t && t.startLine - 1 === violation.startLine && t.startCol - 1 === violation.startChar) found = n;
  });
  return found ? { ast, node: found } : null;
}

function htmlAddAttribute(sourceCode, node, name, value) {
  const t = node.sourceCodeLocation.startTag;
  const tag = sourceCode.slice(t.startOffset, t.endOffset);
  return { newText: insertAttribute(tag, name + '="' + htmlAttrEscape(value) + '"'), range: rangeOf(sourceCode, t.startOffset, t.endOffset) };
}

// Replace everything between the start and end tag. null when there is no explicit end tag.
function htmlReplaceInner(sourceCode, node, text) {
  const loc = node.sourceCodeLocation;
  if (!loc || !loc.startTag || !loc.endTag) return null;
  return { newText: htmlTextEscape(text), range: rangeOf(sourceCode, loc.startTag.endOffset, loc.endTag.startOffset) };
}

// -> { kind: 'attribute' } | { kind: 'text', text } | { kind: 'unsupported', why }
function classifyHtmlAnchor(node) {
  if (htmlAttr(node, 'aria-label') || htmlAttr(node, 'aria-labelledby')) {
    return { kind: 'unsupported', why: 'it already has an aria-label or aria-labelledby; edit that by hand' };
  }
  const kids = (node.childNodes || []).filter(c => c.nodeName !== '#comment' && !(c.nodeName === '#text' && !(c.value || '').trim()));
  if (kids.length === 0) return { kind: 'attribute' };
  const visibleText = (function text(n) {
    return (n.childNodes || []).map(c => (c.nodeName === '#text' ? c.value || '' : c.tagName ? text(c) : '')).join('');
  })(node).trim();
  if (!visibleText) return { kind: 'attribute' }; // icon only
  if (kids.length === 1 && kids[0].nodeName === '#text' && (isGenericLinkText(visibleText) || isUrlLinkText(visibleText))) {
    return { kind: 'text', text: visibleText };
  }
  return { kind: 'unsupported', why: 'its content is more than one plain text phrase; reword it by hand' };
}

// ---- JSX ------------------------------------------------------------------------------------------
const jsxAttrNode = (opening, name) => (opening.attributes || []).find(a => a.type === 'JSXAttribute' && a.name && a.name.name === name);
const hasJsxSpread = (opening) => (opening.attributes || []).some(a => a.type === 'JSXSpreadAttribute');

// The JSXElement whose OPENING element begins where the violation does.
function findJsxElement(sourceCode, violation) {
  const ast = parseJSX(sourceCode);
  if (!ast) return null;
  let found = null;
  walkJSX(ast, (n) => {
    if (found || n.type !== 'JSXElement' || !n.openingElement || !n.openingElement.loc) return;
    const l = n.openingElement.loc.start;
    if (l.line - 1 === violation.startLine && l.column === violation.startChar) found = n;
  });
  return found ? { ast, node: found } : null;
}

function jsxAddAttribute(sourceCode, node, name, value) {
  const o = node.openingElement;
  const tag = sourceCode.slice(o.start, o.end);
  return { newText: insertAttribute(tag, jsxAttribute(name, value)), range: rangeOf(sourceCode, o.start, o.end) };
}

function jsxReplaceChildren(sourceCode, node, text) {
  if (!node.closingElement) return null;
  return { newText: jsxText(text), range: rangeOf(sourceCode, node.openingElement.end, node.closingElement.start) };
}

// Static text of one child, or null.
function staticChildText(c) {
  if (c.type === 'JSXText') return c.value;
  if (c.type === 'JSXExpressionContainer') {
    const e = c.expression;
    if (e.type === 'StringLiteral') return e.value;
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis.map(q => q.value.cooked).join('');
  }
  return null;
}

// -> { kind: 'attribute' } | { kind: 'text', text } | { kind: 'unsupported', why }
function classifyJsxAnchor(node) {
  const opening = node.openingElement;
  if (hasJsxSpread(opening)) return { kind: 'unsupported', why: 'it spreads props, which may already supply the name' };
  if (jsxAttrNode(opening, 'aria-label') || jsxAttrNode(opening, 'aria-labelledby')) {
    return { kind: 'unsupported', why: 'it already has an aria-label or aria-labelledby; edit that by hand' };
  }
  const kids = (node.children || []).filter(c => !(c.type === 'JSXText' && !c.value.trim()) && !(c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression'));
  if (kids.length === 0) return { kind: 'attribute' };
  if (kids.length === 1) {
    const t = staticChildText(kids[0]);
    if (t !== null && t.trim() && (isGenericLinkText(t) || isUrlLinkText(t))) return { kind: 'text', text: t.trim() };
  }
  // Only element children with no text anywhere (an icon): nothing visible to contradict.
  const hasText = (function scan(list) {
    return list.some(c => {
      if (c.type === 'JSXText') return !!c.value.trim();
      if (c.type === 'JSXExpressionContainer') return c.expression.type !== 'JSXEmptyExpression';
      if (c.type === 'JSXElement') return scan(c.children || []);
      return true;
    });
  })(kids);
  if (!hasText) return { kind: 'attribute' };
  return { kind: 'unsupported', why: 'its content is more than one plain text phrase; reword it by hand' };
}

module.exports = {
  MAX_ALT_CHARS, MAX_LINK_CHARS,
  offsetToPos, rangeOf, insertAttribute,
  cleanAltSuggestion, cleanLinkSuggestion,
  htmlAttrEscape, htmlTextEscape, jsxAttribute, jsxText,
  htmlAttr, findHtmlElement, htmlAddAttribute, htmlReplaceInner, classifyHtmlAnchor,
  jsxAttrNode, hasJsxSpread, findJsxElement, jsxAddAttribute, jsxReplaceChildren, classifyJsxAnchor, jsxTagName
};
