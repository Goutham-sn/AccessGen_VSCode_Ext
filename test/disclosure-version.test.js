// Tests for the versioned AI disclosure: stored shapes, the legacy-boolean migration, the wording fingerprint,
// and the behaviour through the real extension (judgment sends, AI-suggested-fix sends, the informational
// notices). Stubbed `vscode`, fake transport: no test touches the network. Run: node test/disclosure-version.test.js
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const KEY = 'accessgen.aiDisclosureDismissed';

// ====================================================================== pure logic
const D = require('../src/judgment/disclosure');

// Wording fingerprints, one per version. If this test fails because the TEXT changed, the version must be
// bumped (so everyone who acknowledged the old wording is asked again) and the new fingerprint added here.
const FINGERPRINTS = {
  2: '39a9499e4cdb866c7dcc565f754d4c6a864e1931',
  3: '013f0a5d8208cc28bac48fbe206f1c05f150a1bc'
};
const fingerprint = (text) => crypto.createHash('sha1').update(text).digest('hex');

// ------------------------------------------------------------------ vscode stub
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, text, metadata) { this.edits.push({ uri, range, text, metadata }); } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } appendCodeblock() { return this; } }
class Anything { constructor(...a) { this.args = a; } }

let settings = {};
let state;
let currentVscode;

function makeVscode() {
  const st = state = {
    channels: [], toasts: [], warnings: [], errors: [], modals: [], modalResolvers: [], modalMode: 'resolve', modalChoice: undefined,
    commands: {}, handlers: {}, lastDiagnostics: [], codeActionProvider: null, httpCalls: [], settingUpdates: []
  };
  const noop = () => ({ dispose() {} });
  return {
    Range, Position, Diagnostic, WorkspaceEdit, CodeAction, MarkdownString, Hover: Anything, ThemeColor: Anything,
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    CodeActionKind: { QuickFix: 'quickfix' }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 }, OverviewRulerLane: { Right: 4 }, DecorationRangeBehavior: { ClosedClosed: 0 },
    workspace: {
      get workspaceFolders() { return undefined; },
      getConfiguration: () => ({
        get: (k, d) => (settings[k] !== undefined ? settings[k] : d),
        update: (k, v, target) => { st.settingUpdates.push([k, v, target]); settings[k] = v; return Promise.resolve(); },
        inspect: (k) => ({ workspaceValue: settings[k] })
      }),
      applyEdit: async () => true,
      onDidChangeTextDocument: (h) => { st.handlers.doc = h; return noop(); },
      onDidChangeConfiguration: (h) => { st.handlers.config = h; return noop(); },
      openTextDocument: async (uri) => ({ uri })
    },
    window: {
      activeTextEditor: null,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: (m, ...rest) => {
        if (rest[0] && typeof rest[0] === 'object' && rest[0].modal) {
          st.modals.push({ message: m, options: rest[0], buttons: rest.slice(1) });
          if (st.modalMode === 'deferred') return new Promise((res) => { st.modalResolvers.push(res); });
          return Promise.resolve(st.modalChoice);
        }
        st.toasts.push({ message: m, buttons: rest });
        if (st.toastMode === 'pending') return new Promise(() => {}); // left unanswered
        return Promise.resolve(undefined); // closed without choosing (which counts as acknowledging)
      },
      showWarningMessage: (m, ...buttons) => { st.warnings.push({ m, buttons }); return Promise.resolve(undefined); },
      showErrorMessage: (m) => { st.errors.push(m); return Promise.resolve(undefined); },
      showInputBox: () => Promise.resolve(undefined),
      showTextDocument: () => Promise.resolve(),
      setStatusBarMessage() {},
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: (h) => { st.handlers.editor = h; return noop(); },
      createOutputChannel: (name) => { const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }; st.channels.push(ch); return ch; }
    },
    commands: { registerCommand: (id, fn) => { st.commands[id] = fn; return noop(); }, executeCommand: () => Promise.resolve() },
    languages: {
      createDiagnosticCollection: () => ({ set: (uri, d) => { st.lastDiagnostics = d; }, delete() {}, clear() {}, dispose() {} }),
      registerHoverProvider: noop,
      registerCodeActionsProvider: (sel, provider) => { st.codeActionProvider = provider; return noop(); }
    }
  };
}

