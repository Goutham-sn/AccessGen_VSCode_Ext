// End-to-end through the REAL extension.js with a file-system-backed `vscode` stub: scan the whole project, open the
// panel, fix a file through the panel's message protocol (one fake Anthropic request), accept and reject proposals,
// change a setting, export the report. No network, no real VS Code. Run: node test/panel-integration.test.js
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

// ------------------------------------------------------------------ project on disk
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accessgen-panel-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const PAGE = '<html>\n<body>\n<h1>Team</h1>\n<img src="ceo.png">\n<a href="/about"></a>\n</body>\n</html>\n';
write('site/index.html', PAGE);
write('site/ceo.png', Buffer.from('89504e470d0a1a0a', 'hex').toString('latin1'));
write('site/style.css', 'a:focus {\n  background-color: #ffffff;\n  outline: none;\n}\n');
write('node_modules/lib/x.html', '<img src="ignored.png">');

// ------------------------------------------------------------------ vscode stub
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } contains() { return false; } }
class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } }
class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(x) { this.l.forEach(f => f(x)); } dispose() {} }
class Anything { constructor(...a) { this.args = a; } }
const makeUri = (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p });
const Uri = {
  file: makeUri,
  parse: (s) => (s.startsWith('file://') ? makeUri(s.slice(7)) : { scheme: s.split(':')[0], path: s, fsPath: s, toString: () => s }),
  joinPath: (u, ...parts) => makeUri(path.join(u.fsPath, ...parts))
};

const settings = { aiReviewMode: 'manual', aiProvider: 'anthropic', remediationMode: 'manual', debounceMs: 10 };
const st = { commands: {}, diagnostics: new Map(), posted: [], applied: [], executed: [], infos: [], warnings: [], http: [], view: null, contentProviders: {} };
const docs = new Map(); // fsPath -> open document

