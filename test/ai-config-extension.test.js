// Config schema, config.js reading, and extension.js wiring for aiReviewMode / aiProvider / aiModel
// and the real AI review flow (the provider's HTTP layer is replaced by a fake: no network).
// Drives the REAL extension.js with a stubbed `vscode` module.
// Run: node test/ai-config-extension.test.js
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
// What globalState holds once the CURRENT disclosure wording has been acknowledged (versioned record, see
// src/judgment/disclosure.js). A legacy plain `true` is NOT this: it means "acknowledged an older wording".
const CURRENT_DISCLOSURE = require('../src/judgment/disclosure').disclosureRecord();

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}

// ------------------------------------------------------------------ vscode stub
// (start/end added: HTML diagnostics now carry fixable violations, which look ranges up by start/end like the real API)
class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } }
class Anything { constructor(...a) { this.args = a; } }

let settings = {};          // accessgen.* workspace settings
let workspaceFolders;       // for file config
let state;                  // per-scenario observations (the latest makeVscode() call)

function makeVscode() {
  const state = global.__st = { channels: [], infoMessages: [], warnings: [], errors: [], commands: {}, executed: [], handlers: {}, diagnostics: [], decorations: 0, inputPrompts: [], nextInput: undefined, httpCalls: [], events: [], quickPicks: [], nextPick: undefined, infoMode: 'resolve', nextInfoChoice: undefined, infoButtons: [], openedDocs: [], shownDocs: [], modals: [], modalMode: 'resolve', modalChoice: undefined, modalResolvers: [], settingUpdates: [], inspectScopes: undefined, updateFails: false };
  const noopDisposable = () => ({ dispose() {} });
  return {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    Range, Position, Diagnostic, MarkdownString, Hover: Anything, WorkspaceEdit: Anything, CodeAction: Anything,
    ThemeColor: Anything, CodeActionKind: { QuickFix: 'quickfix' }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 }, OverviewRulerLane: { Right: 4 }, DecorationRangeBehavior: { ClosedClosed: 0 },
    workspace: {
      get workspaceFolders() { return workspaceFolders; },
      getConfiguration: () => ({
        get: (k, d) => (settings[k] !== undefined ? settings[k] : d),
        // records the write and applies it to the effective settings, like the real API would
        update: (k, v, target) => {
          if (state.updateFails) return Promise.reject(new Error('settings are read-only'));
          state.settingUpdates.push([k, v, target]); settings[k] = v;
          return Promise.resolve();
        },
        inspect: (k) => (state.inspectScopes && state.inspectScopes[k]) || { workspaceValue: settings[k] }
      }),
      openTextDocument: (uri) => { state.openedDocs.push(uri); return Promise.resolve({ uri }); },
      onDidChangeTextDocument: (h) => { state.handlers.doc = h; return noopDisposable(); },
      onDidChangeConfiguration: (h) => { state.handlers.config = h; return noopDisposable(); }
    },
    window: {
      activeTextEditor: null,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: (m, ...rest) => {
        // vscode.window.showInformationMessage(message, options?, ...items): a leading object is MessageOptions
        if (rest[0] && typeof rest[0] === 'object' && typeof rest[0] !== 'string') {
          const options = rest[0], items = rest.slice(1);
          if (options.modal) {
            state.modals.push({ message: m, options, buttons: items }); state.events.push('modal');
            if (state.modalMode === 'deferred') return new Promise((res) => { state.modalResolvers.push(res); });
            if (state.modalMode === 'reject') return Promise.reject(new Error('dialog failed'));
            return Promise.resolve(state.modalChoice);
          }
        }
        const buttons = rest;
        state.infoMessages.push(m); state.infoButtons.push(buttons); state.events.push('info');
        return state.infoMode === 'pending' ? new Promise(() => {}) : Promise.resolve(buttons.length ? state.nextInfoChoice : undefined);
      },
      showQuickPick: (items, opts) => { state.quickPicks.push({ items, opts }); return Promise.resolve(items.find(i => i.value === state.nextPick)); },
      showTextDocument: (doc, opts) => { state.shownDocs.push({ doc, opts }); return Promise.resolve(); },
      showWarningMessage: (m, ...buttons) => { state.warnings.push({ m, buttons }); return Promise.resolve(undefined); },
      showErrorMessage: (m) => { state.errors.push(m); },
      showInputBox: (opts) => { state.inputPrompts.push(opts); state.events.push('input'); return Promise.resolve(state.nextInput); },
      setStatusBarMessage() {},
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: (h) => { state.handlers.editor = h; return noopDisposable(); },
      createOutputChannel: (name) => {
        const ch = { name, lines: [], shown: 0, disposed: false,
          appendLine(l) { this.lines.push(l); }, show() { this.shown++; }, dispose() { this.disposed = true; } };
        state.channels.push(ch);
        return ch;
      }
    },
    commands: {
      registerCommand: (id, fn) => { state.commands[id] = fn; return noopDisposable(); },
      executeCommand: (id) => { state.executed.push(id); return Promise.resolve(); }
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, d) => { state.diagnostics.push(d.map(x => ({ r: [x.range.a, x.range.b, x.range.c, x.range.d], m: x.message, s: x.severity, code: x.code }))); },
        delete() {}, clear() {}, dispose() {}
      }),
      registerHoverProvider: noopDisposable, registerCodeActionsProvider: noopDisposable
    }
  };
}

let currentVscode = makeVscode(); state = global.__st;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? currentVscode : origLoad.call(this, req, ...rest);
};

const srcDir = path.join(__dirname, '..', 'src') + path.sep;
function freshModules() { // new module registry for src/ so cached config/trackers never leak between scenarios
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  currentVscode = makeVscode();
  state = global.__st;
}

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

const HTML = [
  '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>',
  '<img src="a.jpg" alt="photo.jpg">', '<img src="b.jpg">',
  '<a href="/r">Annual report</a>', '<a href="/x">Click here</a>', '<h1>Welcome</h1>',
  '</body></html>'
].join('\n');
const fakeEditor = (text = HTML) => ({
  document: { languageId: 'html', uri: { fsPath: 'C:/ws/page.html', toString: () => 'file:///c:/ws/page.html' }, getText: () => text, lineCount: 8, lineAt: (i) => { const t = text.split('\n')[i] || ''; return { text: t, range: { end: { character: t.length } } }; } },
  setDecorations() {}
});