currentVscode = makeVscode();
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? currentVscode : origLoad.call(this, req, ...rest); };
const srcDir = path.join(__dirname, '..', 'src') + path.sep;
function freshModules() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  currentVscode = makeVscode();
}

const HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><title>t</title></head><body>',
  '<h2>Leadership</h2>',
  '<figure><img src="/team/jane-doe-ceo.jpg"><figcaption>Jane Doe, CEO</figcaption></figure>',
  '</body></html>',
  ''
].join('\n');
const L_IMG = 3;

const openaiEnv = (o) => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(o) } }] } });
function reply(body) {
  const p = body.messages[body.messages.length - 1].content;
  if (/write the alt text|write the visible text/.test(p)) return openaiEnv({ suggestedText: 'Jane Doe, chief executive', confidence: 0.9, reasoning: 'From the file name and caption.' });
  return openaiEnv({ verdict: 'pass', confidence: 0.8, reasoning: 'Fine.' });
}

// stored: the value found in globalState under KEY when the extension starts (undefined = never acknowledged)
// sharedData: a Map to reuse as the persisted store (simulates restarting VS Code)
async function scenario({ stored, sharedData, noGlobalState, mode = 'manual', modalMode, modalChoice, text = HTML } = {}) {
  freshModules();
  const st = state;
  settings = { debounceMs: 20, aiReviewDebounceMs: 60000, aiReviewMode: mode };
  st.modalMode = modalMode || 'resolve'; st.modalChoice = modalChoice;
  const httpMod = require('../src/judgment/providers/http');
  httpMod.postJson = async (url, headers, body) => { st.httpCalls.push({ url, body }); return reply(body); };
  const secrets = { data: new Map([['accessgen.apiKey.openai', 'sk-test-DISC-KEY']]), async get(k) { return this.data.get(k); }, async store(k, v) { this.data.set(k, v); } };
  const doc = {
    languageId: 'html', uri: { fsPath: 'C:/ws/page.html', toString: () => 'file:///c:/ws/page' }, text, version: 1,
    getText() { return this.text; },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(i) { const t = this.text.split('\n')[i] || ''; return { text: t, range: { end: { character: t.length } } }; }
  };
  currentVscode.window.activeTextEditor = { document: doc, setDecorations() {} };
  const data = sharedData || new Map(stored === undefined ? [] : [[KEY, stored]]);
  const globalState = { data, updates: [], get(k, d) { return this.data.has(k) ? this.data.get(k) : d; }, async update(k, v) { this.data.set(k, v); this.updates.push([k, v]); } };
  const context = { subscriptions: [], secrets, extensionPath: path.join(__dirname, '..') };
  if (!noGlobalState) context.globalState = globalState;
  require('../src/extension').activate(context);
  await wait(150);
  const sc = {
    state: st, doc, globalState, data,
    stored() { return data.get(KEY); },
    review() { return st.commands['accessgen.reviewWithAI'](); },
    actions() { return st.codeActionProvider.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: st.lastDiagnostics }).filter(a => /^AccessGen \(AI\)/.test(a.title)); },
    imgAction() { return sc.actions().find(a => a.diagnostics[0].range.start.line === L_IMG); },
    resolve(a) { return st.codeActionProvider.resolveCodeAction(a, {}); },
    async switchMode(m) { settings.aiReviewMode = m; st.handlers.config({ affectsConfiguration: () => true }); await wait(60); }
  };
  return sc;
}

