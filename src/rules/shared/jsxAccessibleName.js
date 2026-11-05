// Minimal accessible-name adapter for Babel JSX trees (the HTML helper in
// accessibleName.js only understands parse5 nodes).
//
// getJsxAccessibleName(element, ast, options?) -> { name, source, unknown }
//   element: a JSXElement (for content) or a JSXOpeningElement (attributes only)
//   options: { content: true, title: true } - set false to skip a step
//   source:  'aria-labelledby' | 'aria-label' | 'content' | 'title' | null
//   unknown: true when a name source exists but cannot be read statically
//            ({expr} values, custom components, a reference to an id that is not in
//            this file). Callers must treat unknown as "named" to avoid false positives.
//
// Priority matches the HTML helper: aria-labelledby, aria-label, content, title. The first
// source that is statically non-empty wins; the first one that is unknown stops the search
// (it may override anything below it); empty/absent sources fall through.
// aria-labelledby is resolved by id within the same file. A reference that matches no
// element here is unknown, not dangling: a JSX file is a fragment of a page and the
// target is often rendered by another component.

const { walkJSX } = require('../../parsers/jsxParser');

const idMaps = new WeakMap();

function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function findAttr(opening, name) {
  return (opening.attributes || []).find(
    a => a.type === 'JSXAttribute' && a.name && a.name.name === name
  );
}

// -> { state: 'absent' } | { state: 'static', text } | { state: 'unknown' }
function attrValue(attr) {
  if (!attr || !attr.value) return { state: 'absent' }; // bare attribute has no string value
  let v = attr.value;
  if (v.type === 'JSXExpressionContainer') v = v.expression;
  if (!v || v.type === 'JSXEmptyExpression') return { state: 'absent' };
  if (v.type === 'StringLiteral') return { state: 'static', text: v.value };
  if (v.type === 'TemplateLiteral' && v.expressions.length === 0) {
    return { state: 'static', text: v.quasis.map(q => q.value.cooked).join('') };
  }
  if (v.type === 'NullLiteral' || (v.type === 'Identifier' && v.name === 'undefined') || v.type === 'BooleanLiteral') {
    return { state: 'absent' };
  }
  return { state: 'unknown' };
}

function elementName(opening) {
  const n = opening.name;
  if (n && n.type === 'JSXIdentifier') return n.name;
  return null; // member expressions (Foo.Bar) are components
}

function isNativeTag(name) {
  return !!name && name[0] === name[0].toLowerCase() && /^[a-z]/.test(name);
}

// Text rendered by a list of JSX children. -> { text, unknown }
function childrenText(children, ctx) {
  let text = '';
  let unknown = false;
  for (const child of children || []) {
    if (child.type === 'JSXText') {
      text += child.value;
    } else if (child.type === 'JSXExpressionContainer') {
      const e = child.expression;
      if (e.type === 'JSXEmptyExpression') continue;
      if (e.type === 'StringLiteral') text += e.value;
      else if (e.type === 'NumericLiteral') text += String(e.value);
      else if (e.type === 'TemplateLiteral' && e.expressions.length === 0) {
        text += e.quasis.map(q => q.value.cooked).join('');
      } else if (e.type === 'NullLiteral' || e.type === 'BooleanLiteral' ||
                 (e.type === 'Identifier' && e.name === 'undefined')) {
        continue; // renders nothing
      } else unknown = true;
    } else if (child.type === 'JSXFragment') {
      const r = childrenText(child.children, ctx);
      text += ' ' + r.text + ' ';
      unknown = unknown || r.unknown;
    } else if (child.type === 'JSXElement') {
      const opening = child.openingElement;
      const name = elementName(opening);
      if (!isNativeTag(name)) { unknown = true; continue; } // custom component: opaque
      const hidden = attrValue(findAttr(opening, 'aria-hidden'));
      if (hidden.state === 'static' && hidden.text === 'true' && !ctx.includeHidden) continue;
      if (findAttr(opening, 'dangerouslySetInnerHTML')) { unknown = true; continue; }
      if (name === 'img') {
        const alt = attrValue(findAttr(opening, 'alt'));
        if (alt.state === 'static') text += ' ' + alt.text + ' ';
        else if (alt.state === 'unknown') unknown = true;
        continue;
      }
      const r = childrenText(child.children, ctx);
      text += ' ' + r.text + ' ';
      unknown = unknown || r.unknown;
    } else {
      unknown = true; // JSXSpreadChild etc.
    }
  }
  return { text: clean(text), unknown };
}

function getIdIndex(ast) {
  if (idMaps.has(ast)) return idMaps.get(ast);
  const byId = new Map();
  let dynamicIds = false;
  walkJSX(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const idAttr = findAttr(node.openingElement, 'id');
    if (!idAttr) return;
    const v = attrValue(idAttr);
    if (v.state === 'static' && v.text) { if (!byId.has(v.text)) byId.set(v.text, node); }
    else if (v.state === 'unknown') dynamicIds = true;
  });
  const idx = { byId, dynamicIds };
  idMaps.set(ast, idx);
  return idx;
}

function getJsxAccessibleName(element, ast, options) {
  const useContent = !options || options.content !== false;
  const useTitle = !options || options.title !== false;
  const none = { name: '', source: null, unknown: false };
  if (!element) return none;
  const opening = element.openingElement || element;

  // 1. aria-labelledby
  const lb = attrValue(findAttr(opening, 'aria-labelledby'));
  if (lb.state === 'unknown') return { name: '', source: 'aria-labelledby', unknown: true };
  if (lb.state === 'static' && lb.text.trim()) {
    const { byId, dynamicIds } = getIdIndex(ast);
    let unknown = dynamicIds;
    let text = '';
    for (const id of lb.text.split(/\s+/).filter(Boolean)) {
      const target = byId.get(id);
      if (!target) { unknown = true; continue; } // target may live in another component/file
      const r = childrenText(target.children, { includeHidden: true });
      text += ' ' + r.text;
      if (r.unknown) unknown = true;
      if (!r.text && !r.unknown) {
        const own = attrValue(findAttr(target.openingElement, 'aria-label'));
        if (own.state === 'static') text += ' ' + own.text;
        else if (own.state === 'unknown') unknown = true;
      }
    }
    text = clean(text);
    if (text) return { name: text, source: 'aria-labelledby', unknown: false };
    if (unknown) return { name: '', source: 'aria-labelledby', unknown: true };
  }

  // 2. aria-label
  const al = attrValue(findAttr(opening, 'aria-label'));
  if (al.state === 'unknown') return { name: '', source: 'aria-label', unknown: true };
  if (al.state === 'static' && clean(al.text)) return { name: clean(al.text), source: 'aria-label', unknown: false };

  // 3. content
  if (useContent && element.children) {
    const r = childrenText(element.children, { includeHidden: false });
    // Any dynamic part makes the whole name unknown ("click here {x}" is not "click here").
    if (r.unknown) return { name: '', source: 'content', unknown: true };
    if (r.text) return { name: r.text, source: 'content', unknown: false };
  }

  // 4. title
  if (useTitle) {
    const t = attrValue(findAttr(opening, 'title'));
    if (t.state === 'unknown') return { name: '', source: 'title', unknown: true };
    if (t.state === 'static' && clean(t.text)) return { name: clean(t.text), source: 'title', unknown: false };
  }

  return none;
}

module.exports = { getJsxAccessibleName, findAttr, attrValue };
