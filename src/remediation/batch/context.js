// Everything a model needs to fix the issues of ONE file correctly, gathered locally and deterministically.
// Pure and vscode-free: assets (images) are read through the injected readAsset().
//
// buildFileContext({ source, languageId, violations, fileName, readAsset, projectFacts }) -> {
//   language, file: { ...file-wide facts },
//   issues: [{ id, ruleId, severity, wcag, line, endLine, problem, why, linterHint, guidance,
//              flagged, region: { kind, startLine, endLine, text }, facts, image, offsets: { start, end } }]
// }
//
// The per-issue facts are what a careful engineer would look up before fixing: the element's attributes and
// computed accessible name, icon names and handler names that reveal purpose, the visible text next to a form
// control, every reference to a duplicated id, the heading outline, verified passing colors for a contrast issue,
// whether the file already has a reduced-motion block, and for an image the image itself.

const path = require('path');
const crypto = require('crypto');
const { parseHTML, walkNode } = require('../../parsers/htmlParser');
const { parseJSX, walkJSX } = require('../../parsers/jsxParser');
const { parseCSS } = require('../../parsers/cssParser');
const { getAccessibleName } = require('../../rules/shared/accessibleName');
const { getJsxAccessibleName } = require('../../rules/shared/jsxAccessibleName');
const ec = require('../../rules/shared/elementContext');
const { lineStarts, offsetOf } = require('../../rules/shared/genericContext');
const colorMath = require('../../rules/shared/colorMath');
const { guideFor } = require('./guidance');

const MAX_FLAGGED = 1500;
const MAX_REGION = 2600;
const MAX_TABLE_REGION = 8000;
const MAX_FORM_REGION = 4000;
const MAX_ATTR_VALUE = 120;
const MAX_IMAGES_PER_FILE = 6;
const IMAGE_RULES = new Set(['img-alt-missing', 'jsx-img-alt-missing']);
const SR_ONLY_CLASSES = ['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screenreader-only', 'a11y-hidden'];
const ICON_HINT = /(icon|^fa-|^fa$|^bi-|^mdi-|material|glyph|^ri-|^ti-|^lucide|^heroicon|^ion-|^svg)/i;

const LANGUAGE_OF = { html: 'html', javascriptreact: 'jsx', typescriptreact: 'jsx', css: 'css' };

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---- element ranges per language ---------------------------------------------------------------
function htmlElements(ast) {
  const out = [];
  walkNode(ast, (n) => {
    const l = n.tagName && n.sourceCodeLocation;
    if (l && Number.isInteger(l.startOffset) && Number.isInteger(l.endOffset)) out.push({ start: l.startOffset, end: l.endOffset, tag: n.tagName, node: n });
  });
  return out;
}

function jsxElements(ast) {
  const out = [];
  walkJSX(ast, (n) => {
    if (n.type === 'JSXElement' && Number.isInteger(n.start) && Number.isInteger(n.end)) {
      out.push({ start: n.start, end: n.end, tag: ec.jsxTagName(n.openingElement), node: n });
    }
  });
  return out;
}

function cssBlocks(root) {
  const out = [];
  root.walk((n) => {
    const a = n.source && n.source.start, b = n.source && n.source.end;
    if ((n.type === 'rule' || n.type === 'atrule') && a && b && Number.isInteger(a.offset) && Number.isInteger(b.offset)) {
      out.push({ start: a.offset, end: b.offset, tag: n.type === 'rule' ? n.selector : '@' + n.name, node: n });
    }
  });
  return out;
}

function containing(list, s, e) {
  return list.filter(c => c.start <= s && c.end >= e).sort((a, b) => (a.end - a.start) - (b.end - b.start));
}

// The element the violation is about: the one whose start is the violation start, else the innermost container.
function targetOf(list, s, e) {
  const exact = list.filter(c => c.start === s).sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return exact[0] || containing(list, s, e)[0] || null;
}

