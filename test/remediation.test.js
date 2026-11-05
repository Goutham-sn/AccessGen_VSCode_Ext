// Tests for remediationMode (manual / hybrid / auto), the per-rule fixTier gate, and the inline-diff
// review-and-accept flow (nothing is applied without an explicit Accept).
// Drives the REAL extension.js with a stubbed `vscode` whose applyEdit really edits a fake document
// and fires the change event, so the scan -> suggest -> Accept -> rescan loop is exercised end to end.
// No network, no real VS Code. Run: node test/remediation.test.js
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ vscode stub
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); }
    else { this.start = a; this.end = b; }
  }
}
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } }
class Anything { constructor(...a) { this.args = a; } }
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class EventEmitter { constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; } fire() { this.listeners.forEach(f => f()); } }

let settings = {};
let state;
let currentVscode;

function offsetOf(text, pos) {
  const lines = text.split('\n');
  let off = 0;
  for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
  return off + pos.character;
}

function makeVscode() {
  const st = state = {
    channels: [], statusMessages: [], infoMessages: [], commands: {}, handlers: {}, diagnostics: [], lastDiagnostics: [],
    applyCalls: [], applyMode: 'normal', codeActionProvider: null, codeLensProvider: null, doc: null,
    decoTypes: [], decoCalls: []
  };
  const noop = () => ({ dispose() {} });
  return {
    Range, Position, Diagnostic, WorkspaceEdit, CodeAction, CodeLens, EventEmitter, MarkdownString, Hover: Anything, ThemeColor: Anything,
    CodeActionKind: { QuickFix: 'quickfix' }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 }, OverviewRulerLane: { Right: 4 }, DecorationRangeBehavior: { ClosedClosed: 0 },
    workspace: {
      get workspaceFolders() { return undefined; },
      getConfiguration: () => ({ get: (k, d) => (settings[k] !== undefined ? settings[k] : d), update() { return Promise.resolve(); }, inspect: () => ({}) }),
      onDidChangeTextDocument: (h) => { st.handlers.doc = h; return noop(); },
      onDidChangeConfiguration: (h) => { st.handlers.config = h; return noop(); },
      // Like the real API: applies the replacements to the document, then fires the change event.
      applyEdit: async (edit) => {
        st.applyCalls.push({ count: edit.edits.length, uris: [...new Set(edit.edits.map(e => e.uri.toString()))], edits: edit.edits });
        if (st.applyMode === 'throw') throw new Error('workspace is read-only');
        if (st.applyMode === 'reject') return false;
        if (st.applyMode === 'noop') return true; // claims success but the text does not change
        const doc = st.doc;
        let text = doc.text;
        const sorted = [...edit.edits].sort((a, b) => offsetOf(text, b.range.start) - offsetOf(text, a.range.start));
        for (const e of sorted) text = text.slice(0, offsetOf(text, e.range.start)) + e.text + text.slice(offsetOf(text, e.range.end));
        doc.text = text; doc.version++;
        if (st.handlers.doc) st.handlers.doc({ document: doc });
        return true;
      }
    },
    window: {
      activeTextEditor: null,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: (m) => { st.infoMessages.push(m); return Promise.resolve(undefined); },
      showWarningMessage: () => Promise.resolve(undefined),
      showErrorMessage() {},
      setStatusBarMessage: (m) => { st.statusMessages.push(m); },
      // Records every type created; the inline-diff ones are told apart by their options.
      createTextEditorDecorationType: (options) => {
        const t = { options, kind: options && options.textDecoration === 'line-through' ? 'removed' : options && options.after && !options.textDecoration ? 'added' : 'other', disposed: false, dispose() { this.disposed = true; } };
        st.decoTypes.push(t);
        return t;
      },
      onDidChangeActiveTextEditor: (h) => { st.handlers.editor = h; return noop(); },
      createOutputChannel: (name) => {
        const ch = { name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} };
        st.channels.push(ch);
        return ch;
      }
    },
    commands: { registerCommand: (id, fn) => { st.commands[id] = fn; return noop(); }, executeCommand: () => Promise.resolve() },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, d) => { st.lastDiagnostics = d; st.diagnostics.push(d.map(x => ({ code: x.code, line: x.range.start.line, msg: x.message }))); },
        delete() {}, clear() {}, dispose() {}
      }),
      registerHoverProvider: noop,
      registerCodeActionsProvider: (sel, provider) => { st.codeActionProvider = provider; return noop(); },
      registerCodeLensProvider: (sel, provider) => { st.codeLensSelector = sel; st.codeLensProvider = provider; return noop(); }
    }
  };
}

currentVscode = makeVscode();
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? currentVscode : origLoad.call(this, req, ...rest);
};
const srcDir = path.join(__dirname, '..', 'src') + path.sep;
function freshModules() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  currentVscode = makeVscode();
}

// ------------------------------------------------------------------ fixtures + scenario
// Each block carries a literal background-color: the fix computes its outline color from it.
// light card -> black outline, dark button -> white outline.
const CSS = ['a:focus {', '  background-color: #ffffff;', '  outline: none;', '}', 'button:focus {', '  background-color: #1a1a2e;', '  outline: 0;', '}', ''].join('\n');
const FIXED_A = 'outline: 2px solid #000000; outline-offset: -2px;';
const FIXED_B = 'outline: 2px solid #ffffff; outline-offset: -2px;';
const BG_A = 'a:focus {\n  background-color: #ffffff;\n  ';
const BG_B = 'button:focus {\n  background-color: #1a1a2e;\n  ';
const CSS_FIXED = ['a:focus {', '  background-color: #ffffff;', '  ' + FIXED_A, '}', 'button:focus {', '  background-color: #1a1a2e;', '  ' + FIXED_B, '}', ''].join('\n');
const CLEAN = 'a { color: red; }\n';

