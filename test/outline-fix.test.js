// Node-only test with a stubbed `vscode` module (no extension host needed).
// Run: node test/outline-fix.test.js
const Module = require('module');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}

let registered = null;
let collected = [];
const vscodeStub = {
  Range, Position, WorkspaceEdit, CodeAction, Diagnostic,
  CodeActionKind: { QuickFix: 'quickfix' },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
  languages: {
    createDiagnosticCollection: () => ({ set(uri, d) { collected = d; }, delete() {}, dispose() {} }),
    registerCodeActionsProvider: (sel, provider) => { registered = { sel, provider }; return { dispose() {} }; }
  }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest);
};

const { parseCSS } = require('../src/parsers/cssParser');
const rule = require('../src/rules/css/outline-removed');
const diagnostics = require('../src/diagnostics');
const { registerCodeActions } = require('../src/codeActions');

// The fix's color is computed from the background-color in the same rule block, so the apply-the-fix flow
// runs on the fixture that has one (a dark navy button background). The original outline-fix.css has no
// background and is used below for the "no background -> no fix offered" case.
const text = fs.readFileSync(path.join(__dirname, '..', 'test-files', 'outline-fix-bg.css'), 'utf8');
// This fixture must stay UNFIXED. If this fails, the quick fix was applied to the file itself and saved
// (easy to do when trying the extension on test-files); restore "outline: none;" in the button block.
assert.ok(text.includes('outline: none;'), 'test-files/outline-fix-bg.css no longer contains "outline: none;": has the quick fix been applied to it and saved? Restore the line.');
const lines = text.split(/\r\n|\r|\n/);
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const document = {
  uri: { toString: () => 'file:///outline-fix.css' },
  languageId: 'css',
  lineCount: lines.length,
  lineAt: i => ({ text: lines[i] }),
  getText: () => text
};

const violations = rule.check(parseCSS(text), text, {});
assert.strictEqual(violations.length, 1, 'exactly one violation');

diagnostics.updateDiagnostics(document, violations);
assert.strictEqual(collected.length, 1, 'one diagnostic');
registerCodeActions({ subscriptions: [] });

const diag = collected[0];
const actions = registered.provider.provideCodeActions(document, diag.range, { diagnostics: [diag] });
assert.strictEqual(actions.length, 1, 'one quick fix offered');
assert.strictEqual(actions[0].edit.edits.length, 1, 'single range replacement');

// Diagnostics from other sources / non-fixable rules get nothing.
const other = new Diagnostic(diag.range, 'm', 0); other.source = 'eslint'; other.code = 'outline-removed';
assert.strictEqual(registered.provider.provideCodeActions(document, diag.range, { diagnostics: [other] }).length, 0);
const nonFix = new Diagnostic(diag.range, 'm', 0); nonFix.source = 'AccessGen'; nonFix.code = 'color-contrast-low';
assert.strictEqual(registered.provider.provideCodeActions(document, diag.range, { diagnostics: [nonFix] }).length, 0);

// Apply the edit and compare against the whole expected file.
const e = actions[0].edit.edits[0];
const offset = p => lines.slice(0, p.line).reduce((n, l) => n + l.length + eol.length, 0) + p.character;
const result = text.slice(0, offset(e.range.start)) + e.text + text.slice(offset(e.range.end));
// #1a1a2e is dark, so the outline is white (17.06:1), not the old fixed #0066cc.
// (inset ring: negative outline-offset, drawn inside the element over its own background)
const expected = text.replace('outline: none;', 'outline: 2px solid #ffffff; outline-offset: -2px;');
assert.notStrictEqual(expected, text);
assert.strictEqual(result, expected);

// Stale source: fix() declines when the range no longer holds an outline declaration.
assert.strictEqual(rule.fix(violations[0], 'a { color: blue; }\n\nbutton:focus-visible {\n  margin: 0;\n}\n'), null);

// ---- the original fixture has NO background-color in its block: nothing to compute against ----------
{
  const bare = fs.readFileSync(path.join(__dirname, '..', 'test-files', 'outline-fix.css'), 'utf8');
  assert.ok(!/background/i.test(bare), 'the original fixture is expected to have no background');
  const bareLines = bare.split(/\r\n|\r|\n/);
  const bareDoc = {
    uri: { toString: () => 'file:///outline-fix-bare.css' }, languageId: 'css',
    lineCount: bareLines.length, lineAt: i => ({ text: bareLines[i] }), getText: () => bare
  };
  const bareViolations = rule.check(parseCSS(bare), bare, {});
  assert.strictEqual(bareViolations.length, 1, 'still flagged: the outline is still removed');
  assert.strictEqual(rule.fix(bareViolations[0], bare), null, 'but no fix: the background is not statically determinable');
  assert.ok(/No automatic fix is offered/.test(bareViolations[0].message.fix), 'and the hover says why');
  assert.ok(/not statically determinable/.test(bareViolations[0].message.fix));

  diagnostics.updateDiagnostics(bareDoc, bareViolations);
  const bareDiag = collected[0];
  const bareActions = registered.provider.provideCodeActions(bareDoc, bareDiag.range, { diagnostics: [bareDiag] });
  assert.strictEqual(bareActions.length, 0, 'no quick fix is offered at all');
}

console.log('PASS');
console.log(result);