function pickRegion(kind, list, s, e, source) {
  const chain = containing(list, s, e);
  if (!chain.length) return null;
  const size = (c) => c.end - c.start;
  if (kind === 'table') {
    const t = chain.find(c => String(c.tag).toLowerCase() === 'table');
    if (t && size(t) <= MAX_TABLE_REGION) return t;
  }
  if (kind === 'form') {
    const f = chain.find(c => String(c.tag).toLowerCase() === 'form');
    if (f && size(f) <= MAX_FORM_REGION) return f;
    kind = 'parent';
  }
  if (kind === 'parent') {
    // The nearest ancestor that adds real surroundings (where a label or caption usually is); one level further only
    // when the parent is little more than a wrapper around the element.
    const fits = (c) => c && size(c) <= MAX_REGION;
    const [self, parent, grand] = chain;
    const visibleAround = (p) => (source.slice(p.start, self.start) + source.slice(self.end, p.end)).replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, ' ');
    if (fits(parent) && !/\w{2}/.test(visibleAround(parent)) && fits(grand)) return grand;
    if (fits(parent)) return parent;
    return fits(self) ? self : null;
  }
  return size(chain[0]) <= MAX_REGION ? chain[0] : null;
}

function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function lineWindowRange(source, starts, s, e) {
  const from = Math.max(0, lineOf(starts, s) - 6);
  const to = Math.min(starts.length - 1, lineOf(starts, e) + 6);
  let a = starts[from];
  let b = to + 1 < starts.length ? starts[to + 1] : source.length;
  if (b - a > MAX_REGION) { a = Math.max(a, s - MAX_REGION / 2); b = Math.min(b, a + MAX_REGION); }
  return { start: a, end: b };
}

// ---- HTML facts -------------------------------------------------------------------------------
const hAttr = (n, name) => { const a = (n.attrs || []).find(x => x.name === name); return a ? a.value : undefined; };

function htmlAttrs(n) {
  return (n.attrs || []).slice(0, 25).map(a => a.name + (a.value !== '' ? '=' + JSON.stringify(clip(a.value, MAX_ATTR_VALUE)) : ''));
}

function htmlIconHints(n) {
  const hints = new Set();
  walkNode(n, (c) => {
    if (!c.tagName || c === n) return;
    for (const cls of String(hAttr(c, 'class') || '').split(/\s+/)) if (cls && ICON_HINT.test(cls)) hints.add('class ' + cls);
    if (c.tagName === 'title' && c.childNodes && c.childNodes[0] && c.childNodes[0].value) hints.add('svg title "' + clip(c.childNodes[0].value, 60) + '"');
    if (c.tagName === 'use' && (hAttr(c, 'href') || hAttr(c, 'xlink:href'))) hints.add('svg use ' + clip(hAttr(c, 'href') || hAttr(c, 'xlink:href'), 60));
    if (c.tagName === 'img') hints.add('img src ' + ec.imageFileName(hAttr(c, 'src')) + (hAttr(c, 'alt') !== undefined ? ' alt="' + clip(hAttr(c, 'alt'), 60) + '"' : ''));
    if (c.tagName === 'svg') hints.add('inline <svg>' + (hAttr(c, 'aria-hidden') ? ' aria-hidden=' + hAttr(c, 'aria-hidden') : ''));
  });
  for (const k of ['class', 'id', 'name', 'data-action', 'data-testid']) if (hAttr(n, k)) hints.add(k + ' ' + clip(hAttr(n, k), 60));
  return [...hints].slice(0, 12);
}

function htmlHandlers(n) {
  return (n.attrs || []).filter(a => /^on/i.test(a.name)).map(a => a.name + '="' + clip(a.value, 80) + '"');
}

function closestAncestor(n, tags) {
  for (let p = n.parentNode; p; p = p.parentNode) if (p.tagName && tags.includes(p.tagName)) return p;
  return null;
}