function makeDoc(uri) {
  const d = {
    uri, languageId: ({ '.html': 'html', '.css': 'css' })[path.extname(uri.fsPath)] || 'plaintext',
    text: fs.readFileSync(uri.fsPath, 'utf8'),
    getText() { return this.text; },
    get lineCount() { return this.text.split('\n').length; },
    lineAt(i) { return { text: this.text.split('\n')[i] || '' }; },
    positionAt(off) { const before = this.text.slice(0, off).split('\n'); return new Position(before.length - 1, before[before.length - 1].length); },
    offsetAt(p) { const lines = this.text.split('\n'); return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character; }
  };
  return d;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const noop = () => ({ dispose() {} });

const vscodeStub = {
  Range, Position, WorkspaceEdit, EventEmitter, Uri, Diagnostic: Anything, CodeAction: Anything, CodeLens: Anything, MarkdownString: Anything, Hover: Anything, ThemeColor: Anything,
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  CodeActionKind: { QuickFix: 'quickfix' }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }, StatusBarAlignment: { Left: 1 }, OverviewRulerLane: { Right: 4 },
  DecorationRangeBehavior: { ClosedClosed: 0 }, FileType: { File: 1, Directory: 2 }, ProgressLocation: { Notification: 15, Window: 10 },
  workspace: {
    workspaceFolders: [{ uri: makeUri(root) }],
    get textDocuments() { return [...docs.values()]; },
    asRelativePath: (u) => path.relative(root, u.fsPath || u),
    getConfiguration: () => ({ get: (k, d) => (settings[k] !== undefined ? settings[k] : d), update: async (k, v) => { settings[k] = v; if (st.onConfig) st.onConfig({ affectsConfiguration: () => true }); }, inspect: () => ({}) }),
    findFiles: async (glob, exclude) => {
      const base = glob && glob.base ? glob.base.fsPath : root;
      const pattern = glob && glob.pattern ? glob.pattern : glob;
      const exts = (pattern.match(/\{([^}]+)\}$/) || [])[1];
      const allowed = exts ? exts.split(',').map(e => '.' + e) : [path.extname(pattern)];
      return walk(base).filter(f => !/node_modules/.test(f) && allowed.includes(path.extname(f)) && !(/tailwind/.test(pattern) && !/tailwind/.test(f))).map(makeUri);
    },
    fs: {
      readFile: async (u) => fs.readFileSync(u.fsPath),
      writeFile: async (u, bytes) => fs.writeFileSync(u.fsPath, bytes),
      stat: async (u) => ({ type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 })
    },
    openTextDocument: async (u) => { if (!docs.has(u.fsPath)) docs.set(u.fsPath, makeDoc(u)); return docs.get(u.fsPath); },
    applyEdit: async (edit) => {
      st.applied.push(edit);
      for (const e of [...edit.edits].reverse()) {
        const d = docs.get(e.uri.fsPath) || makeDoc(e.uri);
        docs.set(e.uri.fsPath, d);
        d.text = d.text.slice(0, d.offsetAt(e.range.start)) + e.text + d.text.slice(d.offsetAt(e.range.end));
      }
      return true;
    },
    registerTextDocumentContentProvider: (scheme, p) => { st.contentProviders[scheme] = p; return noop(); },
    onDidChangeTextDocument: noop, onDidChangeConfiguration: (h) => { st.onConfig = h; return noop(); }
  },
  window: {
    activeTextEditor: null, visibleTextEditors: [],
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showInformationMessage: (m) => { st.infos.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { st.warnings.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { st.warnings.push(m); return Promise.resolve(undefined); },
    showSaveDialog: async () => makeUri(path.join(root, 'report.md')),
    showTextDocument: async () => {}, showQuickPick: async (items) => items.filter(i => /index/.test(i.label)),
    withProgress: (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
    setStatusBarMessage() {}, createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: noop,
    createOutputChannel: (name) => ({ name, lines: [], appendLine(l) { this.lines.push(l); }, show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => { st.viewId = id; st.viewProvider = provider; return noop(); }
  },
  commands: { registerCommand: (id, fn) => { st.commands[id] = fn; return noop(); }, executeCommand: async (...a) => { st.executed.push(a); } },
  languages: {
    createDiagnosticCollection: () => ({ set: (uri, d) => st.diagnostics.set(uri.fsPath, d), delete() {}, clear() {}, dispose() {} }),
    registerHoverProvider: noop, registerCodeActionsProvider: noop, registerCodeLensProvider: noop
  }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest); };

// ------------------------------------------------------------------ fake Anthropic
const http = require('../src/judgment/providers/http');
http.postJson = async (url, headers, body) => {
  st.http.push({ url, headers, body });
  const text = body.messages[0].content.find(c => c.type === 'text').text;
  const fixes = [...text.matchAll(/### (I\d+) - ([\w-]+)/g)].map(([, id, rule]) => {
    if (rule === 'img-alt-missing') return { id, status: 'fixed', confidence: 0.92, summary: 'Added alt text describing the portrait.', steps: ['Check the description matches the photo.'], edits: [{ find: '<img src="ceo.png">', replace: '<img src="ceo.png" alt="Portrait of the CEO">' }], needsInput: '', coveredBy: '', testing: 'Use a screen reader.' };
    if (rule === 'anchor-no-text') return { id, status: 'fixed', confidence: 0.8, summary: 'Named the link.', steps: [], edits: [{ find: '<a href="/about"></a>', replace: '<a href="/about">About us</a>' }], needsInput: '', coveredBy: '', testing: '' };
    return { id, status: 'cannot-fix', confidence: 0.3, summary: 'Needs a decision.', steps: [], edits: [], needsInput: '', coveredBy: '', testing: '' };
  });
  return { status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ fixes }) }] } };
};

