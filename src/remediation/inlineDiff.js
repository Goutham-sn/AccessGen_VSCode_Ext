// Inline-diff review of suggested fixes: NOTHING in AccessGen edits a document without an explicit Accept.
//
// A "suggestion" is a computed fix (old range + new text + the WorkspaceEdit that would apply it) that is
// rendered in the editor and waits for the developer:
//   - the old range gets a strikethrough + reddish decoration;
//   - the suggested new text is shown right after it (a decoration's `after` content) with a greenish tint;
//   - a CodeLens above the line offers "✓ Accept fix" and "✗ Dismiss".
//
// State (in memory, per document, nothing persisted or sent anywhere):
//   pending   Map<identity, suggestion> per document. A suggestion is keyed by the same structural-path +
//             content-hash identity changeTracker uses, so a rescan neither recomputes nor re-renders one
//             that is already pending, and one that was decided is never proposed again.
//   decided   changeTracker dispositions: 'applied' (accepted) or 'rejected' (dismissed). A rejected identity
//             is not re-suggested; editing the violating content yields a NEW identity, which is.
//
// Accept applies the stored edit (built by codeActions.buildFixEdit / buildAiFixEdit, the same constructors
// the quick fixes use) and marks the identity applied. Dismiss clears the suggestion and marks it rejected.
// The only call to workspace.applyEdit in the remediation code is in accept() below.
//
// Events (inline.on): 'suggested', 'accepted', 'rejected', 'applyFailed', 'stale'. Each handler receives a
// plain record { ruleId, tier, line, slot, id, filePath } (+ reason for applyFailed / stale).

const vscode = require('vscode');
const { createChangeTracker } = require('../judgment/changeTracker');
const { rangeText } = require('./autoFix');

const ACCEPT_COMMAND = 'accessgen.acceptInlineFix';
const REJECT_COMMAND = 'accessgen.rejectInlineFix';
const LENS_LANGUAGES = ['html', 'css', 'javascriptreact', 'typescriptreact'];
const MAX_SHOWN_CHARS = 240;

const fileKeyOf = (document) => (document && document.uri && (document.uri.fsPath || document.uri.toString())) || '(unknown)';

const sameRange = (a, b) => a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar;
const before = (l1, c1, l2, c2) => l1 < l2 || (l1 === l2 && c1 < c2);
// Do two ranges share any text (touching end-to-start does not count)?
function overlap(a, b) {
  return before(a.startLine, a.startChar, b.endLine, b.endChar) && before(b.startLine, b.startChar, a.endLine, a.endChar);
}

// Where a position that was AFTER a replaced range ends up once the replacement is in.
function shiftPosition(line, char, replaced, newText) {
  const newLines = newText.split('\n');
  const lineDelta = (newLines.length - 1) - (replaced.endLine - replaced.startLine);
  if (line === replaced.endLine) {
    const tail = char - replaced.endChar;
    return newLines.length === 1
      ? { line: replaced.startLine, char: replaced.startChar + newText.length + tail }
      : { line: replaced.startLine + newLines.length - 1, char: newLines[newLines.length - 1].length + tail };
  }
  return { line: line + lineDelta, char };
}

// How a suggestion's new text is shown after the old one: one line, bounded.
function displayText(text) {
  const flat = String(text).replace(/\s*\r?\n\s*/g, ' ⏎ ');
  return ' ' + (flat.length > MAX_SHOWN_CHARS ? flat.slice(0, MAX_SHOWN_CHARS) + '…' : flat);
}