(async () => {
  // ================================================================== what is stored, whatever its shape
  console.log('\nreadDisclosure: every stored shape');
  const shapes = [
    ['legacy boolean true', true, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: 2 }', { dismissed: true, version: 2 }, { dismissed: true, version: 2 }],
    ['{ dismissed: true, version: 7 }', { dismissed: true, version: 7 }, { dismissed: true, version: 7 }],
    ['{ dismissed: true, version: 0 }', { dismissed: true, version: 0 }, { dismissed: true, version: 0 }],
    ['{ dismissed: true } (no version)', { dismissed: true }, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: "2" } (string)', { dismissed: true, version: '2' }, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: -1 }', { dismissed: true, version: -1 }, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: 1.5 }', { dismissed: true, version: 1.5 }, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: NaN }', { dismissed: true, version: NaN }, { dismissed: true, version: 0 }],
    ['{ dismissed: true, version: null }', { dismissed: true, version: null }, { dismissed: true, version: 0 }]
  ];
  for (const [label, value, expected] of shapes) check(label, D.readDisclosure(value), expected);
  const notDismissed = { dismissed: false, version: 0 };
  for (const [label, value] of [['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['1', 1], ['the string "true"', 'true'], ['the string "yes"', 'yes'],
    ['an empty array', []], ['an empty object', {}], ['{ dismissed: false, version: 9 }', { dismissed: false, version: 9 }],
    ['{ dismissed: "true", version: 9 }', { dismissed: 'true', version: 9 }], ['{ version: 9 } (no dismissed)', { version: 9 }], ['[true]', [true]]]) {
    check(label + ' -> not dismissed', D.readDisclosure(value), notDismissed);
  }
  check('it never throws, whatever it is given', [undefined, null, NaN, Symbol('x'), () => {}, { get dismissed() { throw new Error('x'); } }].map(v => { try { D.readDisclosure(v); return 'ok'; } catch (e) { return 'threw'; } }), ['ok', 'ok', 'ok', 'ok', 'ok', 'threw']);

  console.log('\nisDisclosureCurrent');
  check('the key is unchanged and the version was bumped past the legacy value', [D.DISCLOSURE_KEY, D.AI_DISCLOSURE_VERSION, D.AI_DISCLOSURE_VERSION > 0], [KEY, 3, true]);
  check('legacy true: NOT current (asked again)', D.isDisclosureCurrent(true), false);
  check('version 0 and 1: NOT current', [D.isDisclosureCurrent({ dismissed: true, version: 0 }), D.isDisclosureCurrent({ dismissed: true, version: 1 })], [false, false]);
  check('the current version: current', D.isDisclosureCurrent(D.disclosureRecord()), true);
  check('a LATER version (a downgrade of the extension) is still current: no re-ask', D.isDisclosureCurrent({ dismissed: true, version: D.AI_DISCLOSURE_VERSION + 5 }), true);
  check('missing / malformed / dismissed:false: NOT current', [undefined, null, 'x', {}, { dismissed: false, version: 9 }].map(v => D.isDisclosureCurrent(v)), [false, false, false, false, false]);
  check('disclosureRecord() is { dismissed: true, version: <current> }', D.disclosureRecord(), { dismissed: true, version: D.AI_DISCLOSURE_VERSION });
  check('each call returns a fresh object (no shared mutable state)', D.disclosureRecord() !== D.disclosureRecord(), true);

  console.log('\nthe wording is pinned to its version');
  check('a fingerprint is recorded for the current version (bump the version AND add its fingerprint when the text changes)', Object.keys(FINGERPRINTS).includes(String(D.AI_DISCLOSURE_VERSION)), true);
  check('the current wording matches that fingerprint: edit the text without bumping the version and this fails', fingerprint(D.disclosureText('{provider}')), FINGERPRINTS[D.AI_DISCLOSURE_VERSION]);
  check('the text names the current provider', [D.disclosureText('OpenAI').includes('currently OpenAI'), D.disclosureText('Anthropic').includes('currently Anthropic')], [true, true]);
  check('it covers what an AI-suggested fix sends (the reason for version 2)', ['image file name', 'nearby text', 'flagged alt text', 'link href', 'heading text', 'nothing else from the file', 'third-party'].filter(t => !D.disclosureText('X').includes(t)), []);

  // ================================================================== through the real extension
  console.log('\nlegacy true (an older wording): re-prompted once before the next real send, then not again');
  const lg = await scenario({ stored: true, modalMode: 'deferred' });
  check('startup: nothing shown yet (no send is happening)', [lg.state.modals.length, lg.state.toasts.length, lg.state.httpCalls.length], [0, 0, 0]);
  const lgReview = lg.review();
  await wait(100);
  check('the first judgment send opens the dialog even though a flag exists', [lg.state.modals.length, lg.state.modals[0].options.modal], [1, true]);
  check('...and nothing is sent while it is open; the stored value is untouched', [lg.state.httpCalls.length, lg.stored()], [0, true]);
  lg.state.modalResolvers[0]('OK');
  await lgReview;
  check('OK: the send happens', lg.state.httpCalls.length > 0, true);
  check('...and the flag is UPGRADED in place to the current versioned record (one write, same key)', [lg.globalState.updates, lg.stored()], [[[KEY, { dismissed: true, version: 3 }]], { dismissed: true, version: 3 }]);
  const callsAfterFirst = lg.state.httpCalls.length;
  lg.doc.text = HTML.replace('Leadership', 'Our leaders');
  await lg.review();
  const lgAct = lg.imgAction();
  await lg.resolve(lgAct);
  check('a second judgment send AND an AI-suggested-fix send ask nothing more', [lg.state.modals.length, lg.state.httpCalls.length > callsAfterFirst, !!lgAct.edit], [1, true, true]);
  check('...and the stored record is not rewritten', lg.globalState.updates.length, 1);

  console.log('\nacross sessions: acknowledged once, never again');
  const s2 = await scenario({ sharedData: lg.data });
  await s2.review();
  const s2act = s2.imgAction();
  await s2.resolve(s2act);
  check('a new session with the upgraded record: no dialog on either path', [s2.state.modals.length, s2.state.httpCalls.length > 0, !!s2act.edit], [0, true, true]);

  console.log('\nthe fix-suggestion path re-prompts the same way');
  const lf = await scenario({ stored: true, modalMode: 'deferred' });
  const lfAct = lf.imgAction();
  const lfPending = lf.resolve(lfAct);
  await wait(100);
  check('selecting an AI-suggested fix with a legacy flag opens the dialog; nothing is sent meanwhile', [lf.state.modals.length, lf.state.httpCalls.length, lfAct.edit], [1, 0, undefined]);
  lf.state.modalResolvers[0]('OK');
  await lfPending;
  check('OK: the suggestion is made and the flag upgraded', [lf.state.httpCalls.length, !!lfAct.edit, lf.stored()], [1, true, { dismissed: true, version: 3 }]);
  await lf.review();
  check('a judgment review afterwards asks nothing more (one shared acknowledgement)', lf.state.modals.length, 1);

  console.log('\nolder versioned records behave like the legacy flag');
  const v1 = await scenario({ stored: { dismissed: true, version: 1 }, modalChoice: 'OK' });
  await v1.review();
  check('version 1 re-prompts and is upgraded to the current version', [v1.state.modals.length, v1.stored()], [1, { dismissed: true, version: 3 }]);
  const v2 = await scenario({ stored: { dismissed: true, version: 2 }, modalChoice: 'OK' });
  await v2.review();
  check('version 2 (acknowledged before the generic AI fix sent source code) re-prompts and is upgraded', [v2.state.modals.length, v2.stored()], [1, { dismissed: true, version: 3 }]);
  check('...and the new wording says what the generic fix sends', ['flagged source code', 'enclosing element', 'description of the problem'].filter(t => !v2.state.modals[0].message.includes(t)), []);
  const v0 = await scenario({ stored: { dismissed: true }, modalChoice: 'OK' });
  await v0.review();
  check('a record with no version re-prompts (version 0)', [v0.state.modals.length, v0.stored()], [1, { dismissed: true, version: 3 }]);
  for (const [label, bad] of [['the string "true"', 'true'], ['{ dismissed: "true" }', { dismissed: 'true', version: 3 }], ['an array', [true]], ['a number', 1]]) {
    const m = await scenario({ stored: bad, modalChoice: 'OK' });
    await m.review();
    check('a malformed stored value (' + label + ') is treated as never acknowledged', [m.state.modals.length, m.stored()], [1, { dismissed: true, version: 3 }]);
  }

  console.log('\nthe current version, or a later one, is never asked again');
  const cur = await scenario({ stored: { dismissed: true, version: 3 }, modalChoice: undefined });
  await cur.review();
  const curAct = cur.imgAction();
  await cur.resolve(curAct);
  check('current: no dialog on either path, sends go through, nothing is written', [cur.state.modals.length, cur.state.httpCalls.length > 0, !!curAct.edit, cur.globalState.updates.length], [0, true, true, 0]);
  const fut = await scenario({ stored: { dismissed: true, version: 9 }, modalChoice: undefined });
  await fut.review();
  check('a later version (e.g. after a downgrade): no dialog, value left exactly as it was', [fut.state.modals.length, fut.stored()], [0, { dismissed: true, version: 9 }]);

  console.log('\nCancel on the re-prompt');
  const cn = await scenario({ stored: true, modalChoice: undefined });
  await cn.review();
  check('nothing is sent, AI review is switched off, and the old flag is left as it was (so it asks again next time)', [cn.state.httpCalls.length, settings.aiReviewMode, cn.stored(), cn.globalState.updates.length], [0, 'off', true, 0]);
  const cn2 = await scenario({ stored: true, modalChoice: undefined });
  const cn2Act = cn2.imgAction();
  await cn2.resolve(cn2Act);
  check('the same on the fix-suggestion path (no edit)', [cn2.state.httpCalls.length, cn2Act.edit, cn2.stored()], [0, undefined, true]);
  cn.state.modalChoice = 'OK';
  cn.state.toastMode = 'pending'; // the notice shown on switching back on is left unanswered, so it cannot acknowledge for us
  await cn.switchMode('manual');
  await cn.review();
  check('turning AI review back on later asks again, and OK upgrades the flag', [cn.state.modals.length, cn.stored()], [2, { dismissed: true, version: 3 }]);

  console.log('\nthe informational notices use the same version');
  const nt = await scenario({ stored: true, mode: 'off' });
  await nt.switchMode('manual');
  check('legacy flag: switching AI review on shows the notice again', [nt.state.toasts.length, nt.state.toasts[0] && nt.state.toasts[0].buttons], [1, ['OK', 'Learn more']]);
  check('...with the current wording, and the flag is upgraded', [nt.state.toasts[0].message === D.disclosureText('OpenAI'), nt.stored()], [true, { dismissed: true, version: 3 }]);
  await nt.switchMode('off'); await nt.switchMode('manual');
  check('...and then not again', nt.state.toasts.length, 1);
  const nc = await scenario({ stored: { dismissed: true, version: 3 }, mode: 'off' });
  await nc.switchMode('manual');
  check('current flag: switching AI review on shows no notice', nc.state.toasts.length, 0);
  const nk = await scenario({ stored: true });
  await nk.state.commands['accessgen.setAiApiKey']();
  await wait(40);
  check('setAiApiKey with a legacy flag shows the notice once', [nk.state.toasts.length, nk.stored()], [1, { dismissed: true, version: 3 }]);
  await nk.state.commands['accessgen.setAiApiKey']();
  await wait(40);
  check('...and not on the next run', nk.state.toasts.length, 1);

  console.log('\nwithout globalState (in-memory fallback)');
  const nm = await scenario({ noGlobalState: true, modalChoice: 'OK' });
  await nm.review();
  const nmAct = nm.imgAction();
  await nm.resolve(nmAct);
  check('asked once per session, then not again; nothing persisted', [nm.state.modals.length, !!nmAct.edit, nm.globalState.updates.length], [1, true, 0]);

  console.log('\nthe dialog text');
  check('the dialog shows the current wording for the selected provider', lg.state.modals[0].message, D.disclosureText('OpenAI'));

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
