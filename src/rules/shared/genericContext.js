// What the generic AI fixer is shown for one violation: the rule's own message (what / why / fix hints), the WCAG
// criterion, the exact text of the flagged range, and a surrounding-context window:
//   html  the smallest element that contains the flagged range      (parse5 offsets)
//   jsx   the smallest JSXElement that contains the flagged range   (babel offsets)
//   css   the smallest rule / at-rule that contains the flagged range (postcss offsets)
// When that enclosing node is missing or too large to send (a whole <html>, a whole stylesheet block) the context is a
// small window of whole lines around the flagged range instead. Pure and vscode-free.
//
// buildGenericRequest(violation, sourceCode, language) -> {
//   ruleId, wcag, message: { what, why, fix }, language, flagged, context, contextKind, tooLarge }
//   language: 'html' | 'jsx' | 'css'  (a rule's own `language` field)

const { parseHTML, walkNode } = require('../../parsers/htmlParser');
const { parseJSX, walkJSX } = require('../../parsers/jsxParser');
const { parseCSS } = require('../../parsers/cssParser');

const MAX_FLAGGED_CHARS = 2000;  // a longer flagged range is not something to hand to a model as "one replacement"
const MAX_CONTEXT_CHARS = 1200;  // enclosing node text above this becomes a line window
const WINDOW_LINES = 4;          // whole lines kept on each side in the fallback window

// Absolute offsets of the start of every line, treating \r\n, \r and \n as one line break each.
function lineStarts(source) {
  const starts = [0];
  const re = /\r\n|\r|\n/g;
  let m;
  while ((m = re.exec(source))) starts.push(m.index + m[0].length);
  return starts;
}

function offsetOf(starts, source, line, char) {
  if (line < 0) return 0;
  if (line >= starts.length) return source.length;
  return Math.min(starts[line] + char, source.length);
}

// Innermost [start, end) among candidates that fully contain [s, e).
function innermost(candidates, s, e) {
  let best = null;
  for (const c of candidates) {
    if (c.start <= s && c.end >= e && (!best || c.end - c.start < best.end - best.start)) best = c;
  }
  return best;
}

function enclosingRange(language, source, s, e) {
  const found = [];
  if (language === 'html') {
    const ast = parseHTML(source);
    if (!ast) return null;
    walkNode(ast, (n) => {
      const l = n.tagName && n.sourceCodeLocation;
      if (l && Number.isInteger(l.startOffset) && Number.isInteger(l.endOffset)) found.push({ start: l.startOffset, end: l.endOffset });
    });
  } else if (language === 'jsx') {
    const ast = parseJSX(source);
    if (!ast) return null;
    walkJSX(ast, (n) => {
      if (n.type === 'JSXElement' && Number.isInteger(n.start) && Number.isInteger(n.end)) found.push({ start: n.start, end: n.end });
    });
  } else if (language === 'css') {
    const root = parseCSS(source);
    if (!root) return null;
    root.walk((n) => {
      const a = n.source && n.source.start, b = n.source && n.source.end;
      if ((n.type === 'rule' || n.type === 'atrule') && a && b && Number.isInteger(a.offset) && Number.isInteger(b.offset)) {
        found.push({ start: a.offset, end: b.offset }); // postcss's end offset is already exclusive (just past the closing brace)
      }
    });
  }
  return innermost(found, s, e);
}

// Whole lines around the flagged range, bounded so a long line cannot blow the size limit.
function lineWindow(source, starts, violation) {
  const from = Math.max(0, violation.startLine - WINDOW_LINES);
  const to = Math.min(starts.length - 1, violation.endLine + WINDOW_LINES);
  const start = starts[from];
  const end = to + 1 < starts.length ? starts[to + 1] : source.length;
  let text = source.slice(start, end).replace(/\s+$/, '');
  if (text.length > MAX_CONTEXT_CHARS) {
    const mid = Math.max(0, offsetOf(starts, source, violation.startLine, violation.startChar) - start);
    const a = Math.max(0, mid - MAX_CONTEXT_CHARS / 2);
    text = (a > 0 ? '…' : '') + text.slice(a, a + MAX_CONTEXT_CHARS) + '…';
  }
  return text;
}

function buildGenericRequest(violation, sourceCode, language) {
  const starts = lineStarts(sourceCode);
  const s = offsetOf(starts, sourceCode, violation.startLine, violation.startChar);
  const e = offsetOf(starts, sourceCode, violation.endLine, violation.endChar);
  const flagged = sourceCode.slice(s, e);
  const msg = violation.message || {};

  let context, contextKind;
  const enclosing = enclosingRange(language, sourceCode, s, e);
  if (enclosing && enclosing.end - enclosing.start <= MAX_CONTEXT_CHARS) {
    context = sourceCode.slice(enclosing.start, enclosing.end);
    contextKind = language === 'css' ? 'enclosing rule' : 'enclosing element';
  } else {
    context = lineWindow(sourceCode, starts, violation);
    contextKind = 'surrounding lines';
  }

  return {
    ruleId: violation.ruleId,
    wcag: msg.wcag || '',
    message: { what: msg.what || '', why: msg.why || '', fix: msg.fix || '' },
    language,
    flagged,
    context,
    contextKind,
    tooLarge: flagged.length > MAX_FLAGGED_CHARS
  };
}

module.exports = { buildGenericRequest, MAX_FLAGGED_CHARS, MAX_CONTEXT_CHARS, lineStarts, offsetOf };
