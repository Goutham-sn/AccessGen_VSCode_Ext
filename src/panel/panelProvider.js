// The AccessGen side panel (a webview view in its own Activity Bar container): Issues, Fixes and Settings.
// The webview only renders state and posts intents; every action runs here through `actions` supplied by
// extension.js. Messages from the webview are validated before use.

const vscode = require('vscode');
const crypto = require('crypto');
const { titleOf, impactOf, categoryOf, CATEGORIES } = require('../rules/titles');

const VIEW_ID = 'accessgen.panel';
const SETTINGS = {
  remediationMode: ['manual', 'hybrid', 'auto'],
  aiReviewMode: ['off', 'manual', 'auto'],
  aiProvider: ['openai', 'anthropic'],
  complianceLevel: ['A', 'AA', 'AAA'],
  aiRemediationStrategy: ['batch', 'per-issue'],
  aiSendImages: [true, false],
  aiModel: 'text',
  aiRemediationModel: 'text'
};

function createPanelProvider({ extensionUri, store, controller, actions, getConfig, relPath, activeUri }) {
  let view = null;
  let busy = null;
  let pending = false;
  const baseUri = () => (typeof extensionUri === 'function' ? extensionUri() : extensionUri);

  function state() {
    const cfg = getConfig();
    const active = typeof activeUri === 'function' ? activeUri() : null;
    // Pages with issues, plus the active page when it was scanned and is clean (so it can be shown as clean).
    const files = store.listFiles().filter(f => f.violations.length || f.uri === active).map(f => ({
      uri: f.uri,
      relPath: relPath(f.uri),
      languageId: f.languageId,
      issues: f.violations.map((v, i) => ({
        index: i, ruleId: v.ruleId, title: titleOf(v.ruleId), impact: impactOf(v.ruleId), category: categoryOf(v.ruleId), severity: v.severity, wcag: (v.message && v.message.wcag) || '',
        line: v.startLine + 1, what: (v.message && v.message.what) || '', fix: (v.message && v.message.fix) || ''
      })).sort((x, y) => x.line - y.line)
    })).sort((a, b) => a.relPath.localeCompare(b.relPath));
    const proposals = store.listProposals().map(p => {
      const f = store.getFile(p.uri);
      return {
        id: p.id, uri: p.uri, relPath: relPath(p.uri), ruleId: p.ruleId, title: titleOf(p.ruleId), impact: impactOf(p.ruleId), category: categoryOf(p.ruleId), wcag: p.wcag || '', severity: p.severity, line: p.line,
        hasInput: !!p.hasInput, suggestions: p.suggestions || [],
        status: p.status, decision: p.decision, source: p.source, confidence: p.confidence, summary: p.summary,
        steps: p.steps || [], testing: p.testing || '', needsInput: p.needsInput || '', model: p.model || '',
        coveredBy: p.coveredBy || '', problem: p.problem || '',
        verification: p.verification ? { verified: p.verification.verified, reason: p.verification.reason, newIssues: p.verification.newIssues || [] } : null,
        diff: f && typeof f.source === 'string' && p.decision === 'pending' ? controller.diffLines(f.source, p.ranges) : []
      };
    }).sort((a, b) => (a.decision === 'pending' ? 0 : 1) - (b.decision === 'pending' ? 0 : 1) || a.relPath.localeCompare(b.relPath) || a.line - b.line);
    return {
      summary: store.summary(),
      activeUri: active,
      categories: CATEGORIES,
      files,
      proposals,
      busy,
      settings: {
        remediationMode: cfg.remediationMode, aiReviewMode: cfg.aiReviewMode, aiProvider: cfg.aiProvider,
        complianceLevel: cfg.complianceLevel, aiRemediationStrategy: cfg.aiRemediationStrategy, aiSendImages: cfg.aiSendImages,
        aiModel: cfg.aiModel, aiRemediationModel: cfg.aiRemediationModel, remediationModelEffective: actions.remediationModel()
      }
    };
  }

  function refresh() {
    if (!view || pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (view) view.webview.postMessage({ type: 'state', data: state() });
    }, 50);
  }

  async function runBusy(label, fn) {
    busy = label;
    refresh();
    try { await fn(); } catch (e) { console.error('AccessGen panel action failed:', e && e.message ? e.message : e); }
    finally { busy = null; refresh(); }
  }

  async function onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const str = (v) => (typeof v === 'string' ? v : '');
    switch (m.type) {
      case 'ready': refresh(); break;
      case 'scanFile': await runBusy('Scanning file…', () => actions.scanActive()); break;
      case 'scanFiles': await runBusy('Scanning selected files…', () => actions.scanSelected()); break;
      case 'scanWorkspace': await runBusy('Scanning project…', () => actions.scanWorkspace()); break;
      case 'open': await actions.open(str(m.uri), Number(m.line) || 1); break;
      case 'fixFile': await runBusy('AI is fixing ' + (relPath(str(m.uri)) || 'file') + '…', () => actions.fixFiles([str(m.uri)])); break;
      case 'fixIssue': await runBusy('AI is fixing one issue…', () => actions.fixIssue(str(m.uri), Number(m.index))); break;
      case 'fixAll': await runBusy('AI is fixing all scanned files…', () => actions.fixFiles(null)); break;
      case 'preview': await controller.preview(str(m.id), str(m.value)); break;
      case 'accept': await controller.accept(str(m.id), { value: str(m.value) }); break;
      case 'reject': controller.reject(str(m.id)); break;
      case 'acceptAllVerified': await runBusy('Applying verified fixes…', () => controller.acceptAllVerified()); break;
      case 'setKey': await vscode.commands.executeCommand('accessgen.setAiApiKey'); break;
      case 'exportReport': await vscode.commands.executeCommand('accessgen.exportReport'); break;
      case 'setting': {
        const allowed = SETTINGS[m.key];
        if (!allowed) return;
        const value = allowed === 'text' ? str(m.value).trim() : m.value;
        if (allowed !== 'text' && !allowed.includes(value)) return;
        const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration('accessgen').update(m.key, value, target);
        break;
      }
      default: break;
    }
  }

  function html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(baseUri(), 'media', 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(baseUri(), 'media', 'panel.js'));
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + '; script-src \'nonce-' + nonce + '\'; img-src ' + webview.cspSource + ' data:;">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<link rel="stylesheet" href="' + css + '"><title>AccessGen</title></head>' +
      '<body><main id="app" aria-label="AccessGen accessibility issues and fixes"></main>' +
      '<script nonce="' + nonce + '" src="' + js + '"></script></body></html>';
  }

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(baseUri(), 'media')] };
      webviewView.webview.html = html(webviewView.webview);
      webviewView.webview.onDidReceiveMessage((m) => { onMessage(m).catch(e => console.error('AccessGen panel:', e && e.message)); });
      webviewView.onDidDispose(() => { view = null; });
      webviewView.onDidChangeVisibility(() => { if (webviewView.visible) refresh(); });
    }
  };

  function register(context) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
      store.onChange(refresh)
    );
  }

  return { register, refresh, runBusy, state, VIEW_ID };
}

module.exports = { createPanelProvider, VIEW_ID };