// Text of one sibling node, or '' (whitespace, comments, scripts).
function nodeText(c, ast) {
  if (c.nodeName === '#text') return clip(c.value, 80);
  if (!c.tagName || ['script', 'style', 'template'].includes(c.tagName)) return '';
  return clip(getAccessibleName(c, ast).name, 80);
}

// The nearest visible text before / after an element among its siblings: where an unassociated label or a
// caption usually sits. Only the nearest one: text further away is about something else.
function siblingText(n, dir) {
  const kids = (n.parentNode && n.parentNode.childNodes) || [];
  const i = kids.indexOf(n);
  for (let j = i + dir; j >= 0 && j < kids.length; j += dir) {
    const c = kids[j];
    // Only plain or inline text can be this element's label or caption; a block or another control is something else.
    if (c.tagName && !INLINE_TEXT.has(c.tagName)) return '';
    const t = nodeText(c, null);
    if (t) return t;
  }
  return '';
}
const INLINE_TEXT = new Set(['span', 'label', 'strong', 'b', 'em', 'i', 'small', 'abbr', 'mark', 'code', 'sup', 'sub']);
const htmlPrecedingText = (n) => siblingText(n, -1);
const htmlFollowingText = (n) => siblingText(n, 1);

// Text around an element. Inside a small text block (a paragraph, list item, cell, label, heading) that block's text
// with the element marked; directly in a large container (body, section, div) only the nearest neighbours, because
// the rest of the container's text is about other things.
const SMALL_BLOCKS = new Set(['p', 'li', 'td', 'th', 'dt', 'dd', 'label', 'legend', 'caption', 'figcaption', 'figure', 'blockquote', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
function htmlNearby(n, marker) {
  if (n.parentNode && SMALL_BLOCKS.has(n.parentNode.tagName)) return ec.htmlSurroundingText(n, marker);
  const before = siblingText(n, -1), after = siblingText(n, 1);
  return before || after ? clip((before ? before + ' ' : '') + marker + (after ? ' ' + after : ''), 200) : '';
}

// The controls of a form, described by what identifies them: "input type=email (named "Email")".
function htmlFormFields(form, ast) {
  const out = [];
  walkNode(form, (c) => {
    if (out.length >= 10 || !['input', 'select', 'textarea', 'button'].includes(c.tagName)) return;
    const name = getAccessibleName(c, ast).name;
    const bits = [c.tagName + (hAttr(c, 'type') ? ' type=' + hAttr(c, 'type') : '')];
    for (const k of ['id', 'name', 'placeholder']) if (hAttr(c, k)) bits.push(k + '=' + clip(hAttr(c, k), 40));
    bits.push(name ? 'named "' + clip(name, 40) + '"' : 'no name');
    out.push(bits.join(' '));
  });
  return out;
}

function htmlHeadingOutline(ast, starts) {
  const out = [];
  walkNode(ast, (n) => {
    if (!n.tagName || !/^h[1-6]$/.test(n.tagName) || out.length >= 40) return;
    const l = n.sourceCodeLocation;
    out.push('line ' + (l ? l.startLine : '?') + ' ' + n.tagName + ': ' + clip(getAccessibleName(n, ast).name || '(empty)', 70));
  });
  return out;
}

function htmlIdIndex(ast) {
  const ids = new Map();
  const refs = [];
  walkNode(ast, (n) => {
    if (!n.tagName) return;
    const line = n.sourceCodeLocation ? n.sourceCodeLocation.startLine : 0;
    const id = hAttr(n, 'id');
    if (id) { if (!ids.has(id)) ids.set(id, []); ids.get(id).push(line); }
    for (const a of n.attrs || []) {
      if (['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'list', 'form', 'headers'].includes(a.name)) {
        for (const v of String(a.value).split(/\s+/).filter(Boolean)) refs.push({ id: v, line, via: a.name, tag: n.tagName });
      } else if ((a.name === 'href' || a.name === 'xlink:href') && String(a.value).startsWith('#') && a.value.length > 1) {
        refs.push({ id: a.value.slice(1), line, via: a.name, tag: n.tagName });
      }
    }
  });
  return { ids, refs };
}

function bodyTextSample(ast) {
  let text = '';
  walkNode(ast, (n) => {
    if (text.length > 400) return;
    if (n.nodeName === '#text' && n.parentNode && !['script', 'style', 'title'].includes(n.parentNode.tagName)) text += ' ' + n.value;
  });
  return clip(text, 300);
}

function htmlFacts(rule, t, ast, idx, imageNote) {
  const n = t.node;
  const f = { element: '<' + n.tagName + '>', attributes: htmlAttrs(n) };
  // A form control is named by its label or aria-*, never by its content (a <select>'s options are not its name).
  const name = getAccessibleName(n, ast, ['select', 'textarea', 'input'].includes(n.tagName) ? { content: false } : undefined);
  f.accessibleName = name.name ? clip(name.name, 120) + ' (from ' + name.source + ')' : '(none)';
  const interactive = closestAncestor(n, ['a', 'button']);
  if (interactive) f.insideInteractive = '<' + interactive.tagName + '>' + (hAttr(interactive, 'href') ? ' href=' + ec.sanitizeHref(hAttr(interactive, 'href')) : '') + ', its other text: ' + JSON.stringify(clip(getAccessibleName(interactive, ast).name, 100));

  if (n.tagName === 'img' || IMAGE_RULES.has(rule)) {
    f.imageFileName = ec.imageFileName(hAttr(n, 'src')) || '(none)';
    const fig = ec.htmlFigcaption(n, ast); if (fig) f.figcaption = fig;
    const heading = ec.htmlNearestHeading(ast, n); if (heading) f.nearestHeading = heading;
    const around = htmlNearby(n, '[IMAGE]'); if (around) f.surroundingText = around;
    f.image = imageNote;
  }
  if (['a', 'button'].includes(n.tagName) || /anchor|button|div-used/.test(rule)) {
    const hints = htmlIconHints(n); if (hints.length) f.purposeHints = hints;
    const handlers = htmlHandlers(n); if (handlers.length) f.handlers = handlers;
    if (hAttr(n, 'href') !== undefined) f.href = ec.sanitizeHref(hAttr(n, 'href')) || '(none or script)';
    const around = htmlNearby(n, '[ELEMENT]'); if (around) f.surroundingText = around;
    const heading = ec.htmlNearestHeading(ast, n); if (heading) f.nearestHeading = heading;
    if (closestAncestor(n, ['form'])) f.insideForm = true;
  }
  if (['input', 'select', 'textarea'].includes(n.tagName) || /label/.test(rule)) {
    const before = htmlPrecedingText(n); if (before) f.visibleTextBeforeControl = before;
    const after = htmlFollowingText(n); if (after) f.visibleTextAfterControl = after;
    const id = hAttr(n, 'id');
    f.controlId = id || '(none: add a unique id if a <label for> is used)';
    if (id) f.labelsPointingHere = idx.refs.filter(r => r.id === id && r.via === 'for').map(r => 'line ' + r.line);
    const wrap = closestAncestor(n, ['label']); if (wrap) f.wrappedInLabel = true;
    if (n.tagName === 'select') {
      const opts = []; walkNode(n, (c) => { if (c.tagName === 'option' && opts.length < 8) opts.push(clip(getAccessibleName(c, ast).name || hAttr(c, 'value') || '', 40)); });
      if (opts.length) f.optionTexts = opts;
    }
    for (const k of ['name', 'type', 'placeholder', 'autocomplete']) if (hAttr(n, k)) f[k] = hAttr(n, k);
  }
  const form = n.tagName === 'form' ? n : closestAncestor(n, ['form']);
  if (form && (rule === 'form-missing-landmark' || n.tagName === 'button' || /label/.test(rule))) {
    f.formFields = htmlFormFields(form, ast);
    if (hAttr(form, 'action')) f.formAction = ec.sanitizeHref(hAttr(form, 'action')) || '(script)';
  }
  if (n.tagName === 'button') f.buttonType = hAttr(n, 'type') || (form ? 'submit (default inside a form)' : '(none)');
  if (rule === 'form-missing-landmark') {
    const heading = ec.htmlNearestHeading(ast, n); if (heading) f.nearestHeading = heading;
    const submit = []; walkNode(n, (c) => { if ((c.tagName === 'button' || (c.tagName === 'input' && /submit/i.test(hAttr(c, 'type') || ''))) && submit.length < 3) submit.push(clip(getAccessibleName(c, ast).name || hAttr(c, 'value') || '', 40)); });
    if (submit.length) f.submitButtons = submit;
  }
  if (rule === 'iframe-missing-title') {
    f.src = ec.sanitizeHref(hAttr(n, 'src')) || '(none)';
    const heading = ec.htmlNearestHeading(ast, n); if (heading) f.nearestHeading = heading;
  }
  if (rule === 'duplicate-id') {
    const id = hAttr(n, 'id');
    f.duplicatedId = id;
    f.occurrences = (idx.ids.get(id) || []).map(l => 'line ' + l);
    f.references = idx.refs.filter(r => r.id === id).map(r => 'line ' + r.line + ' <' + r.tag + '> ' + r.via);
  }
  return f;
}

// ---- JSX facts --------------------------------------------------------------------------------
function jsxAttrs(opening, source) {
  return (opening.attributes || []).slice(0, 25).map(a => clip(source.slice(a.start, a.end), MAX_ATTR_VALUE + 20));
}

function jsxIconHints(node, source) {
  const hints = new Set();
  (function scan(list) {
    for (const c of list || []) {
      if (c.type !== 'JSXElement') continue;
      const name = ec.jsxTagName(c.openingElement);
      if (/^[A-Z]/.test(name)) hints.add('component <' + name + '>');
      for (const a of c.openingElement.attributes || []) {
        if (a.type === 'JSXAttribute' && a.name && ['className', 'class', 'name', 'icon', 'src', 'title'].includes(a.name.name) && a.value) {
          hints.add(a.name.name + ' ' + clip(source.slice(a.value.start, a.value.end), 60));
        }
      }
      scan(c.children);
    }
  })(node.children);
  for (const a of node.openingElement.attributes || []) {
    if (a.type === 'JSXAttribute' && a.name && ['className', 'id', 'data-testid', 'name'].includes(a.name.name) && a.value) {
      hints.add(a.name.name + ' ' + clip(source.slice(a.value.start, a.value.end), 60));
    }
  }
  return [...hints].slice(0, 12);
}

function jsxHandlers(opening, source) {
  return (opening.attributes || []).filter(a => a.type === 'JSXAttribute' && a.name && /^on[A-Z]/.test(a.name.name))
    .map(a => clip(source.slice(a.start, a.end), 120));
}

function jsxFacts(rule, t, ast, info, source, imageNote) {
  const n = t.node;
  const o = n.openingElement;
  const tag = ec.jsxTagName(o);
  const f = { element: '<' + tag + '>' + (/^[A-Z]/.test(tag) ? ' (a component: its own props decide what it renders)' : ''), props: jsxAttrs(o, source) };
  if ((o.attributes || []).some(a => a.type === 'JSXSpreadAttribute')) f.spreadProps = 'yes: props may already supply a name or handler';
  const name = getJsxAccessibleName(n, ast);
  f.accessibleName = name.unknown ? '(dynamic: set at runtime)' : (name.name ? clip(name.name, 120) + ' (from ' + name.source + ')' : '(none)');
  const meta = info.get(n) || {};
  if (meta.nearestHeading) f.nearestHeading = meta.nearestHeading;
  const around = ec.jsxSurroundingText(n, info, IMAGE_RULES.has(rule) ? '[IMAGE]' : '[ELEMENT]');
  if (around) f.surroundingText = around;
  if (IMAGE_RULES.has(rule)) {
    const src = (o.attributes || []).find(a => a.type === 'JSXAttribute' && a.name && a.name.name === 'src');
    f.imageSrc = src && src.value ? clip(source.slice(src.value.start, src.value.end), 120) : '(none)';
    if (meta.figcaption) f.figcaption = meta.figcaption;
    f.image = imageNote;
  } else {
    const hints = jsxIconHints(n, source); if (hints.length) f.purposeHints = hints;
    const handlers = jsxHandlers(o, source); if (handlers.length) f.handlers = handlers;
  }
  if (meta.parent) f.parentElement = '<' + ec.jsxTagName(meta.parent.openingElement) + '>';
  return f;
}

function jsxHeadingOutline(ast, source) {
  const out = [];
  walkJSX(ast, (n) => {
    if (n.type !== 'JSXElement' || out.length >= 40) return;
    const tag = ec.jsxTagName(n.openingElement);
    if (!/^h[1-6]$/.test(tag)) return;
    const r = getJsxAccessibleName(n, ast, { title: false });
    out.push('line ' + n.loc.start.line + ' ' + tag + ': ' + (r.unknown ? '(dynamic)' : clip(r.name || '(empty)', 70)));
  });
  return out;
}

function jsxIds(ast) {
  const ids = [];
  walkJSX(ast, (n) => {
    if (n.type === 'JSXAttribute' && n.name && n.name.name === 'id' && n.value && n.value.type === 'StringLiteral') ids.push(n.value.value);
  });
  return ids;
}

// ---- CSS facts --------------------------------------------------------------------------------
function cssFacts(rule, t, root, source) {
  const n = t.node;
  const f = { selector: n.type === 'rule' ? n.selector : '@' + n.name + ' ' + n.params };
  const parent = n.parent && n.parent.type === 'atrule' ? '@' + n.parent.name + ' ' + n.parent.params : null;
  if (parent) f.insideAtRule = parent;
  f.declarations = (n.nodes || []).filter(d => d.type === 'decl').slice(0, 30).map(d => d.prop + ': ' + clip(d.value, 80));
  if (rule === 'color-contrast-low' && n.type === 'rule') {
    const { contrastFacts } = require('../../rules/css/color-contrast-low');
    const c = contrastFacts(n);
    if (c) {
      f.contrast = 'text ' + c.fgValue + ' on background ' + c.bgValue + ' = ' + c.ratio.toFixed(2) + ':1; required ' + c.required + ':1' + (c.large ? ' (large text)' : ' (normal text; 3:1 would apply only at 24px or 18.66px bold)');
      const passing = colorMath.suggestPassingColors(c.fg, c.bg, c.required);
      f.passingTextColors = passing.length ? passing.map(p => p.hex + ' (' + p.ratio + ':1, ' + p.direction + ')') : ['(no text color reaches it on this background: change the background)'];
      const bgPassing = colorMath.suggestPassingColors(c.bg, c.fg, c.required);
      if (bgPassing.length) f.passingBackgroundColors = bgPassing.map(p => p.hex + ' (' + p.ratio + ':1, ' + p.direction + ')');
    }
  }
  if (rule === 'motion-no-preference-check') {
    f.fileHasReducedMotionQuery = /prefers-reduced-motion/.test(source) ? 'yes: add the selector to the existing block' : 'no';
  }
  if (rule === 'focus-visible-missing' || rule === 'outline-removed') {
    const fv = [];
    root.walkRules((r) => { if (/:focus-visible/.test(r.selector) && fv.length < 10) fv.push(r.selector); });
    f.existingFocusVisibleSelectors = fv.length ? fv : ['(none)'];
    const bg = (n.nodes || []).find(d => d.type === 'decl' && /^background(-color)?$/.test(d.prop));
    if (bg) f.backgroundOfThisRule = bg.value;
  }
  return f;
}

// ---- file-wide facts ---------------------------------------------------------------------------
function detectIndent(source) {
  const lines = source.split(/\r?\n/).filter(l => /^\s+\S/.test(l)).slice(0, 200);
  if (!lines.length) return 'unknown';
  const tabs = lines.filter(l => l.startsWith('\t')).length;
  if (tabs > lines.length / 2) return 'tabs';
  const widths = lines.map(l => l.match(/^ +/)).filter(Boolean).map(m => m[0].length);
  const two = widths.filter(w => w % 2 === 0 && w % 4 !== 0).length;
  return two > 0 ? '2 spaces' : '4 spaces';
}

function fileFacts(language, languageId, source, fileName, parsed, projectFacts) {
  const f = {
    fileName: path.basename(fileName || '(untitled)'),
    language: language === 'jsx' ? (languageId === 'typescriptreact' ? 'TSX (React + TypeScript)' : 'JSX (React)') : language.toUpperCase(),
    lineEndings: /\r\n/.test(source) ? 'CRLF' : 'LF',
    indentation: detectIndent(source)
  };
  const srOnly = SR_ONLY_CLASSES.filter(c => source.includes(c) || (projectFacts && (projectFacts.srOnlyClasses || []).includes(c)));
  f.visuallyHiddenUtility = srOnly.length ? srOnly.join(', ') + ' (exists in the project: use it for visually hidden text)' : 'none found (prefer aria-label)';
  if (projectFacts && projectFacts.tailwind) f.cssFramework = 'Tailwind CSS (sr-only is available)';
  if (language === 'html' && parsed) {
    const htmlEl = []; walkNode(parsed, (n) => { if (n.tagName === 'html') htmlEl.push(n); });
    f.documentLang = htmlEl[0] ? (hAttr(htmlEl[0], 'lang') || '(missing)') : '(fragment: no <html>)';
    const title = []; walkNode(parsed, (n) => { if (n.tagName === 'title' && !title.length) title.push(getAccessibleName(n, parsed).name || (n.childNodes && n.childNodes[0] && n.childNodes[0].value) || ''); });
    if (title[0]) f.pageTitle = clip(title[0], 120);
    f.headingOutline = htmlHeadingOutline(parsed);
    f.idsInFile = [...htmlIdIndex(parsed).ids.keys()].slice(0, 150);
    f.pageTextSample = bodyTextSample(parsed);
  }
  if (language === 'jsx' && parsed) {
    const imports = (parsed.program && parsed.program.body || []).filter(s => s.type === 'ImportDeclaration').map(s => s.source.value).slice(0, 25);
    if (imports.length) f.imports = imports;
    if (imports.some(i => /^next\//.test(i))) f.framework = 'Next.js';
    f.headingOutline = jsxHeadingOutline(parsed, source);
    f.idsInFile = jsxIds(parsed).slice(0, 150);
  }
  return f;
}

// ---- main ------------------------------------------------------------------------------------------
function buildFileContext({ source, languageId, violations, fileName, readAsset, projectFacts }) {
  const language = LANGUAGE_OF[languageId];
  if (!language) return null;
  const starts = lineStarts(source);
  let parsed = null, elements = [], jsxInfo = null, idx = null;
  try {
    if (language === 'html') { parsed = parseHTML(source); elements = parsed ? htmlElements(parsed) : []; idx = parsed ? htmlIdIndex(parsed) : { ids: new Map(), refs: [] }; }
    else if (language === 'jsx') { parsed = parseJSX(source); elements = parsed ? jsxElements(parsed) : []; jsxInfo = parsed ? ec.buildJsxInfo(parsed) : new WeakMap(); }
    else { parsed = parseCSS(source); elements = parsed ? cssBlocks(parsed) : []; }
  } catch (e) { elements = []; }

  let images = 0;
  const issues = violations.map((v, i) => {
    const s = offsetOf(starts, source, v.startLine, v.startChar);
    const e = Math.max(s, offsetOf(starts, source, v.endLine, v.endChar));
    const guide = guideFor(v.ruleId);
    const target = targetOf(elements, s, e);
    const regionNode = pickRegion(guide.region, elements, s, e, source);
    const reg = regionNode ? { start: regionNode.start, end: regionNode.end } : lineWindowRange(source, starts, s, e);
    const msg = v.message || {};

    let image = null;
    let imageNote;
    if (IMAGE_RULES.has(v.ruleId) && typeof readAsset === 'function' && target && images < MAX_IMAGES_PER_FILE) {
      const src = language === 'html' ? hAttr(target.node, 'src') : jsxStaticSrc(target.node);
      try { image = src ? readAsset(src) : null; } catch (err) { image = null; }
      if (image) images++;
    }
    if (IMAGE_RULES.has(v.ruleId)) {
      imageNote = image ? (image.svgText ? 'the SVG markup is included below this issue' : 'attached: look at it') : 'not available (remote, dynamic, missing or too large): judge from the text evidence only';
    }

    let facts = {};
    try {
      if (target && language === 'html') facts = htmlFacts(v.ruleId, target, parsed, idx, imageNote);
      else if (target && language === 'jsx') facts = jsxFacts(v.ruleId, target, parsed, jsxInfo, source, imageNote);
      else if (target && language === 'css') facts = cssFacts(v.ruleId, target, parsed, source);
    } catch (err) { facts = {}; }

    const flagged = source.slice(s, e);
    const region = {
      kind: regionNode ? (guide.region === 'rule' ? 'enclosing CSS rule' : 'enclosing element' + (guide.region !== 'element' ? 's' : '')) : 'surrounding lines',
      startLine: lineOf(starts, reg.start) + 1,
      endLine: lineOf(starts, Math.max(reg.start, reg.end - 1)) + 1,
      text: source.slice(reg.start, reg.end),
      start: reg.start,
      end: reg.end
    };
    const issue = {
      id: 'I' + (i + 1),
      ruleId: v.ruleId,
      severity: v.severity,
      wcag: msg.wcag || '',
      line: v.startLine + 1,
      endLine: v.endLine + 1,
      problem: msg.what || '',
      why: clip(msg.why, 260),
      linterHint: clip(msg.fix, 300),
      guidance: guide.guidance,
      flagged: flagged.length > MAX_FLAGGED ? flagged.slice(0, MAX_FLAGGED) + '…' : flagged,
      region,
      facts,
      image,
      offsets: { start: s, end: e },
      violation: v
    };
    // The issue's own code and facts identify it; the region around it is tracked separately, because a fix elsewhere in
    // that region (an accepted neighbour) must not make this issue look new and cost another request.
    issue.cacheKey = sha(JSON.stringify([v.ruleId, flagged, facts, image ? sha(image.data || image.svgText || '') : '']));
    issue.regionHash = sha(region.text);
    return issue;
  });

  return { language, languageId, file: fileFacts(language, languageId, source, fileName, parsed, projectFacts), issues };
}

function jsxStaticSrc(node) {
  const a = (node.openingElement.attributes || []).find(x => x.type === 'JSXAttribute' && x.name && x.name.name === 'src');
  if (!a || !a.value) return null;
  if (a.value.type === 'StringLiteral') return a.value.value;
  if (a.value.type === 'JSXExpressionContainer' && a.value.expression.type === 'StringLiteral') return a.value.expression.value;
  return null;
}

module.exports = { buildFileContext, LANGUAGE_OF, pickRegion, IMAGE_RULES, MAX_IMAGES_PER_FILE };