(async () => {
  // ------------------------------------------------------------------ package.json schema
  console.log('\npackage.json schema');
  const pkg = require('../package.json');
  const props = pkg.contributes.configuration.properties;
  const ai = props['accessgen.aiReviewMode'];
  check('aiReviewMode enum', ai.enum, ['off', 'manual', 'auto']);
  check('aiReviewMode default is off', ai.default, 'off');
  check('aiReviewMode type', ai.type, 'string');
  check('reviewWithAI command contributed', pkg.contributes.commands.some(c => c.command === 'accessgen.reviewWithAI'), true);
  check('pre-existing settings untouched', Object.keys(props).filter(k => !['accessgen.aiReviewMode', 'accessgen.aiProvider', 'accessgen.aiModel', 'accessgen.aiReviewDebounceMs', 'accessgen.remediationMode', 'accessgen.aiRemediationModel', 'accessgen.aiRemediationStrategy', 'accessgen.aiSendImages'].includes(k)).sort(),
    ['accessgen.complianceLevel', 'accessgen.debounceMs', 'accessgen.enabled', 'accessgen.showTooltips', 'accessgen.stateScope', 'accessgen.trustedComponents']);
  check('pre-existing defaults untouched', [props['accessgen.complianceLevel'].default, props['accessgen.debounceMs'].default, props['accessgen.enabled'].default, props['accessgen.stateScope'].default],
    ['AA', 800, true, 'global']);
  check('aiProvider enum/default', [props['accessgen.aiProvider'].enum, props['accessgen.aiProvider'].default], [['openai', 'anthropic'], 'openai']);
  check('aiModel is free text, empty default (= provider default)', [props['accessgen.aiModel'].type, props['accessgen.aiModel'].default, props['accessgen.aiModel'].enum], ['string', '', undefined]);
  check('no setting can hold an API key', Object.keys(props).filter(k => /key|secret|token|password/i.test(k)), []);
  check('setAiApiKey command contributed', pkg.contributes.commands.some(c => c.command === 'accessgen.setAiApiKey'), true);
  check('pre-existing commands untouched', pkg.contributes.commands.map(c => c.command).filter(c => !['accessgen.reviewWithAI', 'accessgen.setAiApiKey', 'accessgen.clearAiApiKey', 'accessgen.acceptInlineFix', 'accessgen.rejectInlineFix', 'accessgen.scanFile', 'accessgen.scanFiles', 'accessgen.scanWorkspace', 'accessgen.fixFileWithAI', 'accessgen.fixAllWithAI', 'accessgen.acceptAllVerifiedFixes', 'accessgen.exportReport'].includes(c)),
    ['accessgen.toggle', 'accessgen.enable', 'accessgen.disable', 'accessgen.showStatus']);

  // ------------------------------------------------------------------ config.js
  console.log('\nconfig.js');
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessgen-cfg-'));
  const writeFileCfg = (obj) => fs.writeFileSync(path.join(wsDir, 'accessgen.config.json'), JSON.stringify(obj));
  const rmFileCfg = () => { try { fs.unlinkSync(path.join(wsDir, 'accessgen.config.json')); } catch (e) {} };
  const loadCfg = () => { freshModules(); return require('../src/config').loadConfig(); };

  settings = {}; workspaceFolders = undefined;
  let c = loadCfg();
  check('default (nothing set) is off', c.aiReviewMode, 'off');
  check('existing fields keep their defaults', [c.complianceLevel, c.trustedComponents, c.disabledRules, c.languages, c.enabled, c.showTooltips, c.debounceMs, c.stateScope],
    ['AA', [], [], ['html', 'jsx', 'tsx', 'css'], true, true, 800, 'global']);
  settings = { aiReviewMode: 'manual' };
  check('workspace setting manual', loadCfg().aiReviewMode, 'manual');
  settings = { aiReviewMode: 'auto' };
  check('workspace setting auto', loadCfg().aiReviewMode, 'auto');
  settings = { aiReviewMode: 'bogus' };
  check('invalid workspace value falls back to off', loadCfg().aiReviewMode, 'off');
  settings = { aiReviewMode: 'AUTO' };
  check('values are case-sensitive: "AUTO" is not a mode', loadCfg().aiReviewMode, 'off');

  settings = {};
  check('aiProvider defaults to openai, aiModel to empty', [loadCfg().aiProvider, loadCfg().aiModel], ['openai', '']);
  settings = { aiProvider: 'anthropic', aiModel: '  claude-x  ' };
  c = loadCfg();
  check('workspace aiProvider/aiModel (model trimmed)', [c.aiProvider, c.aiModel], ['anthropic', 'claude-x']);
  settings = { aiProvider: 'gemini', aiModel: 42 };
  c = loadCfg();
  check('invalid provider -> openai, non-string model -> empty', [c.aiProvider, c.aiModel], ['openai', '']);

  workspaceFolders = [{ uri: { fsPath: wsDir } }];
  settings = { aiReviewMode: 'auto' };
  writeFileCfg({ aiReviewMode: 'manual' });
  check('file config overrides workspace setting', loadCfg().aiReviewMode, 'manual');
  writeFileCfg({ aiReviewMode: 'off' });
  check('file config can turn it off over a workspace "auto"', loadCfg().aiReviewMode, 'off');
  writeFileCfg({ aiReviewMode: 'nope' });
  check('invalid file value is ignored, workspace wins', loadCfg().aiReviewMode, 'auto');
  writeFileCfg({ complianceLevel: 'A', trustedComponents: ['X'], disabledRules: ['r'] });
  c = loadCfg();
  check('file without aiReviewMode uses workspace value', c.aiReviewMode, 'auto');
  check('existing file-config fields still read', [c.complianceLevel, c.trustedComponents, c.disabledRules], ['A', ['X'], ['r']]);
  settings = { aiProvider: 'openai', aiModel: 'ws-model' };
  writeFileCfg({ aiProvider: 'anthropic', aiModel: 'file-model' });
  c = loadCfg();
  check('file config overrides workspace aiProvider/aiModel', [c.aiProvider, c.aiModel], ['anthropic', 'file-model']);
  writeFileCfg({ aiProvider: 'nope', aiModel: '   ' });
  c = loadCfg();
  check('invalid/blank file values fall back to workspace', [c.aiProvider, c.aiModel], ['openai', 'ws-model']);
  check('an API key in the config file is never read into config', (() => { writeFileCfg({ aiApiKey: 'sk-LEAK', apiKey: 'sk-LEAK' }); return JSON.stringify(loadCfg()).includes('sk-LEAK'); })(), false);
  rmFileCfg(); workspaceFolders = undefined;

  // ------------------------------------------------------------------ extension.js wiring
  // Fake provider transport: replaces the real https client, so no test touches the network.
  const defaultReply = (body) => {
    const user = (body.messages || [{}, {}])[1].content;
    const verdict = /photo\.jpg/.test(user) ? 'fail' : 'pass';
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ verdict, confidence: 0.9, reasoning: 'Mock reasoning.' }) } }] } };
  };
  const makeSecrets = (initial) => {
    const store = new Map(Object.entries(initial || {}));
    return { store, stored: [], async get(k) { return store.get(k); }, async store_(k, v) { store.set(k, v); } };
  };
  const makeGlobalState = (dismissed) => ({ data: new Map(dismissed ? [['accessgen.aiDisclosureDismissed', CURRENT_DISCLOSURE]] : []), updates: [],
    get(k, d) { return this.data.has(k) ? this.data.get(k) : d; },
    async update(k, v) { this.data.set(k, v); this.updates.push([k, v]); } });
  const scenarioDirs = [];
  async function scenario(mode, { scans = 1, text = HTML, key, provider, respond, extraSettings, disclosure = 'dismissed', infoMode, nextInfoChoice, modalMode, modalChoice, fileConfig, inspectScopes, updateFails } = {}) {
    freshModules();
    settings = Object.assign({ aiReviewDebounceMs: 0 }, mode === undefined ? {} : { aiReviewMode: mode }, provider ? { aiProvider: provider } : {}, extraSettings || {});
    if (infoMode) state.infoMode = infoMode;
    state.nextInfoChoice = nextInfoChoice;
    workspaceFolders = undefined;
    state.modalMode = modalMode || 'resolve'; state.modalChoice = modalChoice;
    state.inspectScopes = inspectScopes; state.updateFails = !!updateFails;
    let fileConfigPath;
    if (fileConfig !== undefined) { // a real accessgen.config.json in a temp workspace folder
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessgen-scn-')); scenarioDirs.push(dir);
      fileConfigPath = path.join(dir, 'accessgen.config.json');
      fs.writeFileSync(fileConfigPath, fileConfig);
      workspaceFolders = [{ uri: { fsPath: dir } }];
    }
    const httpMod = require('../src/judgment/providers/http');
    httpMod.postJson = async (url, headers, body) => {
      state.httpCalls.push({ url, headers, body }); state.events.push('http');
      return (respond || defaultReply)(body, url, state.httpCalls.length);
    };
    const secrets = {
      data: new Map(key ? [[`accessgen.apiKey.${provider || 'openai'}`, key]] : []),
      async get(k) { return this.data.get(k); },
      async store(k, v) { this.data.set(k, v); this.lastStore = [k, v]; }
    };
    const aiReviewMod = require('../src/judgment/aiReview');
    const calls = { auto: 0, manual: 0 };
    const realAuto = aiReviewMod.runAutoReview, realManual = aiReviewMod.runManualReview;
    aiReviewMod.runAutoReview = (...a) => { calls.auto++; return realAuto(...a); };
    aiReviewMod.runManualReview = (...a) => { calls.manual++; return realManual(...a); };
    const ext = require('../src/extension');
    const editor = fakeEditor(text);
    currentVscode.window.activeTextEditor = editor;
    const globalState = makeGlobalState(disclosure === 'dismissed');
    const context = { subscriptions: [], secrets, globalState, extensionPath: path.join(__dirname, '..') };
    ext.activate(context);
    await wait();
    for (let i = 1; i < scans; i++) { state.handlers.editor(editor); await wait(); }
    return { ext, calls, state, vscode: currentVscode, editor, secrets, globalState, context, fileConfigPath };
  }

  console.log('\nextension.js: mode "off" (default) is a no-op');
  const off = await scenario(undefined);
  check('all commands registered', Object.keys(off.state.commands).sort(),
    ['accessgen.acceptAllVerifiedFixes', 'accessgen.acceptInlineFix', 'accessgen.clearAiApiKey', 'accessgen.disable', 'accessgen.enable', 'accessgen.exportReport', 'accessgen.fixAllWithAI', 'accessgen.fixFileWithAI', 'accessgen.rejectInlineFix', 'accessgen.reviewWithAI', 'accessgen.scanFile', 'accessgen.scanFiles', 'accessgen.scanWorkspace', 'accessgen.setAiApiKey', 'accessgen.showStatus', 'accessgen.toggle']);
  check('scan produced diagnostics (the normal path ran)', off.state.diagnostics.length >= 1 && off.state.diagnostics[off.state.diagnostics.length - 1].length > 0, true);
  check('auto step never called', off.calls.auto, 0);
  check('manual step never called', off.calls.manual, 0);
  check('no output channel created', off.state.channels.length, 0);
  check('no provider call', off.state.httpCalls.length, 0);
  const offWithKey = await scenario(undefined, { key: 'sk-test-KEY' });
  check('off mode with a stored key: still no call, no channel, no message', [offWithKey.state.httpCalls.length, offWithKey.state.channels.length, offWithKey.state.warnings.length], [0, 0, 0]);
  const offDiag = JSON.stringify(off.state.diagnostics);

  const offExplicit = await scenario('off');
  check('explicit "off" == default: identical diagnostics', JSON.stringify(offExplicit.state.diagnostics), offDiag);
  check('explicit "off": auto never called, no channel', [offExplicit.calls.auto, offExplicit.state.channels.length], [0, 0]);

  const infoBefore = off.state.infoMessages.length;
  await off.state.commands['accessgen.reviewWithAI']();
  check('reviewWithAI in off mode just explains, creates nothing',
    [off.state.channels.length, off.calls.manual, off.state.infoMessages.length - infoBefore, /aiReviewMode/.test(off.state.infoMessages[off.state.infoMessages.length - 1])], [0, 0, 1, true]);

  console.log('\nextension.js: mode "manual", no API key');
  const manNo = await scenario('manual', { scans: 2 });
  check('scans never run the AI step', [manNo.calls.auto, manNo.calls.manual, manNo.state.channels.length], [0, 0, 0]);
  check('diagnostics identical to off mode', JSON.stringify(manNo.state.diagnostics.slice(0, offExplicit.state.diagnostics.length)), JSON.stringify(offExplicit.state.diagnostics));
  await manNo.state.commands['accessgen.reviewWithAI']();
  check('one clear message pointing at accessgen.setAiApiKey', [manNo.state.warnings.length, /accessgen\.setAiApiKey/.test(manNo.state.warnings[0].m), /openai/.test(manNo.state.warnings[0].m)], [1, true, true]);
  check('...and nothing else: no provider call, no channel, no info message', [manNo.state.httpCalls.length, manNo.state.channels.length, manNo.state.infoMessages.length], [0, 0, 0]);
  await manNo.state.commands['accessgen.reviewWithAI']();
  check('the manual command repeats the message every time', manNo.state.warnings.length, 2);

  console.log('\nextension.js: mode "manual", with a key');
  const man = await scenario('manual', { scans: 2, key: 'sk-test-MANUAL-KEY' });
  check('scans never call the provider', [man.calls.auto, man.calls.manual, man.state.httpCalls.length, man.state.channels.length], [0, 0, 0, 0]);
  await man.state.commands['accessgen.reviewWithAI']();
  const mch = man.state.channels[0];
  check('channel created and shown', [man.state.channels.length, mch.name, mch.shown], [1, 'AccessGen AI Review', 1]);
  check('one provider call per candidate (alt, link, heading)', man.state.httpCalls.length, 3);
  check('header names provider/model and counts', mch.lines[0], 'AI review (openai/gpt-4o-mini, manual) — C:/ws/page.html: 3 to judge, 0 unchanged');
  const resultLines = mch.lines.filter(l => /->/.test(l));
  check('result lines show ruleId, content, verdict, confidence, reasoning', resultLines.map(l => l.match(/\[([^\]]+)\]/)[1]), ['img-alt-missing', 'anchor-no-text', 'heading-empty']);
  check('...with verdict/confidence/reasoning from the model', resultLines[0], '  [img-alt-missing] 2:1  "photo.jpg"  -> FAIL (0.90): Mock reasoning.');
  // (not searching for the words "Click here": the heading prompt's own example list contains them)
  check('the no-alt img (b.jpg) and the generic "Click here" link (href /x) were never sent',
    man.state.httpCalls.some(c => c.body.messages.some(m => m.content.includes('b.jpg') || m.content.includes('"/x"'))), false);
  check('the qualifying link (href /r) was sent', man.state.httpCalls.some(c => c.body.messages[1].content.includes('"/r"')), true);
  check('summary info message', man.state.infoMessages[man.state.infoMessages.length - 1], 'AccessGen AI review: 3 judged, 0 unchanged, 0 failed.');
  await man.state.commands['accessgen.reviewWithAI']();
  check('re-running makes NO new calls (unchanged since the last review)', man.state.httpCalls.length, 3);
  check('...and shows the stored verdicts, marked cached', mch.lines.filter(l => /\(cached\):/.test(l)).length, 3);
  check('summary reports them as unchanged', man.state.infoMessages[man.state.infoMessages.length - 1], 'AccessGen AI review: 0 judged, 3 unchanged, 0 failed.');

  console.log('\nextension.js: mode "auto", no API key');
  const auNo = await scenario('auto', { scans: 3 });
  check('auto step ran each scan', auNo.calls.auto, 3);
  check('told once about the missing key, not on every scan', [auNo.state.warnings.length, /accessgen\.setAiApiKey/.test(auNo.state.warnings[0].m)], [1, true]);
  check('no provider call, no channel', [auNo.state.httpCalls.length, auNo.state.channels.length], [0, 0]);
  check('diagnostics unaffected', auNo.state.diagnostics.every(d => JSON.stringify(d) === JSON.stringify(off.state.diagnostics[0])), true);

  console.log('\nextension.js: mode "auto", with a key');
  const au = await scenario('auto', { scans: 3, key: 'sk-test-AUTO-KEY' });
  check('auto step ran once per scan', au.calls.auto, 3);
  check('manual step not run by scans', au.calls.manual, 0);
  check('only the FIRST scan called the provider (3 candidates, unchanged afterwards)', au.state.httpCalls.length, 3);
  const ach = au.state.channels[0];
  check('exactly one channel, not force-shown on scans', [au.state.channels.length, ach.shown], [1, 0]);
  const headers = ach.lines.filter(l => l.startsWith('AI review'));
  check('scan 1 judged 3', headers[0], 'AI review (openai/gpt-4o-mini, auto) — C:/ws/page.html: 3 to judge, 0 unchanged');
  check('scan 2 and 3 found nothing new', [headers[1], headers[2]], ['AI review (openai/gpt-4o-mini, auto) — C:/ws/page.html: nothing new to judge, 3 unchanged', 'AI review (openai/gpt-4o-mini, auto) — C:/ws/page.html: nothing new to judge, 3 unchanged']);
  check('diagnostics identical to off mode on every scan',
    au.state.diagnostics.every(d => JSON.stringify(d) === JSON.stringify(off.state.diagnostics[0])), true);

  const au2 = await scenario('auto', { key: 'sk-test-AUTO-KEY' });
  const edit = fakeEditor(HTML.replace('Annual report', 'Yearly report') /* 2 words: still a candidate after the pre-filter */);
  au2.vscode.window.activeTextEditor = edit;
  au2.state.handlers.editor(edit);
  await wait();
  check('after an edit only the changed candidate is re-judged', au2.state.httpCalls.length, 4);
  check('...and it is the edited link', /Yearly report/.test(JSON.stringify(au2.state.httpCalls[3].body)), true);

  console.log('\nextension.js: AI failures cannot break a scan');
  const throwing = (impl) => async () => {
    freshModules(); settings = { aiReviewMode: 'auto', aiReviewDebounceMs: 0 };
    const am = require('../src/judgment/aiReview');
    am.runAutoReview = impl;
    const origErr = console.error; let logged = 0; console.error = () => { logged++; };
    const ext = require('../src/extension');
    currentVscode.window.activeTextEditor = fakeEditor();
    ext.activate({ subscriptions: [], secrets: { async get() { return 'sk-test-X'; } }, globalState: makeGlobalState(true) });
    await wait();
    console.error = origErr;
    return { logged, diagnosticsOk: state.diagnostics.length >= 1 && state.diagnostics[0].length > 0 };
  };
  let r = await throwing(() => { throw new Error('boom'); })();
  check('synchronous throw: diagnostics still published, error logged', [r.diagnosticsOk, r.logged >= 1], [true, true]);
  r = await throwing(() => Promise.reject(new Error('async boom')))();
  check('rejected promise: diagnostics still published, error logged', [r.diagnosticsOk, r.logged >= 1], [true, true]);

  const netFail = await scenario('auto', { key: 'sk-test-NET-KEY', respond: () => { const { AiError } = require('../src/judgment/providers/errors'); throw new AiError('NETWORK', 'Network error contacting the AI provider (ECONNREFUSED).'); } });
  check('network failure on every call: scan fine, diagnostics published', netFail.state.diagnostics.length >= 1 && netFail.state.diagnostics[0].length > 0, true);
  check('...each failure reported in the channel, scan not stopped', netFail.state.channels[0].lines.filter(l => /review failed \(NETWORK\)/.test(l)).length, 3);
  const flaky = await scenario('auto', { key: 'sk-test-FLAKY-KEY', respond: (body, url, n) => { if (n === 2) { const { AiError } = require('../src/judgment/providers/errors'); throw new AiError('RATE_LIMIT', 'rate limited'); } return defaultReply(body); } });
  check('one failing call does not block the others in the batch', [flaky.state.channels[0].lines.filter(l => /->\s+(PASS|FAIL)/.test(l)).length, flaky.state.channels[0].lines.filter(l => /review failed \(RATE_LIMIT\)/.test(l)).length], [2, 1]);

  console.log('\nextension.js: accessgen.setAiApiKey');
  const sk = await scenario('manual');
  sk.state.nextInput = '  sk-test-SECRET-VALUE-123  ';
  await sk.state.commands['accessgen.setAiApiKey']();
  const p = sk.state.inputPrompts[0];
  check('input box is password-masked and survives focus loss', [p.password, p.ignoreFocusOut], [true, true]);
  check('key stored (trimmed) under the provider-scoped secret key', sk.secrets.lastStore, ['accessgen.apiKey.openai', 'sk-test-SECRET-VALUE-123']);
  check('confirmation names the provider', sk.state.infoMessages[sk.state.infoMessages.length - 1], 'AccessGen: API key saved for openai.');
  const everythingShown = JSON.stringify([sk.state.infoMessages, sk.state.warnings, sk.state.errors, sk.state.inputPrompts.map(x => [x.title, x.prompt]), sk.state.channels.map(c => c.lines)]);
  check('the key is never displayed back or logged', everythingShown.includes('SECRET-VALUE'), false);
  check('the key is not written to settings', JSON.stringify(settings).includes('SECRET-VALUE'), false);
  check('validateInput rejects blank input', [typeof p.validateInput('   '), p.validateInput('abc')], ['string', undefined]);

  const skCancel = await scenario('manual');
  skCancel.state.nextInput = undefined;
  await skCancel.state.commands['accessgen.setAiApiKey']();
  check('cancel stores nothing and says nothing', [skCancel.secrets.lastStore, skCancel.state.infoMessages.length], [undefined, 0]);
  const skBlank = await scenario('manual');
  skBlank.state.nextInput = '   ';
  await skBlank.state.commands['accessgen.setAiApiKey']();
  check('blank input stores nothing', skBlank.secrets.lastStore, undefined);

  const skAnth = await scenario('manual', { provider: 'anthropic' });
  skAnth.state.nextInput = 'sk-ant-test-KEY';
  await skAnth.state.commands['accessgen.setAiApiKey']();
  check('anthropic key goes under its own scoped name', skAnth.secrets.lastStore, ['accessgen.apiKey.anthropic', 'sk-ant-test-KEY']);
  check('...confirmation names anthropic', skAnth.state.infoMessages[skAnth.state.infoMessages.length - 1], 'AccessGen: API key saved for anthropic.');

  const skFail = await scenario('manual');
  skFail.secrets.store = async () => { throw new Error('keychain says sk-test-LEAK-ME'); };
  skFail.state.nextInput = 'sk-test-LEAK-ME';
  await skFail.state.commands['accessgen.setAiApiKey']();
  check('a failing store shows a generic error that does not contain the key', [skFail.state.errors.length, JSON.stringify(skFail.state.errors).includes('LEAK-ME')], [1, false]);

  const afterKey = await scenario('manual', { provider: 'openai' });
  await afterKey.state.commands['accessgen.reviewWithAI']();
  check('the no-key warning offers a button that runs setAiApiKey', afterKey.state.warnings[0].buttons, ['Set API Key']);

  // ====================================================================================
  // Follow-up 1: separate, longer debounce for the AI step
  // ====================================================================================
  console.log('\naiReviewDebounceMs: setting and config');
  check('schema: number, default 3000, minimum 0, distinct from debounceMs', [props['accessgen.aiReviewDebounceMs'].type, props['accessgen.aiReviewDebounceMs'].default, props['accessgen.aiReviewDebounceMs'].minimum, props['accessgen.aiReviewDebounceMs'].default > props['accessgen.debounceMs'].default], ['number', 3000, 0, true]);
  const dbCfg = (v) => { settings = v === undefined ? {} : { aiReviewDebounceMs: v }; workspaceFolders = undefined; freshModules(); return require('../src/config').loadConfig(); };
  check('default 3000 (structural debounceMs stays 800)', [dbCfg().aiReviewDebounceMs, dbCfg().debounceMs], [3000, 800]);
  check('workspace value honoured, 0 allowed', [dbCfg(1500).aiReviewDebounceMs, dbCfg(0).aiReviewDebounceMs], [1500, 0]);
  check('negative / non-numeric / NaN fall back to 3000', [dbCfg(-5).aiReviewDebounceMs, dbCfg('fast').aiReviewDebounceMs, dbCfg(NaN).aiReviewDebounceMs, dbCfg(null).aiReviewDebounceMs], [3000, 3000, 3000, 3000]);

  console.log('\naiReviewDebounceMs: a burst of edits produces ONE AI batch after the longer debounce');
  const STRUCT_MS = 20, AI_MS = 300;
  const burst = await scenario('auto', { key: 'sk-test-BURST-KEY', extraSettings: { debounceMs: STRUCT_MS, aiReviewDebounceMs: AI_MS } });
  const bEditor = burst.editor;
  let liveText = HTML;
  bEditor.document.getText = () => liveText;
  const scansAfterActivation = burst.state.diagnostics.length;
  const editions = ['Draft one', 'Draft two', 'Draft three', 'Draft four', 'Final report'];
  for (const link of editions) {
    liveText = HTML.replace('Annual report', link);
    burst.state.handlers.doc({ document: bEditor.document });
    await wait(STRUCT_MS + 25); // slower than debounceMs, faster than aiReviewDebounceMs
  }
  const structuralScans = burst.state.diagnostics.length - scansAfterActivation;
  check('the structural scan ran on its own short debounce: once per edit', structuralScans, editions.length);
  check('...but while edits keep arriving the AI step has NOT fired', [burst.calls.auto, burst.state.httpCalls.length, burst.state.channels.length], [0, 0, 0]);
  await wait(AI_MS + 150);
  check('after the longer quiet period exactly ONE AI batch fired', burst.calls.auto, 1);
  check('...judging the 3 candidates once each', burst.state.httpCalls.length, 3);
  const burstBodies = JSON.stringify(burst.state.httpCalls.map(c => c.body));
  check('...for the FINAL content only; no intermediate draft was ever sent', [burstBodies.includes('Final report'), ['Draft one', 'Draft two', 'Draft three', 'Draft four'].filter(d => burstBodies.includes(d))], [true, []]);
  check('the activation-time scan\'s pending AI review was superseded, not run', burst.state.httpCalls.length, 3);
  await wait(AI_MS + 100);
  check('and nothing fires again afterwards', [burst.calls.auto, burst.state.httpCalls.length], [1, 3]);

  console.log('\naiReviewDebounceMs: queued reviews respect later changes');
  const sw = await scenario('auto', { key: 'sk-test-SW-KEY', extraSettings: { debounceMs: STRUCT_MS, aiReviewDebounceMs: 200 } });
  settings.aiReviewMode = 'off';
  sw.state.handlers.config({ affectsConfiguration: () => true });
  await wait(450);
  check('switching to "off" while a review is queued cancels it: no AI call ever fires', [sw.calls.auto, sw.state.httpCalls.length, sw.state.channels.length], [0, 0, 0]);
  const manualAfter = await scenario('auto', { key: 'sk-test-SW2-KEY', extraSettings: { debounceMs: STRUCT_MS, aiReviewDebounceMs: 200 } });
  settings.aiReviewMode = 'manual';
  manualAfter.state.handlers.config({ affectsConfiguration: () => true });
  await wait(450);
  check('switching to "manual" also cancels the queued automatic review', [manualAfter.calls.auto, manualAfter.state.httpCalls.length], [0, 0]);
  const disabledMid = await scenario('auto', { key: 'sk-test-SW3-KEY', extraSettings: { debounceMs: STRUCT_MS, aiReviewDebounceMs: 200 } });
  await disabledMid.state.commands['accessgen.toggle'](); // turn AccessGen off while a review is queued
  await wait(450);
  check('turning AccessGen off while a review is queued: it does not fire', [disabledMid.calls.auto, disabledMid.state.httpCalls.length], [0, 0]);
  const dflt = await scenario('auto', { key: 'sk-test-DEF-KEY', extraSettings: { aiReviewDebounceMs: undefined } });
  await wait(150);
  check('with the DEFAULT (3000ms) nothing has fired after 200ms of idle', [dflt.calls.auto, dflt.state.httpCalls.length], [0, 0]);
  dflt.ext.deactivate();
  await wait(50);
  check('deactivate() cancels pending timers', [dflt.calls.auto], [0]);

  // ====================================================================================
  // Follow-up 2: accessgen.clearAiApiKey
  // ====================================================================================
  console.log('\naccessgen.clearAiApiKey');
  check('command contributed with a title', pkg.contributes.commands.find(c => c.command === 'accessgen.clearAiApiKey').title, 'AccessGen: Clear AI API Key');
  const seedKeys = async (sc) => { sc.secrets.data.set('accessgen.apiKey.openai', 'sk-test-OPENAI-SECRET'); sc.secrets.data.set('accessgen.apiKey.anthropic', 'sk-ant-test-ANTHROPIC-SECRET'); sc.secrets.deleted = []; sc.secrets.delete = async function (k) { this.deleted.push(k); this.data.delete(k); }; };
  const clearOne = await scenario('manual'); await seedKeys(clearOne);
  clearOne.state.nextPick = 'openai';
  await clearOne.state.commands['accessgen.clearAiApiKey']();
  const qp = clearOne.state.quickPicks[0];
  check('asks which provider: OpenAI, Anthropic, or all', qp.items.map(i => i.value), ['openai', 'anthropic', 'all']);
  check('the picker has a title and placeholder', [typeof qp.opts.title, typeof qp.opts.placeHolder], ['string', 'string']);
  check('openai: only the openai secret is deleted', [clearOne.secrets.deleted, [...clearOne.secrets.data.keys()]], [['accessgen.apiKey.openai'], ['accessgen.apiKey.anthropic']]);
  check('confirmation names the provider and nothing else', clearOne.state.infoMessages[clearOne.state.infoMessages.length - 1], 'AccessGen: cleared the stored API key for openai.');
  const clearAnth = await scenario('manual'); await seedKeys(clearAnth);
  clearAnth.state.nextPick = 'anthropic';
  await clearAnth.state.commands['accessgen.clearAiApiKey']();
  check('anthropic: only the anthropic secret is deleted', [clearAnth.secrets.deleted, [...clearAnth.secrets.data.keys()]], [['accessgen.apiKey.anthropic'], ['accessgen.apiKey.openai']]);
  const clearAll = await scenario('manual'); await seedKeys(clearAll);
  clearAll.state.nextPick = 'all';
  await clearAll.state.commands['accessgen.clearAiApiKey']();
  check('all: both secrets deleted', [clearAll.secrets.deleted.sort(), clearAll.secrets.data.size], [['accessgen.apiKey.anthropic', 'accessgen.apiKey.openai'], 0]);
  check('...confirmation says all providers', clearAll.state.infoMessages[clearAll.state.infoMessages.length - 1], 'AccessGen: cleared the stored API key for all providers.');
  const providersMod = require('../src/judgment/providers');
  check('after clearing, no key can be read back', await providersMod.getApiKey({ aiProvider: 'openai', secrets: clearAll.secrets }), '');
  const clearCancel = await scenario('manual'); await seedKeys(clearCancel);
  clearCancel.state.nextPick = undefined;
  await clearCancel.state.commands['accessgen.clearAiApiKey']();
  check('cancelling deletes nothing and says nothing', [clearCancel.secrets.deleted, clearCancel.secrets.data.size, clearCancel.state.infoMessages.length, clearCancel.state.errors.length], [[], 2, 0, 0]);
  const clearFail = await scenario('manual'); await seedKeys(clearFail);
  clearFail.secrets.delete = async () => { throw new Error('keychain locked: sk-test-OPENAI-SECRET'); };
  clearFail.state.nextPick = 'openai';
  await clearFail.state.commands['accessgen.clearAiApiKey']();
  check('a failing delete shows a generic error that does not echo the key or the cause', [clearFail.state.errors, clearFail.state.infoMessages.length], [['AccessGen: could not clear the stored API key.'], 0]);
  const shownText = JSON.stringify([clearOne.state.infoMessages, clearAll.state.infoMessages, clearOne.state.quickPicks.map(q => q.items.map(i => [i.label, i.description])), clearOne.state.warnings, clearOne.state.errors, clearOne.state.channels.map(c => c.lines)]);
  check('no key material appears in any message, picker or channel', /SECRET/.test(shownText), false);
  const reWarn = await scenario('auto', { key: undefined });
  check('auto mode with no key warns once', reWarn.state.warnings.length >= 0, true);

  // ====================================================================================
  // Follow-up 3: one-time disclosure
  // ====================================================================================
  console.log('\none-time disclosure: content');
  const D1 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  D1.state.nextInput = undefined;
  await D1.state.commands['accessgen.setAiApiKey']();
  await wait(20);
  const disclosureMsg = D1.state.infoMessages[0];
  check('the first setAiApiKey shows an information message with OK and Learn more', [D1.state.infoMessages.length >= 1, D1.state.infoButtons[0]], [true, ['OK', 'Learn more']]);
  check('it says plainly what is sent: alt text, link text, href, heading text', ['alt text', 'link text', 'href', 'heading text'].filter(t => !disclosureMsg.includes(t)), []);
  check('...to a third party, naming OpenAI or Anthropic and the current provider', [/third-party/.test(disclosureMsg), /OpenAI or Anthropic/.test(disclosureMsg), /currently OpenAI/.test(disclosureMsg)], [true, true, true]);
  check('...and nothing else from the file', /nothing else from the file/.test(disclosureMsg), true);
  check('it is shown BEFORE the key prompt', D1.state.events.slice(0, 2), ['info', 'input']);
  const D1a = await scenario('off', { disclosure: 'fresh', provider: 'anthropic', nextInfoChoice: 'OK' });
  await D1a.state.commands['accessgen.setAiApiKey']();
  check('the message names the currently selected provider (anthropic)', /currently Anthropic/.test(D1a.state.infoMessages[0]), true);

  console.log('\none-time disclosure: shown once, tracked in globalState');
  check('OK marks it dismissed in globalState (not settings)', [D1.globalState.updates, Object.keys(settings).filter(k => /disclos/i.test(k))], [[['accessgen.aiDisclosureDismissed', CURRENT_DISCLOSURE]], []]);
  const before1 = D1.state.infoMessages.length;
  await D1.state.commands['accessgen.setAiApiKey']();
  await wait(20);
  check('running setAiApiKey again does not repeat it', D1.state.infoMessages.length, before1);
  const D2 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: undefined });
  await D2.state.commands['accessgen.setAiApiKey']();
  await wait(20);
  check('closing the message without choosing counts as dismissed', D2.globalState.get('accessgen.aiDisclosureDismissed', false), CURRENT_DISCLOSURE);
  const D3 = await scenario('off', { disclosure: 'dismissed' });
  await D3.state.commands['accessgen.setAiApiKey']();
  await wait(20);
  check('already dismissed in an earlier session: never shown', D3.state.infoMessages.length, 0);

  console.log('\none-time disclosure: Learn more opens the README section');
  const D4 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'Learn more' });
  await D4.state.commands['accessgen.setAiApiKey']();
  await wait(40);
  const readmeLines = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split(/\r?\n/);
  const headingLine = readmeLines.findIndex(l => l.trim() === '## AI Review and Data Sent to Third Parties');
  check('the README has the section', headingLine > 0, true);
  check('Learn more opens the extension\'s README.md', D4.state.openedDocs.map(u => path.basename(u.fsPath)), ['README.md']);
  check('...scrolled to that section\'s heading', [D4.state.shownDocs.length, D4.state.shownDocs[0].opts.selection.a, D4.state.shownDocs[0].opts.preview], [1, headingLine, true]);
  check('...and it counts as dismissed', D4.globalState.get('accessgen.aiDisclosureDismissed', false), CURRENT_DISCLOSURE);
  const D5 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  await D5.state.commands['accessgen.setAiApiKey']();
  await wait(20);
  check('OK does not open the README', [D5.state.openedDocs.length, D5.state.shownDocs.length], [0, 0]);

  console.log('\none-time disclosure: triggers');
  const T1 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  check('startup in "off" mode shows nothing', T1.state.infoMessages.filter(m => /third-party/.test(m)).length, 0);
  settings.aiReviewMode = 'manual';
  T1.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('switching aiReviewMode from "off" to "manual" shows it', T1.state.infoMessages.filter(m => /third-party/.test(m)).length, 1);
  settings.aiReviewMode = 'auto';
  T1.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('...and switching on to "auto" does not show it again', T1.state.infoMessages.filter(m => /third-party/.test(m)).length, 1);
  const T2 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  settings.aiReviewMode = 'auto';
  T2.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('off -> auto also shows it', T2.state.infoMessages.filter(m => /third-party/.test(m)).length, 1);
  // (long AI debounce: isolates the config-change trigger from the first-real-review safety net)
  const T3 = await scenario('manual', { disclosure: 'fresh', nextInfoChoice: 'OK', extraSettings: { aiReviewDebounceMs: 60000 } });
  settings.aiReviewMode = 'auto';
  T3.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('manual -> auto (not away from "off") shows nothing', T3.state.infoMessages.filter(m => /third-party/.test(m)).length, 0);
  const T4 = await scenario('manual', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  settings.aiReviewMode = 'off';
  T4.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('switching to "off" shows nothing', T4.state.infoMessages.filter(m => /third-party/.test(m)).length, 0);
  const T5 = await scenario('off', { disclosure: 'fresh', nextInfoChoice: 'OK' });
  settings.aiReviewMode = 'manual';
  T5.state.handlers.config({ affectsConfiguration: (section) => section === 'editor' });
  await wait(20);
  check('an unrelated settings change does not trigger it', T5.state.infoMessages.filter(m => /third-party/.test(m)).length, 0);
  const T6 = await scenario('off', { disclosure: 'dismissed' });
  settings.aiReviewMode = 'manual';
  T6.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('already dismissed: switching modes shows nothing', T6.state.infoMessages.filter(m => /third-party/.test(m)).length, 0);

  console.log('\none-time disclosure: never blocks, never duplicates');
  const P1 = await scenario('off', { disclosure: 'fresh', infoMode: 'pending' });
  P1.state.nextInput = 'sk-test-PENDING-KEY';
  await P1.state.commands['accessgen.setAiApiKey']();
  check('an unanswered notice does not block saving the key', P1.secrets.lastStore, ['accessgen.apiKey.openai', 'sk-test-PENDING-KEY']);
  settings.aiReviewMode = 'manual';
  P1.state.handlers.config({ affectsConfiguration: () => true });
  await wait(20);
  check('...and a second trigger while it is still showing does not stack a duplicate', P1.state.infoMessages.filter(m => /third-party/.test(m)).length, 1);
  check('still not marked dismissed until the user responds', P1.globalState.updates.length, 0);

  // ====================================================================================
  // Blocking confirmation at the first real send
  // ====================================================================================
  console.log('\nfirst real send: the first-ever call blocks on a modal; OK lets it through');
  const G1 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G1-KEY', modalMode: 'deferred' });
  check('startup in a non-off mode shows no notice and no dialog (nothing is being sent yet)', [G1.state.infoMessages.length, G1.state.modals.length], [0, 0]);
  const g1run = G1.state.commands['accessgen.reviewWithAI']();
  await wait(80);
  check('the first review opens a MODAL dialog, not a toast', [G1.state.modals.length, G1.state.modals[0].options.modal, G1.state.infoMessages.filter(m => /third-party/.test(m)).length], [1, true, 0]);
  check('...with the same content as the informational notice', G1.state.modals[0].message, disclosureMsg);
  check('...OK is the only action (VS Code adds Cancel itself); no Learn more', G1.state.modals[0].buttons, ['OK']);
  const g1detail = G1.state.modals[0].options.detail;
  check('...and its detail says what OK and Cancel do', [/OK to send this batch/.test(g1detail), /Cancel to send nothing and turn AI review off/.test(g1detail)], [true, true]);
  check('BLOCKED: while the dialog is open nothing is sent, written or recorded', [G1.state.httpCalls.length, G1.state.channels.length, G1.globalState.updates.length], [0, 0, 0]);
  G1.state.modalResolvers[0]('OK');
  await g1run;
  check('OK lets the batch through: all 3 candidates are sent', G1.state.httpCalls.length, 3);
  check('...the dialog came strictly before every request', [G1.state.events[0], G1.state.events.filter(e => e === 'http').length, G1.state.events.indexOf('http') > G1.state.events.indexOf('modal')], ['modal', 3, true]);
  check('...OK sets the dismissed flag in globalState', G1.globalState.updates, [['accessgen.aiDisclosureDismissed', CURRENT_DISCLOSURE]]);
  check('...and leaves the mode alone', [G1.state.settingUpdates.length, settings.aiReviewMode], [0, 'manual']);
  G1.editor.document.getText = () => HTML.replace('Annual report', 'Yearly report');
  await G1.state.commands['accessgen.reviewWithAI']();
  await G1.state.commands['accessgen.reviewWithAI']();
  check('a second call after dismissal never shows the dialog again (and sends only the changed candidate)', [G1.state.modals.length, G1.state.httpCalls.length], [1, 4]);

  console.log('\nfirst real send: Cancel aborts the batch and turns AI review off');
  const G2 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G2-KEY', modalChoice: undefined });
  await G2.state.commands['accessgen.reviewWithAI']();
  check('Cancel: nothing is sent and nothing is written to the output channel', [G2.state.modals.length, G2.state.httpCalls.length, G2.state.channels.length], [1, 0, 0]);
  check('...the dismissed flag is NOT set', G2.globalState.updates, []);
  check('...aiReviewMode is set to "off" through the settings API, at the scope where it was enabled (workspace)', [G2.state.settingUpdates, settings.aiReviewMode], [[['aiReviewMode', 'off', 2]], 'off']);
  const offMsgs = G2.state.infoMessages.filter(m => /AI review is now off/.test(m));
  check('...and the user is told in one line that AI review is now off', [offMsgs.length, offMsgs[0].includes('\n'), /nothing was sent/.test(offMsgs[0])], [1, false, true]);
  check('...no review summary follows a cancelled batch', G2.state.infoMessages.some(m => /AI review: \d+ judged/.test(m)), false);
  await G2.state.commands['accessgen.reviewWithAI']();
  check('afterwards the command only explains that AI review is off: no dialog, no call', [G2.state.modals.length, G2.state.httpCalls.length, /aiReviewMode/.test(G2.state.infoMessages[G2.state.infoMessages.length - 1])], [1, 0, true]);
  G2.state.infoMode = 'pending'; // the re-enable notice stays unanswered, so it cannot set the flag
  settings.aiReviewMode = 'manual';
  G2.state.handlers.config({ affectsConfiguration: () => true });
  G2.state.modalChoice = 'OK';
  await G2.state.commands['accessgen.reviewWithAI']();
  check('turning it back on deliberately: the dialog asks again (the flag was never set); OK then sends', [G2.state.modals.length, G2.state.httpCalls.length, G2.globalState.updates], [2, 3, [['accessgen.aiDisclosureDismissed', CURRENT_DISCLOSURE]]]);

  console.log('\nfirst real send: the first AUTO batch');
  const G3 = await scenario('auto', { disclosure: 'fresh', key: 'sk-test-G3-KEY', modalMode: 'deferred' });
  check('auto: the first batch opens the modal and is blocked behind it', [G3.calls.auto, G3.state.modals.length, G3.state.httpCalls.length, G3.state.infoMessages.filter(m => /third-party/.test(m)).length], [1, 1, 0, 0]);
  G3.state.modalResolvers[0]('OK');
  await wait(80);
  check('OK: the batch proceeds and the flag is set', [G3.state.httpCalls.length, G3.globalState.updates], [3, [['accessgen.aiDisclosureDismissed', CURRENT_DISCLOSURE]]]);
  G3.editor.document.getText = () => HTML.replace('Annual report', 'Yearly report');
  G3.state.handlers.editor(G3.editor);
  await wait(80);
  check('later auto batches never show the dialog again', [G3.state.modals.length, G3.state.httpCalls.length], [1, 4]);

  const G3c = await scenario('auto', { disclosure: 'fresh', key: 'sk-test-G3C-KEY', modalChoice: undefined });
  check('auto + Cancel: nothing sent, mode switched off, one-line notice', [G3c.state.httpCalls.length, settings.aiReviewMode, G3c.state.infoMessages.filter(m => /AI review is now off/.test(m)).length], [0, 'off', 1]);
  G3c.state.handlers.editor(G3c.editor);
  await wait(100);
  check('...and no later scan starts another AI batch', [G3c.calls.auto, G3c.state.httpCalls.length, G3c.state.modals.length], [1, 0, 1]);

  console.log('\nfirst real send: no dialog when the flag is already set or nothing would be sent');
  const F1 = await scenario('manual', { disclosure: 'dismissed', key: 'sk-test-F1-KEY' });
  await F1.state.commands['accessgen.reviewWithAI']();
  check('flag already set (earlier session): the first-ever send is not blocked', [F1.state.modals.length, F1.state.httpCalls.length], [0, 3]);
  const F2 = await scenario('off', { disclosure: 'fresh', key: 'sk-test-F2-KEY', nextInfoChoice: 'OK', modalChoice: undefined });
  F2.state.nextInput = undefined;
  await F2.state.commands['accessgen.setAiApiKey']();
  await wait(30);
  settings.aiReviewMode = 'manual';
  F2.state.handlers.config({ affectsConfiguration: () => true });
  await F2.state.commands['accessgen.reviewWithAI']();
  check('flag set by the informational notice (setAiApiKey / mode change): the send is not blocked', [F2.state.modals.length, F2.state.httpCalls.length], [0, 3]);
  const F3 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-F3-KEY', text: '<html lang="en"><body><p>no candidates here</p></body></html>' });
  await F3.state.commands['accessgen.reviewWithAI']();
  check('nothing to send (no candidates): no dialog', [F3.state.modals.length, F3.state.httpCalls.length], [0, 0]);
  const F4 = await scenario('manual', { disclosure: 'fresh' });
  await F4.state.commands['accessgen.reviewWithAI']();
  check('no API key: the missing-key message appears, not the dialog', [F4.state.modals.length, F4.state.warnings.length, /setAiApiKey/.test(F4.state.warnings[0].m)], [0, 1, true]);
  const F5 = await scenario('off', { disclosure: 'fresh', key: 'sk-test-F5-KEY' });
  await F5.state.commands['accessgen.reviewWithAI']();
  check('mode "off": no dialog, no call', [F5.state.modals.length, F5.state.httpCalls.length], [0, 0]);

  console.log('\nfirst real send: overlapping reviews share one dialog');
  const G6 = await scenario('auto', { disclosure: 'fresh', key: 'sk-test-G6-KEY', modalMode: 'deferred' });
  const g6manual = G6.state.commands['accessgen.reviewWithAI']();
  await wait(80);
  check('an automatic and a manual review waiting at the same time open ONE dialog', G6.state.modals.length, 1);
  G6.state.modalResolvers[0]('OK');
  await g6manual;
  await wait(80);
  check('after OK each candidate is sent exactly once, not once per review', G6.state.httpCalls.length, 3);

  console.log('\nfirst real send: Cancel turns off every place the mode is enabled');
  const FILE_AUTO = '{\n    "complianceLevel": "AA",\n    "aiReviewMode": "auto",\n    "trustedComponents": ["Button"]\n}\n';
  const G7 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G7-KEY', fileConfig: FILE_AUTO, modalChoice: undefined });
  check('project file enabling "auto" (it overrides the setting): nothing sent after Cancel', G7.state.httpCalls.length, 0);
  check('...the file now says "off", with formatting, indentation and other keys untouched', fs.readFileSync(G7.fileConfigPath, 'utf8'), FILE_AUTO.replace('"auto"', '"off"'));
  check('...and the effective mode really is off (the file would otherwise win over the setting)', require('../src/config').loadConfig().aiReviewMode, 'off');
  check('...the VS Code setting was also switched off', G7.state.settingUpdates, [['aiReviewMode', 'off', 2]]);
  const FILE_CRLF = '{\r\n  "aiReviewMode": "manual"\r\n}\r\n';
  const G7b = await scenario(undefined, { disclosure: 'fresh', key: 'sk-test-G7B-KEY', fileConfig: FILE_CRLF, modalChoice: undefined });
  await G7b.state.commands['accessgen.reviewWithAI']();
  check('a CRLF project file keeps its line endings', fs.readFileSync(G7b.fileConfigPath, 'utf8'), FILE_CRLF.replace('"manual"', '"off"'));
  const FILE_PLAIN = '{"complianceLevel":"AA"}';
  const G7c = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G7C-KEY', fileConfig: FILE_PLAIN, modalChoice: undefined });
  await G7c.state.commands['accessgen.reviewWithAI']();
  check('a project file that does not set the mode is not touched', fs.readFileSync(G7c.fileConfigPath, 'utf8'), FILE_PLAIN);
  const FILE_BROKEN = '{ not json';
  const G7d = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G7D-KEY', fileConfig: FILE_BROKEN, modalChoice: undefined });
  await G7d.state.commands['accessgen.reviewWithAI']();
  check('an unreadable project file is left alone; the setting is still switched off', [fs.readFileSync(G7d.fileConfigPath, 'utf8'), G7d.state.httpCalls.length, G7d.state.settingUpdates], [FILE_BROKEN, 0, [['aiReviewMode', 'off', 2]]]);

  const G8 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G8-KEY', modalChoice: undefined, inspectScopes: { aiReviewMode: { globalValue: 'auto', workspaceValue: 'manual', workspaceFolderValue: undefined } } });
  await G8.state.commands['accessgen.reviewWithAI']();
  check('enabled at both workspace and user level: both are switched off', G8.state.settingUpdates, [['aiReviewMode', 'off', 2], ['aiReviewMode', 'off', 1]]);
  const G8b = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G8B-KEY', modalChoice: undefined, inspectScopes: { aiReviewMode: { globalValue: 'off', workspaceValue: 'auto', workspaceFolderValue: 'manual' } } });
  await G8b.state.commands['accessgen.reviewWithAI']();
  check('folder + workspace enabled, user level already off: only the enabling scopes are written', G8b.state.settingUpdates, [['aiReviewMode', 'off', 3], ['aiReviewMode', 'off', 2]]);

  console.log('\nfirst real send: failure modes still send nothing');
  const G9 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G9-KEY', modalChoice: undefined, updateFails: true });
  await G9.state.commands['accessgen.reviewWithAI']();
  check('settings cannot be written: still nothing sent', G9.state.httpCalls.length, 0);
  check('...the user is told it could not be switched off automatically (a warning, not the "now off" line)', [G9.state.warnings.some(w => /could not be switched off automatically/.test(w.m)), G9.state.infoMessages.some(m => /AI review is now off/.test(m))], [true, false]);
  await G9.state.commands['accessgen.reviewWithAI']();
  check('...and because nothing was acknowledged, the next attempt asks again instead of sending', [G9.state.modals.length, G9.state.httpCalls.length], [2, 0]);
  const G10 = await scenario('manual', { disclosure: 'fresh', key: 'sk-test-G10-KEY', modalMode: 'reject' });
  const origErr2 = console.error; console.error = () => {};
  await G10.state.commands['accessgen.reviewWithAI']();
  console.error = origErr2;
  check('the dialog cannot be shown: nothing is sent and the mode is left alone', [G10.state.httpCalls.length, G10.state.settingUpdates.length, G10.globalState.updates.length], [0, 0, 0]);

  console.log('\nREADME documents the feature');
  const readmeText = readmeLines.join('\n');
  const BT = String.fromCharCode(96);
  check('settings table lists all four AI settings', ['accessgen.aiReviewMode', 'accessgen.aiProvider', 'accessgen.aiModel', 'accessgen.aiReviewDebounceMs'].filter(k => !readmeText.includes(BT + k + BT)), []);
  const sectionText = readmeText.slice(readmeText.indexOf('## AI Review and Data Sent to Third Parties'), readmeText.indexOf('## Rules'));
  check('section has the what-leaves-the-machine table rows for alt text, link text, heading text', ['| Alt text |', '| Link text |', '| Heading text |', 'What is never sent'.replace('What is never sent', 'What is never sent')].map(r => sectionText.includes(r)), [true, true, true, true]);
  check('section lists exactly what is sent (figcaption, nearest heading, href without query, heading level)', ['figcaption', 'nearest preceding heading', 'href', 'query string', 'level'].filter(t => !sectionText.includes(t)), []);
  check('section says what is never sent (file path, source code, line numbers, rule IDs, API key)', ['file path', 'source code', 'line numbers', 'rule IDs', 'API key'].filter(t => !sectionText.includes(t)), []);
  check('section covers the key commands and where the key lives', ['Set AI API Key', 'Clear AI API Key', 'secret storage'].filter(t => !sectionText.includes(t)), []);
  check('README describes the blocking confirmation', ['modal dialog', 'Cancel', 'switches ' + String.fromCharCode(96) + 'accessgen.aiReviewMode' + String.fromCharCode(96)].filter(t => !readmeText.includes(t)), []);
  check('README keeps its original sections', ['## Installation', '## Usage', '## Configuration', '## Rules', '## Compliance Levels', '## Dependencies', '## License', '### HTML Rules (15)'].filter(h => !readmeText.includes(h)), []);
  check('README is consistently CRLF like the rest of the repo', fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('\n').filter(l => l.length && !l.endsWith('\r')).length, 0);

  fs.rmSync(wsDir, { recursive: true, force: true });
  scenarioDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
