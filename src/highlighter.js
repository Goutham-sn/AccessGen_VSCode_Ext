const vscode = require('vscode');

const CRITICAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="rgba(220,38,38,0.9)"/><path d="M8 4v5" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.5" r="1" fill="white"/></svg>`;
const WARNING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2L15 14H1L8 2Z" fill="rgba(217,119,6,0.85)"/><path d="M8 6v4" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="white"/></svg>`;
const ADVISORY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="rgba(37,99,235,0.75)"/><path d="M8 7v5" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="5" r="1" fill="white"/></svg>`;

let criticalDecoration = null;
let warningDecoration = null;
let advisoryDecoration = null;

function ensureDecorations() {
  if (criticalDecoration && warningDecoration && advisoryDecoration) return;

  // Lazily initialize to avoid module-load failures that prevent the Extension Host from starting.
  try {
    criticalDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(220, 38, 38, 0.15)',
      borderLeft: '3px solid rgba(220, 38, 38, 0.9)',
      isWholeLine: false,
      overviewRulerColor: 'rgba(220, 38, 38, 0.9)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(CRITICAL_SVG)}`),
      gutterIconSize: 'contain'
    });

    warningDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(217, 119, 6, 0.12)',
      borderLeft: '3px solid rgba(217, 119, 6, 0.8)',
      isWholeLine: false,
      overviewRulerColor: 'rgba(217, 119, 6, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(WARNING_SVG)}`),
      gutterIconSize: 'contain'
    });

    advisoryDecoration = vscode.window.createTextEditorDecorationType({
      textDecoration: 'underline wavy rgba(37, 99, 235, 0.7)',
      overviewRulerColor: 'rgba(37, 99, 235, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(ADVISORY_SVG)}`),
      gutterIconSize: 'contain'
    });
  } catch (e) {
    console.error('AccessGen: Failed to create decorations:', e && e.message ? e.message : e);

    // Minimal fallback so the extension host stays alive.
    try {
      criticalDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(220, 38, 38, 0.15)'
      });
      warningDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(217, 119, 6, 0.12)'
      });
      advisoryDecoration = vscode.window.createTextEditorDecorationType({
        textDecoration: 'underline wavy rgba(37, 99, 235, 0.7)'
      });
    } catch (e2) {
      console.error('AccessGen: Failed to create fallback decorations:', e2 && e2.message ? e2.message : e2);
      criticalDecoration = null;
      warningDecoration = null;
      advisoryDecoration = null;
    }
  }
}

function clampRange(doc, startLine, startChar, endLine, endChar) {
  const maxLine = doc.lineCount - 1;
  let sl = startLine;
  let el = endLine;

  if (!Number.isFinite(sl)) sl = 0;
  if (!Number.isFinite(el)) el = sl;

  sl = Math.max(0, Math.min(sl, maxLine));
  el = Math.max(0, Math.min(el, maxLine));

  if (el < sl) {
    const tmp = sl;
    sl = el;
    el = tmp;
  }

  const lineLenStart = doc.lineAt(sl).text.length;
  const lineLenEnd = doc.lineAt(el).text.length;

  let sc = startChar;
  let ec = endChar;
  if (!Number.isFinite(sc)) sc = 0;
  if (!Number.isFinite(ec)) ec = sc;

  sc = Math.max(0, Math.min(sc, lineLenStart));
  ec = Math.max(0, Math.min(ec, lineLenEnd));

  // VS Code expects start <= end. Ensure that for same-line ranges.
  if (sl === el && ec < sc) ec = sc;

  // Ensure non-empty range for visible decorations.
  if (sl === el) {
    const lineLen = lineLenEnd;
    if (lineLen > 0) {
      // If the range starts at end-of-line, shift back one char.
      if (sc >= lineLen) sc = lineLen - 1;
      if (ec <= sc) ec = Math.min(sc + 1, lineLen);
      if (ec === sc && lineLen > sc + 1) ec = sc + 1;
    }
  }

  return new vscode.Range(sl, sc, el, ec);
}

function applyHighlights(editor, violations) {
  if (!editor) return;

  try {
    ensureDecorations();
    if (!criticalDecoration || !warningDecoration || !advisoryDecoration) return;

    const doc = editor.document;
    const critical = [];
    const warning = [];
    const advisory = [];

    // Ensure the editor looks clean even if a rule produces an empty array.
    clearHighlights(editor);

    for (const v of violations) {
      const range = clampRange(doc, v.startLine, v.startChar, v.endLine, v.endChar);

      switch (v.severity) {
        case 'critical':
          critical.push({ range });
          break;
        case 'warning':
          warning.push({ range });
          break;
        case 'advisory':
          advisory.push({ range });
          break;
      }
    }

    editor.setDecorations(criticalDecoration, critical);
    editor.setDecorations(warningDecoration, warning);
    editor.setDecorations(advisoryDecoration, advisory);
  } catch (e) {
    console.error('AccessGen: Failed to apply highlights:', e && e.message ? e.message : e);
  }
}

function clearHighlights(editor) {
  if (!editor) return;
  try {
    ensureDecorations();
    if (!criticalDecoration || !warningDecoration || !advisoryDecoration) return;
    editor.setDecorations(criticalDecoration, []);
    editor.setDecorations(warningDecoration, []);
    editor.setDecorations(advisoryDecoration, []);
  } catch (e) {
    console.error('AccessGen: Failed to clear highlights:', e && e.message ? e.message : e);
  }
}

function disposeDecorations() {
  try {
    if (criticalDecoration) criticalDecoration.dispose();
    if (warningDecoration) warningDecoration.dispose();
    if (advisoryDecoration) advisoryDecoration.dispose();
  } catch (e) {
    // Ignore dispose errors during shutdown.
  } finally {
    criticalDecoration = null;
    warningDecoration = null;
    advisoryDecoration = null;
  }
}

module.exports = {
  applyHighlights,
  clearHighlights,
  disposeDecorations
};