// options.getEditors(document) -> the visible editors showing that document (default: visibleTextEditors,
// falling back to the active one).
function createInlineDiff(options = {}) {
  const tracker = createChangeTracker();   // dispositions only: 'applied' | 'rejected'
  const docs = new Map();                  // fileKey -> Map<identity, suggestion>
  const documents = new Map();             // fileKey -> the vscode.TextDocument (needed to clear decorations)
  const dirty = new Set();                 // fileKeys whose rendering is out of date
  const listeners = new Map();             // event -> [fn]
  let removedType = null, addedType = null; // decoration types, created on first use
  const lensChanged = typeof vscode.EventEmitter === 'function' ? new vscode.EventEmitter() : null;

  const getEditors = options.getEditors || ((document) => {
    const w = vscode.window;
    const all = Array.isArray(w.visibleTextEditors) ? w.visibleTextEditors : (w.activeTextEditor ? [w.activeTextEditor] : []);
    const key = document.uri && document.uri.toString();
    return all.filter(e => e && e.document && e.document.uri && e.document.uri.toString() === key);
  });

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  }
  function emit(event, rec) {
    for (const fn of listeners.get(event) || []) {
      try { fn(rec); } catch (e) { console.error('AccessGen: inline-diff listener error:', e && e.message ? e.message : e); }
    }
  }
  const recOf = (s, extra) => ({ ruleId: s.ruleId, tier: s.tier, line: s.range.startLine + 1, slot: s.slot, id: s.id, filePath: s.file, ...(extra || {}) });

  const mapOf = (file, create) => {
    let m = docs.get(file);
    if (!m && create) { m = new Map(); docs.set(file, m); }
    return m;
  };
  const get = (file, id) => { const m = docs.get(file); return m ? m.get(id) : undefined; };
  const list = (file) => {
    const m = docs.get(file);
    return m ? [...m.values()].sort((a, b) => a.range.startLine - b.range.startLine || a.range.startChar - b.range.startChar) : [];
  };

  // ---- rendering -----------------------------------------------------------------------------
  function ensureTypes() {
    if (removedType) return;
    removedType = vscode.window.createTextEditorDecorationType({
      textDecoration: 'line-through',
      backgroundColor: 'rgba(255, 70, 70, 0.22)',
      overviewRulerColor: 'rgba(255, 70, 70, 0.8)'
    });
    addedType = vscode.window.createTextEditorDecorationType({
      after: { backgroundColor: 'rgba(60, 190, 90, 0.28)', margin: '0 0 0 2px' }
    });
  }

  function render(file) {
    dirty.delete(file);
    const entries = list(file);
    const document = documents.get(file);
    if (!document) return;
    if (!entries.length && !removedType) return;
    ensureTypes();
    const removed = [], added = [];
    for (const s of entries) {
      const r = s.range;
      const hover = 'AccessGen suggests (' + s.ruleId + (s.detail ? ', ' + s.detail : '') + ')';
      removed.push({ range: new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), hoverMessage: hover });
      added.push({
        range: new vscode.Range(r.endLine, r.endChar, r.endLine, r.endChar),
        hoverMessage: hover,
        renderOptions: { after: { contentText: displayText(s.newText) } }
      });
    }
    for (const editor of getEditors(document)) {
      try {
        editor.setDecorations(removedType, removed);
        editor.setDecorations(addedType, added);
      } catch (e) { console.error('AccessGen: could not render inline fixes:', e && e.message ? e.message : e); }
    }
    if (lensChanged) lensChanged.fire();
  }

  // Re-renders a document only if something about its suggestions changed since the last render.
  function flush(document) {
    const file = fileKeyOf(document);
    if (dirty.has(file)) render(file);
  }
  // Forced: the editor was (re)opened or came to the front, so its decorations may be gone.
  function show(document) { render(fileKeyOf(document)); }

  // ---- state ---------------------------------------------------------------------------------
  // s = { document, id, slot, ruleId, tier, kind: 'sync' | 'ai', built: { edit, newText, range }, oldText, detail }
  // Returns 'new' | 'refreshed' | 'unchanged'. Never overwrites a decided identity.
  function propose(s) {
    if (tracker.dispositionOf(s.id)) return 'unchanged';
    const file = fileKeyOf(s.document);
    const m = mapOf(file, true);
    documents.set(file, s.document);
    const entry = {
      document: s.document, file, id: s.id, slot: s.slot, ruleId: s.ruleId, tier: s.tier, kind: s.kind,
      edit: s.built.edit, meta: s.built.meta, newText: s.built.newText, range: { ...s.built.range }, oldText: s.oldText, detail: s.detail || ''
    };
    const existing = m.get(s.id);
    if (existing) {
      if (sameRange(existing.range, entry.range) && existing.newText === entry.newText && existing.oldText === entry.oldText) return 'unchanged';
      m.set(s.id, entry);
      dirty.add(file);
      return 'refreshed';
    }
    m.set(s.id, entry);
    dirty.add(file);
    emit('suggested', recOf(entry));
    return 'new';
  }

  function remove(file, id) {
    const m = docs.get(file);
    if (m && m.delete(id)) { dirty.add(file); return true; }
    return false;
  }

  // Drops every pending suggestion for which keep(entry) is false: the violation is gone, no longer
  // eligible in the current mode, or (AI suggestions, which are not recomputed) its text moved.
  function reconcile(document, keep) {
    const file = fileKeyOf(document);
    const m = docs.get(file);
    if (!m) return;
    for (const [id, e] of [...m]) if (!keep(e)) { m.delete(id); dirty.add(file); }
  }

  function dropAll(document) {
    const file = fileKeyOf(document);
    const m = docs.get(file);
    if (m && m.size) { m.clear(); dirty.add(file); }
    if (dirty.has(file)) render(file);
  }

  function overlaps(document, range, exceptId) {
    for (const e of list(fileKeyOf(document))) if (e.id !== exceptId && overlap(e.range, range)) return true;
    return false;
  }

  // The same replacement at the suggestion's current range (the stored edit still carries the range it was built at).
  function rebuildEdit(s) {
    const edit = new vscode.WorkspaceEdit();
    const r = s.range;
    edit.replace(s.document.uri, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), s.newText, ...(s.meta ? [s.meta] : []));
    return edit;
  }

  // After an edit replaced `replaced` with `newText`, move the other suggestions of that document with it.
  // One that overlapped the replaced text no longer describes anything and is dropped.
  function shiftAfter(file, replaced, newText) {
    const m = docs.get(file);
    if (!m) return;
    for (const [id, e] of [...m]) {
      const r = e.range;
      if (overlap(r, replaced) || sameRange(r, replaced)) { m.delete(id); continue; }
      if (before(r.startLine, r.startChar, replaced.endLine, replaced.endChar)) continue; // wholly before: unchanged
      const s = shiftPosition(r.startLine, r.startChar, replaced, newText);
      const en = shiftPosition(r.endLine, r.endChar, replaced, newText);
      e.range = { startLine: s.line, startChar: s.char, endLine: en.line, endChar: en.char };
      e.edit = rebuildEdit(e); // the stored edit must move with the range, or Accept would replace the wrong text
    }
    dirty.add(file);
  }

  // ---- decisions -----------------------------------------------------------------------------
  function argOf(arg) {
    return arg && typeof arg === 'object' && typeof arg.file === 'string' && typeof arg.id === 'string' ? arg : null;
  }

  async function accept(arg) {
    const a = argOf(arg);
    const s = a && get(a.file, a.id);
    if (!s) return false; // already decided (a second click), or gone
    // Taken off the pending list synchronously: a double click cannot apply it twice.
    remove(s.file, s.id);
    const document = s.document;
    if (rangeText(document.getText(), s.range) !== s.oldText) {
      // The text under the suggestion changed since it was computed: applying it would damage the file.
      flush(document);
      emit('stale', recOf(s, { reason: 'changed' }));
      return false;
    }
    let ok = false;
    try { ok = await vscode.workspace.applyEdit(s.edit); } catch (e) { ok = false; }
    if (!ok) {
      flush(document);
      emit('applyFailed', recOf(s, { reason: 'edit-rejected' }));
      return false;
    }
    tracker.setDisposition(s.id, 'applied');
    shiftAfter(s.file, s.range, s.newText);
    flush(document);
    emit('accepted', recOf(s));
    return true;
  }

  function reject(arg) {
    const a = argOf(arg);
    const s = a && get(a.file, a.id);
    if (!s) return false;
    remove(s.file, s.id);
    tracker.setDisposition(s.id, 'rejected');
    flush(s.document);
    emit('rejected', recOf(s));
    return true;
  }

  // ---- VS Code registration ------------------------------------------------------------------
  function provideCodeLenses(document) {
    const lenses = [];
    for (const s of list(fileKeyOf(document))) {
      const at = new vscode.Range(s.range.startLine, 0, s.range.startLine, 0);
      const args = [{ file: s.file, id: s.id }];
      lenses.push(new vscode.CodeLens(at, { title: '✓ Accept fix', command: ACCEPT_COMMAND, arguments: args, tooltip: 'Apply this AccessGen fix (' + s.ruleId + ')' }));
      lenses.push(new vscode.CodeLens(at, { title: '✗ Dismiss', command: REJECT_COMMAND, arguments: args, tooltip: 'Discard this suggestion; it will not be suggested again unless the code changes' }));
    }
    return lenses;
  }

  function register(context) {
    const disposables = [
      vscode.commands.registerCommand(ACCEPT_COMMAND, (arg) => accept(arg)),
      vscode.commands.registerCommand(REJECT_COMMAND, (arg) => reject(arg)),
      vscode.languages.registerCodeLensProvider(
        LENS_LANGUAGES.map(language => ({ language })),
        { provideCodeLenses, onDidChangeCodeLenses: lensChanged ? lensChanged.event : undefined }
      )
    ];
    if (context && context.subscriptions) context.subscriptions.push(...disposables);
    return disposables;
  }

  function dispose() {
    for (const t of [removedType, addedType]) if (t && typeof t.dispose === 'function') t.dispose();
    removedType = addedType = null;
    docs.clear();
    documents.clear();
    dirty.clear();
  }

  return {
    tracker, on, propose, remove, reconcile, dropAll, overlaps, flush, show, accept, reject, register, dispose,
    get, list, has: (file, id) => !!get(file, id), provideCodeLenses, fileKeyOf,
    ACCEPT_COMMAND, REJECT_COMMAND
  };
}

module.exports = { createInlineDiff, fileKeyOf, shiftPosition, displayText, ACCEPT_COMMAND, REJECT_COMMAND };