(async () => {
  const D = require('../src/judgment/disclosure');
  const ext = require('../src/extension');
  const context = {
    subscriptions: [], extensionPath: path.join(__dirname, '..'), extensionUri: makeUri(path.join(__dirname, '..')),
    globalState: { data: new Map([[D.DISCLOSURE_KEY, D.disclosureRecord()]]), get(k, d) { return this.data.has(k) ? this.data.get(k) : d; }, async update(k, v) { this.data.set(k, v); } },
    secrets: { get: async () => 'sk-test-PANEL', store: async () => {}, delete: async () => {} }
  };
  ext.activate(context);

  console.log('\nactivation');
  check('the panel view and every new command are registered', [st.viewId, ['accessgen.scanFile', 'accessgen.scanFiles', 'accessgen.scanWorkspace', 'accessgen.fixFileWithAI', 'accessgen.fixAllWithAI', 'accessgen.acceptAllVerifiedFixes', 'accessgen.exportReport'].filter(c => !st.commands[c])], ['accessgen.panel', []]);
  const webview = {
    cspSource: 'vscode-resource:', options: null, html: '',
    asWebviewUri: (u) => 'vscode-resource:' + u.fsPath,
    postMessage: (m) => { st.posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: (h) => { st.send = h; return noop(); }
  };
  st.viewProvider.resolveWebviewView({ webview, visible: true, onDidDispose: noop, onDidChangeVisibility: noop });
  check('webview: scripts only with a nonce, no remote content, local resources limited to media/', [/script-src 'nonce-[^']+'/.test(webview.html), /default-src 'none'/.test(webview.html), /https?:\/\//.test(webview.html.replace(/http-equiv/, '')), webview.options.localResourceRoots.map(u => path.basename(u.fsPath))], [true, true, false, ['media']]);
  const lastState = () => { const s = st.posted.filter(m => m.type === 'state'); return s.length ? s[s.length - 1].data : null; };

  console.log('\nscan the whole project');
  await st.commands['accessgen.scanWorkspace']();
  await wait(120);
  const scanned = [...st.diagnostics.keys()].map(p => path.relative(root, p)).sort();
  check('every HTML/CSS file is scanned and published to the Problems panel; node_modules is skipped', scanned, ['site/index.html', 'site/style.css']);
  st.send({ type: 'ready' }); await wait(120);
  const s1 = lastState();
  check('the panel state lists the files with issues and the counts', [s1.files.map(f => f.relPath).sort(), s1.summary.files, s1.summary.issues > 0], [['site/index.html', 'site/style.css'], 2, true]);

  console.log('\nfix a file through the panel: one request');
  const indexUri = s1.files.find(f => f.relPath === 'site/index.html').uri;
  await st.send({ type: 'fixFile', uri: indexUri });
  await wait(150);
  check('ONE request to Anthropic for every issue in the file, with the strong model and the image', [st.http.length, st.http[0].body.model, st.http[0].body.messages[0].content.filter(c => c.type === 'image').length], [1, 'claude-opus-5-5', 1]);
  const s2 = lastState();
  const img = s2.proposals.find(p => p.ruleId === 'img-alt-missing');
  check('proposals reach the Fixes tab, verified, with a diff', [img.decision, img.verification.verified, img.diff.some(d => d.t === '+' && /alt="Portrait of the CEO"/.test(d.s))], ['pending', true, true]);

  console.log('\naccept / reject');
  await st.send({ type: 'accept', id: img.id });
  await wait(150);
  check('Accept applies exactly that edit', [st.applied.length, docs.get(path.join(root, 'site/index.html')).text.includes('<img src="ceo.png" alt="Portrait of the CEO">')], [1, true]);
  const link = lastState().proposals.find(p => p.ruleId === 'anchor-no-text');
  check('...the other proposal still applies cleanly after the text moved', [link.decision, link.diff.length > 0], ['pending', true]);
  st.send({ type: 'reject', id: link.id }); await wait(120);
  const s3 = lastState();
  check('Reject records the decision and changes nothing', [s3.proposals.find(p => p.id === img.id).decision, s3.proposals.find(p => p.id === link.id).decision, st.applied.length], ['accepted', 'rejected', 1]);
  check('after Accept the file is rescanned: the image issue is gone', s3.files.find(f => f.uri === indexUri).issues.some(i => i.ruleId === 'img-alt-missing'), false);

  console.log('\nre-running costs nothing for unchanged issues');
  await st.send({ type: 'fixFile', uri: indexUri });
  await wait(150);
  const resent = st.http.length > 1 ? [...st.http[1].body.messages[0].content.find(c => c.type === 'text').text.matchAll(/### I\d+ - ([\w-]+)/g)].map(m => m[1]) : [];
  check('only the unresolved issue whose surroundings changed is asked again; the answered link is reused', [st.http.length, resent], [2, ['html-missing-lang']]);
  await st.send({ type: 'fixFile', uri: indexUri });
  await wait(150);
  check('nothing changed since: no request at all', st.http.length, 2);

  console.log('\nsettings from the panel');
  await st.send({ type: 'setting', key: 'remediationMode', value: 'hybrid' });
  await st.send({ type: 'setting', key: 'remediationMode', value: 'yolo' });
  await st.send({ type: 'setting', key: 'aiApiKey', value: 'sk-x' });
  check('valid values are written, invalid values and unknown keys are ignored', [settings.remediationMode, settings.aiApiKey], ['hybrid', undefined]);

  console.log('\nreport');
  await st.commands['accessgen.exportReport']();
  const report = fs.readFileSync(path.join(root, 'report.md'), 'utf8');
  check('the report lists the scanned files and the applied fix', [report.includes('site/style.css'), /Fixes applied \|[\s\S]*\| 1 \|/.test(report)], [true, true]);

  ext.deactivate();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
