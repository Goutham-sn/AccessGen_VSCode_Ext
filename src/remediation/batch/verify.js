// Local checks on a model's proposed edits. Nothing a model returns is trusted:
//   applies        every "find" locates exactly one span of the file (exactly, or whitespace-tolerant), no overlaps
//   parses         the edited file parses no worse than before
//   resolves       the target rule reports fewer violations after the edit
//   noRegressions  no OTHER rule reports more violations after the edit (the fix did not create new problems)
// verified = all four. Edits are turned into offset ranges { start, end, oldText, newText } here, once, so the
// apply step later only has to confirm the text under each range is unchanged.

const { analyzeDocument } = require('../../analyzer');
const { parseJSX } = require('../../parsers/jsxParser');
const { parseCSS } = require('../../parsers/cssParser');

function allIndexes(hay, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One edit -> { start, end, oldText, fuzzy } | { error }. `near` = [start, end] offsets of the issue region,
// used only to break a tie between several exact occurrences.
function locate(source, find, near) {
  const exact = allIndexes(source, find);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + find.length, oldText: find, fuzzy: false };
  if (exact.length > 1) {
    const inside = exact.filter(i => near && i >= near[0] && i + find.length <= near[1]);
    if (inside.length === 1) return { start: inside[0], end: inside[0] + find.length, oldText: find, fuzzy: false };
    return { error: 'the text to replace occurs ' + exact.length + ' times in the file' };
  }
  // Whitespace-tolerant: models often re-indent. Only accepted when it matches exactly one span.
  const pattern = find.trim().split(/\s+/).map(escapeRe).join('\\s+');
  if (!pattern) return { error: 'empty text to replace' };
  const re = new RegExp(pattern, 'g');
  const found = [];
  let m;
  while ((m = re.exec(source)) && found.length < 3) { found.push({ start: m.index, end: m.index + m[0].length, oldText: m[0] }); if (m[0].length === 0) re.lastIndex++; }
  if (found.length === 1) return { ...found[0], fuzzy: true };
  return { error: found.length ? 'the text to replace is ambiguous' : 'the text to replace was not found in the file' };
}

// Match the file's line endings, so a model writing \n into a CRLF file does not mix them.
function toEol(text, eol) {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

function locateEdits(source, edits, near) {
  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  const ranges = [];
  for (const e of edits) {
    const find = toEol(e.find, eol);
    const r = locate(source, find, near);
    if (r.error) return { ok: false, reason: r.error, ranges: [] };
    let newText = toEol(e.replace, eol);
    if (r.fuzzy) newText = reindent(r.oldText, find, newText);
    ranges.push({ start: r.start, end: r.end, oldText: r.oldText, newText });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) return { ok: false, reason: 'two edits overlap', ranges: [] };
  }
  return { ok: true, ranges };
}

// When the model's "find" differed from the file only by indentation, shift its replacement by the same amount.
function reindent(actual, find, replacement) {
  const lead = (s) => { const m = s.match(/\n([ \t]*)\S/); return m ? m[1] : null; };
  const a = lead(actual), f = lead(find);
  if (a === null || f === null || a === f) return replacement;
  return replacement.split(/(\r?\n)/).map((part, i) => (i % 2 === 0 && i > 0 && part.startsWith(f) ? a + part.slice(f.length) : part)).join('');
}

function applyRanges(source, ranges) {
  let out = source;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.newText + out.slice(r.end);
  return out;
}

function jsxErrors(text) {
  const ast = parseJSX(text);
  return ast ? (ast.errors ? ast.errors.length : 0) : Infinity;
}

function parsesNoWorse(languageId, before, after) {
  if (languageId === 'css') return !!parseCSS(after);
  if (languageId === 'javascriptreact' || languageId === 'typescriptreact') return jsxErrors(after) <= jsxErrors(before);
  return true; // HTML: parse5 recovers from anything; regressions are caught by the rule re-run instead
}

const countByRule = (violations) => violations.reduce((m, v) => { m[v.ruleId] = (m[v.ruleId] || 0) + 1; return m; }, {});

function makeAnalyzer(config) {
  const cfg = { complianceLevel: 'AA', isRuleDisabled: () => false, isTrustedComponent: () => false, ...(config || {}) };
  const memo = new Map();
  return async (source, languageId) => {
    const key = languageId + '\u0000' + source;
    if (!memo.has(key)) memo.set(key, analyzeDocument({ getText: () => source, languageId }, cfg).then(countByRule));
    return memo.get(key);
  };
}

// -> { applies, parses, resolves, noRegressions, verified, reason, newIssues: [ruleId], ranges }
// Pass either `edits` ({ find, replace } from a model) or `ranges` (already located, from a deterministic fix).
async function verifyFix({ source, languageId, ruleId, edits, ranges, near, analyze }) {
  const res = { applies: false, parses: false, resolves: false, noRegressions: false, verified: false, reason: '', newIssues: [], ranges: [] };
  if ((!edits || !edits.length) && (!ranges || !ranges.length)) { res.reason = 'no edits were proposed'; return res; }
  const loc = ranges && ranges.length ? { ok: true, ranges } : locateEdits(source, edits, near);
  if (!loc.ok) { res.reason = loc.reason; return res; }
  res.applies = true;
  res.ranges = loc.ranges;
  if (loc.ranges.every(r => r.oldText === r.newText)) { res.reason = 'the edit does not change anything'; res.applies = false; return res; }
  const edited = applyRanges(source, loc.ranges);
  res.parses = parsesNoWorse(languageId, source, edited);
  if (!res.parses) { res.reason = 'the edited file would not parse'; return res; }
  const before = await analyze(source, languageId);
  const after = await analyze(edited, languageId);
  res.resolves = (after[ruleId] || 0) < (before[ruleId] || 0);
  res.newIssues = Object.keys(after).filter(r => r !== ruleId && (after[r] || 0) > (before[r] || 0));
  res.noRegressions = res.newIssues.length === 0;
  res.verified = res.resolves && res.noRegressions;
  if (!res.resolves) res.reason = 'the analyzer still reports ' + ruleId + ' after this edit';
  else if (!res.noRegressions) res.reason = 'the edit introduces new issues: ' + res.newIssues.join(', ');
  return res;
}

// Fills the {{INPUT}} slot of a fix with the developer's text. The text is made safe for every place a slot can be
// (an HTML/JSX attribute value or element text): one line, at most 150 characters, markup characters escaped and
// JSX braces removed, so it can never change the structure of the code.
const INPUT = '{{INPUT}}';
function cleanInput(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 150)
    .replace(/[{}]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fillInput(text, value) {
  return String(text).split(INPUT).join(cleanInput(value));
}

module.exports = { locate, locateEdits, applyRanges, verifyFix, makeAnalyzer, parsesNoWorse, toEol, fillInput, cleanInput };