// opts: mode, text, debounceMs, applyMode, setup(ruleModule), languageId, uriName
async function scenario(opts = {}) {
  // tier: the fixTier the CSS tests run with. Stated explicitly so they do not depend on what the shipped
  // outline-removed is tagged ('real' leaves the shipped tag in place). patch: extra module setup.
  const { mode, text = CSS, debounceMs = 30, applyMode = 'normal', setup, languageId = 'css', uriName = 'style.css', tier = 'safe', patch } = opts;
  freshModules();
  settings = { debounceMs, ...(mode ? { remediationMode: mode } : {}) };
  state.applyMode = applyMode;
  const rule = require('../src/rules/css/outline-removed');
  if (tier !== 'real') rule.fixTier = tier;
  if (patch) patch();
  if (setup) setup(rule);
  const uri = { fsPath: 'C:/ws/' + uriName, toString: () => 'file:///c:/ws/' + uriName };
  const doc = {
    languageId, uri, text, version: 1,
    getText() { return this.text; },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(i) { const t = this.text.split('\n')[i] || ''; return { text: t, range: { end: { character: t.length } } }; }
  };
  state.doc = doc;
  const own = state; // this scenario's own state (the global is replaced by the next scenario)
  const editor = {
    document: doc,
    // Every call is recorded; the inline-diff types are told apart by their options (see createTextEditorDecorationType)
    setDecorations(type, opts) { if (type && type.kind && type.kind !== 'other') own.decoCalls.push({ kind: type.kind, opts }); }
  };
  currentVscode.window.activeTextEditor = editor;
  const ext = require('../src/extension');
  const context = { subscriptions: [] };
  ext.activate(context);
  await wait(debounceMs + 120);
  const sc = {
    state, doc, editor, ext, rule,
    // the user types: text changes and VS Code fires the change event
    type(t) { doc.text = t; doc.version++; state.handlers.doc({ document: doc }); },
    setSilently(t) { doc.text = t; doc.version++; },
    rescan() { state.handlers.editor(editor); },
    actions() { return state.codeActionProvider.provideCodeActions(doc, new Range(0, 0, 0, 0), { diagnostics: state.lastDiagnostics }); },
    outlineActions() { return sc.actions().filter(a => /outline-removed/.test(a.title)); },
    channel(name) { return state.channels.find(c => c.name === name); },
    autoLines() { const c = sc.channel('AccessGen Auto-fix'); return c ? c.lines : []; },
    ruleCounts() { const c = {}; state.lastDiagnostics.forEach(d => { c[d.code] = (c[d.code] || 0) + 1; }); return c; },

    // ---- the inline-diff UI as the developer sees it ----
    lenses() { return state.codeLensProvider ? state.codeLensProvider.provideCodeLenses(doc) : []; },
    // one entry per pending suggestion (its Accept lens): { line, id, args }
    pending() { return sc.lenses().filter(l => l.command.command === 'accessgen.acceptInlineFix').map(l => ({ line: l.range.start.line, args: l.command.arguments[0] })); },
    accept(i = 0) { const p = sc.pending()[i]; return p ? state.commands['accessgen.acceptInlineFix'](p.args) : Promise.resolve('nothing pending'); },
    reject(i = 0) { const p = sc.pending()[i]; return p ? state.commands['accessgen.rejectInlineFix'](p.args) : Promise.resolve('nothing pending'); },
    async acceptAll() { let n = 0; while (sc.pending().length && n++ < 20) await sc.accept(0); await wait(debounceMs + 120); },
    // The last decoration set rendered for the old text / the new text: [{ old, range }] / [{ text }]
    lastDeco(kind) { const c = [...state.decoCalls].reverse().find(x => x.kind === kind); return c ? c.opts : null; },
    removedTexts() { const o = sc.lastDeco('removed'); return o ? o.map(d => doc.text.slice(offsetOf(doc.text, d.range.start), offsetOf(doc.text, d.range.end))) : null; },
    addedTexts() { const o = sc.lastDeco('added'); return o ? o.map(d => d.renderOptions.after.contentText.trim()) : null; }
  };
  return sc;
}

