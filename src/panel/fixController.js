// Applies, previews and dismisses batch-remediation proposals (the panel's Fixes tab and the inline diff).
// The only place a proposal becomes a WorkspaceEdit. Before applying, every range must still hold the text it was
// computed against (or that text must occur exactly once elsewhere, if the file shifted); otherwise the proposal is
// marked stale and nothing is applied.

const vscode = require('vscode');
const { applyRanges } = require('../remediation/batch/verify');

const PREVIEW_SCHEME = 'accessgen-fix';

function relocate(text, ranges) {
  const out = [];
  for (const r of ranges || []) {
    if (text.slice(r.start, r.end) === r.oldText) { out.push(r); continue; }
    const first = text.indexOf(r.oldText);
    if (first < 0 || text.indexOf(r.oldText, first + 1) >= 0 || !r.oldText) return null;
    out.push({ ...r, start: first, end: first + r.oldText.length });
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) return null;
  return out;
}

// A compact before/after of the lines an edit touches, for the panel.
function diffLines(text, ranges) {
  const out = [];
  for (const r of ranges || []) {
    const ls = text.lastIndexOf('\n', r.start - 1) + 1;
    let le = text.indexOf('\n', r.end);
    if (le < 0) le = text.length;
    const before = text.slice(ls, le).replace(/\r$/, '');
    const after = (text.slice(ls, r.start) + r.newText + text.slice(r.end, le)).replace(/\r$/, '');
    const line = text.slice(0, ls).split('\n').length;
    if (out.length) out.push({ t: '…', s: '' });
    out.push({ t: '@', s: 'line ' + line });
    for (const l of before.split(/\r?\n/).slice(0, 30)) out.push({ t: '-', s: l });
    for (const l of after.split(/\r?\n/).slice(0, 30)) out.push({ t: '+', s: l });
  }
  return out;
}

function createFixController({ store, rescan }) {
  const previews = new Map(); // preview uri string -> text
  const changed = typeof vscode.EventEmitter === 'function' ? new vscode.EventEmitter() : { event: undefined, fire() {}, dispose() {} };
  const provider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) || ''
  };

  async function documentOf(p) {
    return vscode.workspace.openTextDocument(vscode.Uri.parse(p.uri));
  }

  async function preview(id) {
    const p = store.getProposal(id);
    if (!p || !p.ranges || !p.ranges.length) return;
    const doc = await documentOf(p);
    const ranges = relocate(doc.getText(), p.ranges);
    if (!ranges) { store.decide(id, 'stale'); vscode.window.showWarningMessage('AccessGen: the code changed since this fix was proposed. Run the fix again.'); return; }
    const uri = vscode.Uri.parse(PREVIEW_SCHEME + ':/' + encodeURIComponent(id) + '/' + require('path').basename(doc.uri.fsPath || 'file'));
    previews.set(uri.toString(), applyRanges(doc.getText(), ranges));
    changed.fire(uri);
    await vscode.commands.executeCommand('vscode.diff', doc.uri, uri, 'AccessGen fix: ' + p.ruleId + ' (line ' + p.line + ') — current ↔ proposed');
  }

  async function accept(id, { silent } = {}) {
    const p = store.getProposal(id);
    if (!p || p.decision !== 'pending' || !p.ranges || !p.ranges.length) return false;
    const doc = await documentOf(p);
    const text = doc.getText();
    const ranges = relocate(text, p.ranges);
    if (!ranges) {
      store.decide(id, 'stale');
      if (!silent) vscode.window.showWarningMessage('AccessGen: the code changed since this fix was proposed, so nothing was applied. Run the fix again.');
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const r of ranges) edit.replace(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.newText);
    let ok = false;
    try { ok = await vscode.workspace.applyEdit(edit); } catch (e) { ok = false; }
    if (!ok) { if (!silent) vscode.window.showErrorMessage('AccessGen: VS Code rejected the edit; nothing was applied.'); return false; }
    store.decide(id, 'accepted');
    for (const other of store.listProposals()) if (other.coveredBy === id && other.decision === 'pending') store.decide(other.id, 'accepted');
    store.shiftAfterEdit(p.uri, ranges);
    if (typeof rescan === 'function') rescan(doc.uri);
    return true;
  }

  function reject(id) {
    return !!store.decide(id, 'rejected');
  }

  // Applies every pending proposal that passed all local checks and needs no input, file by file. Each accepted edit
  // shifts the others; one that no longer applies cleanly is skipped (stale), never forced.
  async function acceptAllVerified(uri) {
    const list = store.listProposals().filter(p => p.decision === 'pending' && p.status === 'fixed' && p.verification && p.verification.verified && (!uri || p.uri === uri));
    let applied = 0, skipped = 0;
    for (const p of list) {
      if (store.getProposal(p.id).decision !== 'pending') continue;
      if (await accept(p.id, { silent: true })) applied++; else skipped++;
    }
    vscode.window.showInformationMessage('AccessGen: applied ' + applied + ' verified fix' + (applied === 1 ? '' : 'es') + (skipped ? ', ' + skipped + ' skipped because the code had changed' : '') + '. Undo (Ctrl+Z) reverts them per file.');
    return { applied, skipped };
  }

  function register(context) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider), changed);
  }

  return { preview, accept, reject, acceptAllVerified, register, diffLines, relocate };
}

module.exports = { createFixController, relocate, diffLines, PREVIEW_SCHEME };