(async () => {
  // ============================================================== setting + config
  console.log('\nremediationMode: setting and config');
  const pkg = require('../package.json');
  const prop = pkg.contributes.configuration.properties['accessgen.remediationMode'];
  check('schema: enum manual/hybrid/auto, default manual', [prop.type, prop.enum, prop.default], ['string', ['manual', 'hybrid', 'auto'], 'manual']);
  const cfgWith = (ws, file) => {
    freshModules();
    settings = ws === undefined ? {} : { remediationMode: ws };
    if (file === undefined) return require('../src/config').loadConfig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessgen-rm-'));
    fs.writeFileSync(path.join(dir, 'accessgen.config.json'), JSON.stringify(file));
    Object.defineProperty(currentVscode.workspace, 'workspaceFolders', { get: () => [{ uri: { fsPath: dir } }] });
    const cfg = require('../src/config').loadConfig();
    fs.rmSync(dir, { recursive: true, force: true });
    return cfg;
  };
  check('default is manual', cfgWith().remediationMode, 'manual');
  check('workspace value honoured', ['hybrid', 'auto', 'manual'].map(m => cfgWith(m).remediationMode), ['hybrid', 'auto', 'manual']);
  check('file config overrides the workspace setting', [cfgWith('auto', { remediationMode: 'manual' }).remediationMode, cfgWith('manual', { remediationMode: 'hybrid' }).remediationMode], ['manual', 'hybrid']);
  check('invalid values are ignored (a typo can never enable auto-apply)', [cfgWith('turbo').remediationMode, cfgWith('AUTO').remediationMode, cfgWith('manual', { remediationMode: 'full' }).remediationMode, cfgWith('hybrid', { remediationMode: 'full' }).remediationMode], ['manual', 'manual', 'manual', 'hybrid']);
  check('existing config fields unchanged', (() => { const c = cfgWith(); return [c.complianceLevel, c.aiReviewMode, c.debounceMs]; })(), ['AA', 'off', 800]);

  // ============================================================== tier gate
  console.log('\nfixTier: the per-rule gate');
  freshModules();
  const { isAutoEligible, fixTierOf } = require('../src/remediation/autoFix');
  const withFix = (tier) => ({ fix() { return { newText: 'x' }; }, ...(tier === undefined ? {} : { fixTier: tier }) });
  const matrix = (mode) => ['safe', 'medium', undefined, 'Safe', 'SAFE', 'high', '', true, null, 1].map(t => isAutoEligible(withFix(t), mode));
  check('manual: nothing is ever eligible', matrix('manual'), [false, false, false, false, false, false, false, false, false, false]);
  check('hybrid: only "safe"', matrix('hybrid'), [true, false, false, false, false, false, false, false, false, false]);
  check('auto: "safe" and "medium"', matrix('auto'), [true, true, false, false, false, false, false, false, false, false]);
  check('untagged / misspelled tiers are never eligible in any mode', ['manual', 'hybrid', 'auto', undefined, 'turbo'].map(m => isAutoEligible(withFix(undefined), m) || isAutoEligible(withFix('Safe'), m)), [false, false, false, false, false]);
  check('a tier without fix() is not eligible', ['hybrid', 'auto'].map(m => isAutoEligible({ fixTier: 'safe' }, m)), [false, false]);
  check('unknown mode is never eligible', ['', 'always', null, undefined].map(m => isAutoEligible(withFix('safe'), m)), [false, false, false, false]);
  check('null rule is safe', [isAutoEligible(null, 'auto'), fixTierOf(undefined)], [false, null]);

  console.log('\nfixTier: audit of every rule file');
  const ruleDirs = ['html', 'jsx', 'css'];
  const allRules = [];
  for (const d of ruleDirs) for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'rules', d))) allRules.push(require(`../src/rules/${d}/${f}`));
  const withFixes = allRules.filter(r => typeof r.fix === 'function');
  // (updated: the AI-suggested fixes for the alt-text and link-text rules are now fixers too)
  const byId = (list) => list.map(r => r.id).sort();
  check('exactly these five rules export fix()', byId(withFixes), ['anchor-no-text', 'img-alt-missing', 'jsx-anchor-no-content', 'jsx-img-alt-missing', 'outline-removed']);
  check('...outline-removed is the deterministic one, explicitly tagged "safe"', withFixes.filter(r => r.id === 'outline-removed').map(r => r.fixTier), ['safe']);
  check('...the other four are all tagged "ai-suggested" (never auto-applied)', byId(withFixes.filter(r => r.fixTier === 'ai-suggested')), ['anchor-no-text', 'img-alt-missing', 'jsx-anchor-no-content', 'jsx-img-alt-missing']);
  check('...every fixer is tiered explicitly', withFixes.filter(r => !['safe', 'medium', 'ai-suggested'].includes(r.fixTier)).map(r => r.id), []);
  check('no rule without a fix() carries a tier', allRules.filter(r => typeof r.fix !== 'function' && r.fixTier !== undefined).map(r => r.id), []);
  check('every tier in use is a valid one', allRules.filter(r => r.fixTier !== undefined && !['safe', 'medium', 'ai-suggested'].includes(r.fixTier)).map(r => r.id), []);

  // ============================================================== diagnostics identical across modes
  console.log('\nmode switching does not change what is found');
  const { analyzeDocument } = require('../src/analyzer');
  const direct = {};
  for (const m of ['manual', 'hybrid', 'auto']) direct[m] = JSON.stringify(await analyzeDocument({ getText: () => CSS, languageId: 'css' }, { complianceLevel: 'AA', remediationMode: m, isRuleDisabled: () => false, isTrustedComponent: () => false }));
  check('analyzeDocument returns identical violations in every mode', [direct.manual === direct.hybrid, direct.hybrid === direct.auto, JSON.parse(direct.manual).length], [true, true, 4]);
  const firstScan = {};
  for (const m of ['manual', 'hybrid', 'auto']) { const sc = await scenario({ mode: m }); firstScan[m] = JSON.stringify(sc.state.diagnostics[0]); }
  check('the first published diagnostics are identical in every mode (fixes come after)', [firstScan.manual === firstScan.hybrid, firstScan.hybrid === firstScan.auto], [true, true]);
  check('...and contain 2 outline-removed + 2 focus-visible-missing', (() => { const d = JSON.parse(firstScan.manual); return [d.filter(x => x.code === 'outline-removed').length, d.filter(x => x.code === 'focus-visible-missing').length]; })(), [2, 2]);

  // ============================================================== manual: unchanged
  console.log('\nmanual mode: existing behaviour completely unchanged');
  const man = await scenario({ mode: 'manual' });
  await man.rescan(); await wait(100);
  check('no automatic edit, ever', [man.state.applyCalls.length, man.doc.text], [0, CSS]);
  check('every scan publishes the same diagnostics', man.state.diagnostics.every(d => JSON.stringify(d) === JSON.stringify(man.state.diagnostics[0])), true);
  check('quick fixes are offered, one per fixable violation', man.outlineActions().map(a => a.title), ['AccessGen: Fix outline-removed (review inserted values)', 'AccessGen: Fix outline-removed (review inserted values)']);
  check('each quick fix is an edit replacing the declaration', man.outlineActions().map(a => [a.edit.edits.length, a.edit.edits[0].text]), [[1, FIXED_A], [1, FIXED_B]]);
  check('no auto-fix channel, no auto-fix status message (the activation toast is a separate, existing message)', [man.channel('AccessGen Auto-fix'), man.state.statusMessages.filter(m => /auto-applied/.test(m)).length], [undefined, 0]);
  const unset = await scenario({});
  check('mode unset behaves exactly as manual', [unset.state.applyCalls.length, unset.doc.text === CSS, unset.outlineActions().length], [0, true, 2]);

  // ============================================================== tiers x modes
  console.log('\nsafe tier is SUGGESTED inline in hybrid and auto: nothing applies until Accept');
  for (const mode of ['hybrid', 'auto']) {
    const sc = await scenario({ mode });
    check(`${mode}: after the scan NOTHING is applied (no edit, document untouched)`, [sc.state.applyCalls.length, sc.doc.text === CSS], [0, true]);
    check(`${mode}: two pending suggestions, one per violation, on the violating lines`, sc.pending().map(p => p.line), [2, 6]);
    check(`${mode}: the old range is decorated: exactly the old text`, sc.removedTexts(), ['outline: none;', 'outline: 0;']);
    check(`${mode}: the suggested new text is rendered after it`, sc.addedTexts(), [FIXED_A, FIXED_B]);
    check(`${mode}: each suggestion has "✓ Accept fix" and "✗ Dismiss" above its line`, sc.lenses().map(l => l.command.title), ['✓ Accept fix', '✗ Dismiss', '✓ Accept fix', '✗ Dismiss']);
    await sc.acceptAll();
    check(`${mode}: Accept produces the change the old silent auto-apply made: both violations fixed`, sc.doc.text, CSS_FIXED);
    check(`${mode}: one edit per Accept, one replacement each`, [sc.state.applyCalls.length, sc.state.applyCalls.map(c => c.count)], [2, [1, 1]]);
    check(`${mode}: the rescan no longer reports outline-removed`, sc.ruleCounts()['outline-removed'], undefined);
    check(`${mode}: nothing left pending; the decorations and lenses are cleared`, [sc.pending().length, sc.lenses().length, sc.lastDeco('removed'), sc.lastDeco('added')], [0, 0, [], []]);
    check(`${mode}: no further edits on later scans`, (await (async () => { sc.rescan(); await wait(100); return sc.state.applyCalls.length; })()), 2);
    check(`${mode}: the quick fix is still a manual option while a violation exists (checked on the first scan)`, sc.state.diagnostics[0].filter(d => d.code === 'outline-removed').length, 2);
  }

  console.log('\nmedium tier is suggested only in auto');
  const asMedium = (r) => { r.fixTier = 'medium'; };
  const medHybrid = await scenario({ mode: 'hybrid', setup: asMedium });
  check('hybrid: a "medium" fix is NOT suggested', [medHybrid.state.applyCalls.length, medHybrid.pending().length, medHybrid.doc.text], [0, 0, CSS]);
  check('hybrid: ...it stays available as a quick fix', medHybrid.outlineActions().length, 2);
  const medAuto = await scenario({ mode: 'auto', setup: asMedium });
  check('auto: a "medium" fix IS suggested, and not applied yet', [medAuto.pending().length, medAuto.state.applyCalls.length, medAuto.doc.text], [2, 0, CSS]);
  await medAuto.acceptAll();
  check('auto: ...Accept applies it', [medAuto.state.applyCalls.length, medAuto.doc.text], [2, CSS_FIXED]);
  const medManual = await scenario({ mode: 'manual', setup: asMedium });
  check('manual: a "medium" fix is not suggested', [medManual.state.applyCalls.length, medManual.pending().length, medManual.doc.text], [0, 0, CSS]);

  console.log('\nuntagged / invalid tier is never suggested, in any mode');
  for (const [label, setup] of [['no fixTier', (r) => { delete r.fixTier; }], ['"Safe" (wrong case)', (r) => { r.fixTier = 'Safe'; }], ['"high"', (r) => { r.fixTier = 'high'; }], ['true', (r) => { r.fixTier = true; }], ['empty string', (r) => { r.fixTier = ''; }]]) {
    const results = [];
    for (const mode of ['manual', 'hybrid', 'auto']) { const sc = await scenario({ mode, setup }); results.push([sc.state.applyCalls.length, sc.pending().length, sc.doc.text === CSS, sc.outlineActions().length]); }
    check(label + ': never suggested or applied; always still a manual quick fix', results, [[0, 0, true, 2], [0, 0, true, 2], [0, 0, true, 2]]);
  }
  const noFixRule = await scenario({ mode: 'auto', setup: () => { require('../src/rules/css/focus-visible-missing').fixTier = 'safe'; } });
  check('a tier on a rule that has no fix() does nothing (and breaks nothing)', [noFixRule.pending().length, noFixRule.state.applyCalls.length], [2, 0]);
  await noFixRule.acceptAll();
  check('...only outline-removed was suggested/edited', [noFixRule.state.applyCalls.length, noFixRule.doc.text], [2, CSS_FIXED]);
  check('...focus-visible-missing diagnostics are unchanged', noFixRule.ruleCounts()['focus-visible-missing'], 2);

  // ============================================================== synthetic safe-tier fixture
  console.log('\nsynthetic safe-tier fixture: positive-tabindex (HTML) given a test-only fix');
  // outline-removed is not the only way to exercise the safe path: this is a different rule in a
  // different language, with a trivial value-swap fix that exists only inside the test.
  const HTML_TABS = '<div tabindex="3">a</div>\n<span tabindex="5">b</span>\n';
  const HTML_TABS_FIXED = '<div tabindex="0">a</div>\n<span tabindex="0">b</span>\n';
  const tabFixer = (tier) => () => {
    const r = require('../src/rules/html/positive-tabindex');
    r.fix = (v, src) => {
      const tag = src.split('\n')[v.startLine].slice(v.startChar, v.endChar);
      return /tabindex="[1-9]\d*"/.test(tag) ? { newText: tag.replace(/tabindex="[1-9]\d*"/, 'tabindex="0"') } : null;
    };
    if (tier === undefined) delete r.fixTier; else r.fixTier = tier;
  };
  const htmlScenario = (mode, tier) => scenario({ mode, languageId: 'html', uriName: 'page.html', text: HTML_TABS, patch: tabFixer(tier) });
  const tabActions = (sc) => sc.actions().filter(a => /positive-tabindex/.test(a.title));
  const hSafeHybrid = await htmlScenario('hybrid', 'safe');
  check('safe tier, hybrid: suggested, nothing applied until Accept', [hSafeHybrid.doc.text, hSafeHybrid.state.applyCalls.length, hSafeHybrid.pending().length], [HTML_TABS, 0, 2]);
  await hSafeHybrid.acceptAll();
  check('safe tier, hybrid: Accept gives the same change the old auto-apply made', [hSafeHybrid.doc.text, hSafeHybrid.state.applyCalls.length], [HTML_TABS_FIXED, 2]);
  const hSafeAuto = await htmlScenario('auto', 'safe');
  check('safe tier, auto: suggested', [hSafeAuto.doc.text, hSafeAuto.pending().length], [HTML_TABS, 2]);
  await hSafeAuto.acceptAll();
  check('safe tier, auto: Accept applies it', [hSafeAuto.doc.text, hSafeAuto.state.applyCalls.length], [HTML_TABS_FIXED, 2]);
  const hSafeManual = await htmlScenario('manual', 'safe');
  check('safe tier, manual: never suggested; offered as quick fixes', [hSafeManual.doc.text, hSafeManual.state.applyCalls.length, hSafeManual.pending().length, tabActions(hSafeManual).length], [HTML_TABS, 0, 0, 2]);
  const hMedHybrid = await htmlScenario('hybrid', 'medium');
  check('medium tier, hybrid: NOT suggested; quick fixes only', [hMedHybrid.doc.text, hMedHybrid.state.applyCalls.length, hMedHybrid.pending().length, tabActions(hMedHybrid).length], [HTML_TABS, 0, 0, 2]);
  const hMedAuto = await htmlScenario('auto', 'medium');
  check('medium tier, auto: suggested', [hMedAuto.doc.text, hMedAuto.pending().length], [HTML_TABS, 2]);
  await hMedAuto.acceptAll();
  check('medium tier, auto: Accept applies it', [hMedAuto.doc.text, hMedAuto.state.applyCalls.length], [HTML_TABS_FIXED, 2]);
  for (const mode of ['hybrid', 'auto']) {
    const sc = await htmlScenario(mode, undefined);
    check('untagged fix, ' + mode + ': never suggested, still a quick fix', [sc.doc.text, sc.state.applyCalls.length, sc.pending().length, tabActions(sc).length], [HTML_TABS, 0, 0, 2]);
  }
  const sc2 = await htmlScenario('hybrid', 'safe');
  await sc2.acceptAll();
  sc2.rescan(); await wait(100);
  check('the accepted safe fix is not suggested again on later scans', [sc2.state.applyCalls.length, sc2.pending().length], [2, 0]);
  check('...and the violations it fixed are gone from the rescan', sc2.ruleCounts()['positive-tabindex'], undefined);
  const hOtherRule = await scenario({ mode: 'hybrid', languageId: 'html', uriName: 'page.html', text: HTML_TABS, tier: 'medium', patch: tabFixer('safe') });
  await hOtherRule.acceptAll();
  check('the synthetic rule\'s tier alone decides: outline-removed being "medium" here changes nothing', [hOtherRule.doc.text, hOtherRule.state.applyCalls.length], [HTML_TABS_FIXED, 2]);

  // ============================================================== the shipped rule end to end
  console.log('\nthe shipped outline-removed fix, end to end (its real tag and real computed fix)');
  const realH = await scenario({ mode: 'hybrid', tier: 'real' });
  check('the shipped tag is "safe"', realH.rule.fixTier, 'safe');
  check('hybrid suggests it: light background -> black outline, dark background -> white outline', realH.addedTexts(), [FIXED_A, FIXED_B]);
  check('...nothing applied before Accept', [realH.state.applyCalls.length, realH.doc.text], [0, CSS]);
  await realH.acceptAll();
  check('...Accept gives the fixed file', realH.doc.text, CSS_FIXED);
  const realA = await scenario({ mode: 'auto', tier: 'real' });
  await realA.acceptAll();
  check('auto suggests it too, and Accept applies it', realA.doc.text, CSS_FIXED);
  const realM = await scenario({ mode: 'manual', tier: 'real' });
  check('manual: not suggested; the quick fixes carry the computed colors', [realM.state.applyCalls.length, realM.pending().length, realM.outlineActions().map(a => a.edit.edits[0].text)], [0, 0, [FIXED_A, FIXED_B]]);
  const BARE = 'a:focus {\n  outline: none;\n}\nbutton:focus {\n  outline: 0;\n}\n';
  for (const [label, text] of [['no background-color', BARE], ['a var() background', 'a:focus {\n  background-color: var(--bg);\n  outline: none;\n}\nbutton:focus {\n  background-color: currentColor;\n  outline: 0;\n}\n']]) {
    const sc = await scenario({ mode: 'auto', tier: 'real', text });
    sc.rescan(); await wait(100);
    check(label + ': auto suggests nothing (no value can be computed), however often it scans', [sc.state.applyCalls.length, sc.pending().length, sc.doc.text === text], [0, 0, true]);
    check('  ...the violations are still reported', sc.ruleCounts()['outline-removed'], 2);
    check('  ...no quick fix is offered either', sc.outlineActions().length, 0);
    check('  ...and nothing is logged as a failed auto-fix (none was attempted)', [sc.autoLines().length, sc.channel('AccessGen Auto-fix')], [0, undefined]);
  }
  const MIXED = 'a:focus {\n  background-color: #ffffff;\n  outline: none;\n}\nbutton:focus {\n  outline: 0;\n}\n';
  const mixed = await scenario({ mode: 'hybrid', tier: 'real', text: MIXED });
  mixed.rescan(); await wait(100);
  check('one block with a background, one without: only the first is suggested', mixed.pending().length, 1);
  await mixed.acceptAll();
  check('...Accept applies one replacement and leaves the unfixable block alone', [mixed.state.applyCalls.length, mixed.state.applyCalls[0].count, mixed.doc.text.includes(BG_A + FIXED_A), mixed.doc.text.includes('button:focus {\n  outline: 0;')], [1, 1, true, true]);
  check('...the unfixable one stays flagged and is not retried', mixed.ruleCounts()['outline-removed'], 1);
  const hover = await analyzeDocument({ getText: () => BARE, languageId: 'css' }, { complianceLevel: 'AA', isRuleDisabled: () => false, isTrustedComponent: () => false });
  check('the violation the user hovers says why no fix is offered', /No automatic fix is offered: the background color is not statically determinable/.test(hover.find(v => v.ruleId === 'outline-removed').message.fix), true);

  // ============================================================== same instance never applied twice
  console.log('\nan accepted instance is never suggested twice ("applied once")');
  const und = await scenario({ mode: 'hybrid' });
  await und.acceptAll();
  check('baseline: accepted once each', [und.state.applyCalls.length, und.doc.text], [2, CSS_FIXED]);
  und.type(CSS); await wait(200);
  check('user undoes the fixes: the identical instances come back and are NOT re-suggested (undo is respected)', [und.state.applyCalls.length, und.pending().length, und.doc.text], [2, 0, CSS]);
  check('...and that is not reported as an auto-fix failure', und.autoLines().filter(l => /auto-fix-failed/.test(l)).length, 0);
  check('...they stay available as manual quick fixes', und.outlineActions().length, 2);
  und.type('\n\n\n' + CSS); await wait(200);
  check('same instances after lines are inserted above: still not re-suggested (identity is structural, not line-based)', [und.state.applyCalls.length, und.pending().length], [2, 0]);
  und.type(CSS + 'nav:focus {\n  background-color: #ffffff;\n  outline: none;\n}\n'); await wait(220);
  check('a genuinely NEW instance is suggested; the old ones stay as they were', [und.pending().length, und.state.applyCalls.length], [1, 2]);
  await und.acceptAll();
  check('...and accepting it edits only that instance', [und.state.applyCalls.length, und.state.applyCalls[2].count, und.doc.text.includes('nav:focus {\n  background-color: #ffffff;\n  ' + FIXED_A)], [3, 1, true]);
  const ONE = 'a:focus {\n  background-color: #fff;\n  outline: none;\n}\n';
  const sameText = await scenario({ mode: 'hybrid', text: ONE });
  check('one instance pending', sameText.pending().length, 1);
  sameText.type(ONE + 'b:focus {\n  background-color: #fff;\n  outline: none;\n}\n');
  await wait(220);
  check('identical declaration under a different selector is a different instance: both pending', sameText.pending().length, 2);
  await sameText.acceptAll();
  check('...so both are accepted independently', sameText.state.applyCalls.length, 2);
  const ghost = await scenario({ mode: 'hybrid', applyMode: 'noop' });
  await ghost.acceptAll();
  for (let i = 0; i < 3; i++) { ghost.rescan(); await wait(100); }
  check('an apply that reports success but changes nothing is not re-suggested or retried', [ghost.state.applyCalls.length, ghost.pending().length], [2, 0]);
  check('...and each is flagged once as "not resolved"', ghost.autoLines().filter(l => /auto-fix-failed/.test(l) && /did not resolve/.test(l)).length, 2);

  // ============================================================== a fix that does not resolve
  console.log('\na fix that does not resolve the violation falls back to manual after Accept, without retrying');
  const buggy = (rule) => {
    const real = rule.fix;
    // correct for "outline: none", wrong for "outline: 0" (swaps it for a different violating value)
    rule.fix = (v, src) => {
      const line = src.split('\n')[v.startLine].slice(v.startChar, v.endChar);
      return /outline:\s*0/.test(line) ? { newText: 'outline: none;' } : real(v, src);
    };
    rule.fixTier = 'safe';
  };
  const origErr = console.error; let errLogs = [];
  console.error = (...a) => { errLogs.push(a.join(' ')); };
  const bad = await scenario({ mode: 'hybrid', setup: buggy });
  check('both are suggested first; the bad one is not known to be bad yet', bad.pending().length, 2);
  await bad.acceptAll();
  console.error = origErr;
  check('Accept applied what it did: two edits', [bad.state.applyCalls.length, bad.doc.text.includes(BG_A + FIXED_A)], [2, true]);
  check('the unresolved instance was reported again by the rescan', bad.ruleCounts()['outline-removed'], 1);
  const failLines = bad.autoLines().filter(l => /auto-fix-failed, manual review needed/.test(l));
  check('logged ONCE as "auto-fix-failed, manual review needed", with rule and line', [failLines.length, /outline-removed/.test(failLines[0]), /line 7/.test(failLines[0])], [1, true, true]);
  check('...also to the console, once', errLogs.filter(l => /auto-fix failed for outline-removed/.test(l)).length, 1);
  console.error = () => {};
  for (let i = 0; i < 3; i++) { bad.rescan(); await wait(100); }
  bad.type(bad.doc.text + '/* unrelated edit */\n'); await wait(200);
  console.error = origErr;
  check('never suggested again: no pending suggestion and no further edit across more scans and an unrelated edit', [bad.pending().length, bad.state.applyCalls.length], [0, 2]);
  check('...and not logged again', bad.autoLines().filter(l => /auto-fix-failed/.test(l)).length, 1);
  check('...it remains available as a manual quick fix', bad.outlineActions().length, 1);
  bad.type(bad.doc.text + 'nav:focus {\n  background-color: #ffffff;\n  outline: none;\n}\n'); await wait(220);
  check('another instance elsewhere is still suggested', bad.pending().length, 1);
  await bad.acceptAll();
  check('...and accepted', [bad.state.applyCalls.length, bad.doc.text.includes('nav:focus {\n  background-color: #ffffff;\n  ' + FIXED_A)], [3, true]);
  check('...while the failed instance is left alone', bad.doc.text.includes(BG_B + 'outline: none;'), true);

  const rej = await scenario({ mode: 'hybrid', applyMode: 'reject' });
  await rej.acceptAll();
  for (let i = 0; i < 3; i++) { rej.rescan(); await wait(100); }
  check('an edit the workspace rejects: marked failed, not re-suggested or retried', [rej.state.applyCalls.length, rej.pending().length, rej.autoLines().filter(l => /auto-fix-failed/.test(l) && /edit was rejected/.test(l)).length], [2, 0, 2]);
  console.error = () => {};
  const thr = await scenario({ mode: 'auto', applyMode: 'throw' });
  await thr.acceptAll();
  for (let i = 0; i < 2; i++) { thr.rescan(); await wait(100); }
  console.error = origErr;
  check('applyEdit throwing: same, and the scan keeps working', [thr.state.applyCalls.length, thr.pending().length, thr.state.diagnostics.length >= 3], [2, 0, true]);

  // ============================================================== scope + timing guards
  console.log('\nguards: open document only, never mid-keystroke');
  const act = await scenario({ mode: 'hybrid' });
  await act.acceptAll();
  check('every edit targets only the document that was analysed', act.state.applyCalls.length > 0 && act.state.applyCalls.every(c => c.uris.length === 1 && c.uris[0] === 'file:///c:/ws/style.css'), true);
  const html = await scenario({ mode: 'auto', languageId: 'html', uriName: 'page.html', text: '<html><body><img src="a.png"><button></button></body></html>' });
  check('a document whose only fixers are AI-suggested (img-alt-missing), AI off: nothing is suggested even in auto mode, nothing breaks', [html.state.applyCalls.length, html.pending().length, html.state.diagnostics.length >= 1], [0, 0, true]);

  const mid = await scenario({ mode: 'hybrid', text: CLEAN, debounceMs: 40 });
  mid.setSilently(CSS);
  mid.rescan();
  mid.setSilently(CSS + '/* typed during the scan */\n');
  await wait(20);
  check('text changed while the scan was running: that scan suggests nothing (stale positions)', [mid.state.applyCalls.length, mid.pending().length], [0, 0]);
  mid.state.handlers.doc({ document: mid.doc });
  await wait(200);
  check('the debounced rescan of the new text then suggests the fixes (still not applied)', [mid.pending().length, mid.state.applyCalls.length], [2, 0]);
  await mid.acceptAll();
  check('...and Accept edits the typed text correctly', [mid.doc.text.includes(BG_A + FIXED_A), mid.doc.text.includes('/* typed during the scan */')], [true, true]);

  const pend = await scenario({ mode: 'hybrid', text: CLEAN, debounceMs: 250 });
  pend.setSilently(CSS);
  pend.rescan();                                          // an immediate scan of unchanged text...
  pend.state.handlers.doc({ document: pend.doc });         // ...while a keystroke has just armed the debounce
  await wait(120);
  check('a debounced rescan is pending (the user is typing): the immediate scan suggests nothing', pend.pending().length, 0);
  await wait(300);
  check('once the debounce fires and the text is stable, it suggests', [pend.pending().length, pend.state.applyCalls.length], [2, 0]);
  await pend.acceptAll();
  check('...and Accept applies', pend.doc.text, CSS_FIXED);
  const typing = await scenario({ mode: 'hybrid', text: CLEAN, debounceMs: 80 });
  for (let i = 0; i < 4; i++) { typing.type(CSS + '/* ' + i + ' */\n'); await wait(30); }
  check('continuous typing (faster than debounceMs): nothing suggested while the user types', typing.pending().length, 0);
  await wait(250);
  check('after the user stops, it suggests once (two instances, no edit)', [typing.pending().length, typing.state.applyCalls.length], [2, 0]);

  const switched = await scenario({ mode: 'hybrid', text: CLEAN });
  switched.setSilently(CSS);
  switched.rescan();
  currentVscode.window.activeTextEditor = { document: { uri: { toString: () => 'other' }, getText: () => '', languageId: 'css' }, setDecorations() {} };
  await wait(120);
  check('if the editor is no longer the active one, nothing is suggested for it', [switched.pending().length, switched.state.applyCalls.length], [0, 0]);

  // ============================================================== the inline-diff UI itself
  console.log('\ninline diff: rendering, lenses, identity');
  const ui = await scenario({ mode: 'hybrid' });
  const removedT = ui.state.decoTypes.find(t => t.kind === 'removed'), addedT = ui.state.decoTypes.find(t => t.kind === 'added');
  check('old text: strikethrough over a reddish tint', [removedT.options.textDecoration, /^rgba\(255,/.test(removedT.options.backgroundColor)], ['line-through', true]);
  check('new text: an `after` decoration with a greenish tint', [!!addedT.options.after, /^rgba\(60, 190, 90/.test(addedT.options.after.backgroundColor)], [true, true]);
  check('the new-text decoration sits immediately after the old range (zero-width range at its end)', (() => {
    const o = ui.lastDeco('added')[0].range, r = ui.lastDeco('removed')[0].range;
    return [o.start.line === r.end.line, o.start.character === r.end.character, o.end.character === r.end.character];
  })(), [true, true, true]);
  check('lenses are registered for html, css, jsx and tsx', ui.state.codeLensSelector.map(s => s.language).sort(), ['css', 'html', 'javascriptreact', 'typescriptreact']);
  check('both lens commands are registered', ['accessgen.acceptInlineFix', 'accessgen.rejectInlineFix'].map(c => typeof ui.state.commands[c]), ['function', 'function']);
  check('lenses sit on the line of the violation (above it)', ui.lenses().map(l => l.range.start.line), [2, 2, 6, 6]);
  const ids = ui.pending().map(p => p.args.id);
  check('lens arguments carry the violation identity: slot + content hash, distinct per suggestion', [ids.length, new Set(ids).size, ids.every(i => /\u0002[0-9a-f]{40}$/.test(i)), /outline-removed\u0001rule\(a:focus\)\[0\]>decl\(outline\)\[0\]/.test(ids[0])], [2, 2, true, true]);
  const decoBefore = ui.state.decoCalls.length, suggestedBefore = ui.autoLines().filter(l => /^suggested/.test(l)).length;
  for (let i = 0; i < 3; i++) { ui.state.handlers.doc({ document: ui.doc }); await wait(100); } // a real rescan of unchanged text (not an editor switch, which deliberately re-shows)
  check('a rescan neither recomputes nor re-renders a pending suggestion (same identities, no new decoration calls)', [ui.pending().map(p => p.args.id), ui.state.decoCalls.length], [ids, decoBefore]);
  check('...and does not announce it again', ui.autoLines().filter(l => /^suggested/.test(l)).length, suggestedBefore);
  const a0 = ui.pending()[0].args;
  const dbl = await Promise.all([ui.state.commands['accessgen.acceptInlineFix'](a0), ui.state.commands['accessgen.acceptInlineFix'](a0)]);
  await wait(200);
  check('accepting the same suggestion twice at once applies it once', [dbl.filter(Boolean).length, ui.state.applyCalls.length], [1, 1]);

  console.log('\ninline diff: Dismiss');
  const dis = await scenario({ mode: 'hybrid' });
  const firstArgs = dis.pending()[0].args;
  await dis.reject(0);
  check('Dismiss applies nothing and leaves the document alone', [dis.state.applyCalls.length, dis.doc.text === CSS], [0, true]);
  check('...clears that suggestion\'s decoration and lens, keeping the other', [dis.pending().map(p => p.line), dis.removedTexts(), dis.addedTexts()], [[6], ['outline: 0;'], [FIXED_B]]);
  check('...and says so in the channel', dis.autoLines().filter(l => /^dismissed \(safe\): outline-removed/.test(l)).length, 1);
  for (let i = 0; i < 3; i++) { dis.rescan(); await wait(100); }
  check('a rescan does not re-suggest a dismissed instance', dis.pending().map(p => p.line), [6]);
  check('a stale Accept of the dismissed suggestion does nothing', [await dis.state.commands['accessgen.acceptInlineFix'](firstArgs), dis.state.applyCalls.length], [false, 0]);
  check('...and the violation is still reported and still a manual quick fix', [dis.ruleCounts()['outline-removed'], dis.outlineActions().length], [2, 2]);
  dis.type(CSS.replace('outline: none;', 'outline:none;')); await wait(220);
  check('changing the dismissed code is a new identity: suggested again', dis.pending().map(p => p.line), [2, 6]);
  dis.type(CSS); await wait(220);
  check('reverting to the dismissed text: still dismissed (its identity is remembered)', dis.pending().map(p => p.line), [6]);
  await dis.reject(0);
  const accAfter = await scenario({ mode: 'hybrid' });
  await accAfter.accept(0);
  await accAfter.reject(0);
  check('Dismiss is a separate state from applied: accepted then another dismissed, both stay decided', [accAfter.state.applyCalls.length, accAfter.pending().length], [1, 0]);

  console.log('\ninline diff: stale suggestions are never applied');
  const stale = await scenario({ mode: 'hybrid' });
  stale.setSilently(CSS.replace('outline: none;', 'outline: unset; '));
  const staleResult = await stale.accept(0);
  check('text changed under a suggestion before the rescan: Accept refuses and applies nothing', [staleResult, stale.state.applyCalls.length], [false, 0]);
  check('...it says why, and the suggestion is dropped (the rescan decides what to offer)', [stale.autoLines().filter(l => /^stale, not applied/.test(l)).length, stale.state.statusMessages.some(m => /code changed under that suggestion/.test(m))], [1, true]);
  const HTML_ROW = '<div tabindex="33">a</div><span tabindex="5">b</span>\n'; // the first fix SHORTENS the line, so the second must move
  const row = await scenario({ mode: 'hybrid', languageId: 'html', uriName: 'page.html', text: HTML_ROW, patch: tabFixer('safe') });
  await row.accept(0); await row.accept(0);
  await wait(200);
  check('two suggestions on one line: accepting the first shifts the second correctly', [row.doc.text, row.state.applyCalls.length], ['<div tabindex="0">a</div><span tabindex="0">b</span>\n', 2]);
  const { shiftPosition } = require('../src/remediation/inlineDiff');
  const rr = { startLine: 1, startChar: 4, endLine: 1, endChar: 10 };
  check('shiftPosition: same line, longer text', shiftPosition(1, 20, rr, 'abcdefghij'), { line: 1, char: 24 });
  check('shiftPosition: multi-line replacement moves later lines and the tail of the last line', [shiftPosition(1, 20, rr, 'a\nbc'), shiftPosition(5, 3, rr, 'a\nbc')], [{ line: 2, char: 12 }, { line: 6, char: 3 }]);
  check('shiftPosition: replacing several lines with one pulls later lines up', shiftPosition(7, 2, { startLine: 2, startChar: 0, endLine: 5, endChar: 1 }, 'x'), { line: 4, char: 2 });

  console.log('\ninline diff: leaving the modes');
  const sw = await scenario({ mode: 'hybrid' });
  check('pending in hybrid', sw.pending().length, 2);
  settings.remediationMode = 'manual';
  sw.state.handlers.config({ affectsConfiguration: () => true });
  await wait(120);
  check('switching to manual clears every pending suggestion, decoration and lens (nothing applied)', [sw.pending().length, sw.lastDeco('removed'), sw.state.applyCalls.length, sw.doc.text === CSS], [0, [], 0, true]);
  const hand = await scenario({ mode: 'hybrid' });
  hand.type(CSS.replace('outline: none;', 'outline: 2px solid #000000; outline-offset: -2px;')); await wait(220);
  check('the user fixes one by hand: that suggestion disappears, the other stays', hand.pending().map(p => p.line), [6]);
  const manualNoUi = await scenario({ mode: 'manual' });
  check('manual: no lens, no decoration types are even created', [manualNoUi.lenses().length, manualNoUi.state.decoTypes.filter(t => t.kind !== 'other').length], [0, 0]);
  const disabled = await scenario({ mode: 'hybrid' });
  await disabled.state.commands['accessgen.disable']();
  await wait(60);
  check('turning AccessGen off clears pending suggestions', disabled.pending().length, 0);

  console.log('\ninline diff: a host that cannot register CodeLens does not take the extension down');
  const origErr2 = console.error; console.error = () => {};
  const noLens = await scenario({ mode: 'hybrid', patch: () => { currentVscode.languages.registerCodeLensProvider = () => { throw new Error('no CodeLens in this host'); }; } });
  console.error = origErr2;
  check('every command is still registered and the scan still ran', [Object.keys(noLens.state.commands).filter(c => /^accessgen\./.test(c)).length >= 9, noLens.state.diagnostics.length >= 1], [true, true]);

  // ============================================================== visibility
  console.log('\nin-session visibility');
  const vis = await scenario({ mode: 'hybrid' });
  check('one output line per suggestion: tier, rule, file and line', vis.autoLines(), [
    'suggested (safe): outline-removed - C:/ws/style.css line 3',
    'suggested (safe): outline-removed - C:/ws/style.css line 7'
  ]);
  check('no status-bar "applied" message before anything is accepted', vis.state.statusMessages.filter(m => /AccessGen applied/.test(m)).length, 0);
  await vis.acceptAll();
  check('an accepted fix is logged with tier, rule, file and line', vis.autoLines().filter(l => /^accepted/.test(l)), [
    'accepted (safe): outline-removed - C:/ws/style.css line 3',
    'accepted (safe): outline-removed - C:/ws/style.css line 7'
  ]);
  check('plus a non-modal status bar message each', vis.state.statusMessages.filter(m => /AccessGen applied \(safe\): outline-removed at style\.css:/.test(m)).length, 2);
  const visM = await scenario({ mode: 'auto', setup: asMedium });
  check('auto labels a medium-tier suggestion as "(medium)"', visM.autoLines().every(l => /^suggested \(medium\)/.test(l)) && visM.autoLines().length === 2, true);
  check('no modal dialog was used', [vis.state.infoMessages.length], [0]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'remediation', 'autoFix.js'), 'utf8');
  const srcInline = fs.readFileSync(path.join(__dirname, '..', 'src', 'remediation', 'inlineDiff.js'), 'utf8');
  const banned = ['require(\'fs\')', 'require(\'https\')', 'require(\'http\')', 'globalState', 'workspaceState', 'writeFile', 'fetch('];
  check('nothing is persisted or sent: neither module touches fs, network or storage', [src, srcInline].map(t => banned.filter(b => t.includes(b))), [[], []]);
  check('the old silent path is gone: autoFix.js never calls applyEdit (or even builds a WorkspaceEdit)', ['applyEdit', 'WorkspaceEdit', 'require(\'vscode\')'].filter(t => src.includes(t)), []);
  const remDir = path.join(__dirname, '..', 'src', 'remediation');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  check('the only applyEdit call in the remediation code (including remediation/batch) is Accept in inlineDiff.js', walk(remDir).filter(f => fs.readFileSync(f, 'utf8').includes('applyEdit(')).map(f => path.relative(remDir, f)), ['inlineDiff.js']);

  // ============================================================== identity helpers
  console.log('\nstructural identity of a violation');
  freshModules();
  const { makeLocator, rangeText } = require('../src/remediation/autoFix');
  const loc = makeLocator('css', CSS);
  const v1 = { startLine: 2, startChar: 2 }, v2 = { startLine: 6, startChar: 2 };
  check('selector chain + declaration, with sibling index', [loc(v1), loc(v2)], ['rule(a:focus)[0]>decl(outline)[0]', 'rule(button:focus)[0]>decl(outline)[0]']);
  check('unchanged by lines inserted above', makeLocator('css', '\n\n\n/* c */\n' + CSS)({ startLine: 6, startChar: 2 }), loc(v1));
  const media = makeLocator('css', '@media (min-width: 1px) {\n  a:focus {\n    outline: none;\n  }\n}\n');
  check('at-rules are part of the path', media({ startLine: 2, startChar: 4 }), '@media((min-width: 1px))[0]>rule(a:focus)[0]>decl(outline)[0]');
  const twice = makeLocator('css', 'a:focus {\n  outline: none;\n}\na:focus {\n  outline: none;\n}\n');
  check('two identical rules are told apart by index', [twice({ startLine: 1, startChar: 2 }), twice({ startLine: 4, startChar: 2 })], ['rule(a:focus)[0]>decl(outline)[0]', 'rule(a:focus)[1]>decl(outline)[0]']);
  check('non-CSS and unmatched positions fall back to the position', [makeLocator('html', '<p></p>')({ startLine: 3, startChar: 4 }), loc({ startLine: 99, startChar: 0 })], ['pos:3:4', 'pos:99:0']);
  check('rangeText: single and multi line', [rangeText(CSS, { startLine: 2, startChar: 2, endLine: 2, endChar: 16 }), rangeText('a\nbb\nccc', { startLine: 0, startChar: 0, endLine: 2, endChar: 2 })], ['outline: none;', 'a\nbb\ncc']);

  // ============================================================== README
  console.log('\nREADME');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  check('settings table lists remediationMode', readme.includes(String.fromCharCode(96) + 'accessgen.remediationMode' + String.fromCharCode(96)), true);
  check('README explains the tiers and the untagged-is-manual rule', ['hybrid', 'safe', 'medium', 'fixTier'].filter(t => !readme.includes(t)), []);

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
