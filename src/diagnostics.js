const vscode = require('vscode');
const { getRuleById } = require('./analyzer');
const { titleOf } = require('./rules/titles');

let diagnosticCollection = null;
// uri -> violations[], plus fixable violations under fixKey(uri, ruleId, range) -> violation.
const violationMap = new Map();
const FIX_PREFIX = 'fix\u0000';

function fixKey(uriString, ruleId, range) {
  return `${FIX_PREFIX}${uriString}\u0000${ruleId}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function purgeFixEntries(uriString) {
  const prefix = `${FIX_PREFIX}${uriString}\u0000`;
  for (const k of [...violationMap.keys()]) {
    if (k.startsWith(prefix)) violationMap.delete(k);
  }
}

function init() {
  if (!diagnosticCollection) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('accessgen');
  }
}

function clampRange(document, startLine, startChar, endLine, endChar) {
  const maxLine = document.lineCount - 1;
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

  const lineLenStart = document.lineAt(sl).text.length;
  const lineLenEnd = document.lineAt(el).text.length;

  let sc = startChar;
  let ec = endChar;
  if (!Number.isFinite(sc)) sc = 0;
  if (!Number.isFinite(ec)) ec = sc;

  sc = Math.max(0, Math.min(sc, lineLenStart));
  ec = Math.max(0, Math.min(ec, lineLenEnd));

  if (sl === el && ec < sc) ec = sc;
  if (sl === el) {
    const lineLen = lineLenEnd;
    if (lineLen > 0) {
      if (sc >= lineLen) sc = lineLen - 1;
      if (ec <= sc) ec = Math.min(sc + 1, lineLen);
    }
  }

  return new vscode.Range(sl, sc, el, ec);
}

function truncateMessage(what, fix, maxLen) {
  let msg = `${what} ${fix}`;
  if (msg.length > maxLen) {
    msg = msg.substring(0, maxLen - 3) + '...';
  }
  return msg;
}

function updateDiagnostics(document, violations) {
  init();
  const uriString = document.uri.toString();
  purgeFixEntries(uriString);
  violationMap.set(uriString, violations);

  const diagnostics = violations.map(v => {
    const range = clampRange(document, v.startLine, v.startChar, v.endLine, v.endChar);

    let severity;
    switch (v.severity) {
      case 'critical':
        severity = vscode.DiagnosticSeverity.Error;
        break;
      case 'warning':
        severity = vscode.DiagnosticSeverity.Warning;
        break;
      default:
        severity = vscode.DiagnosticSeverity.Information;
    }

    const message = truncateMessage(v.message.what, v.message.fix, 150);
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = 'AccessGen';
    diagnostic.code = v.ruleId;
    const rule = getRuleById(v.ruleId);
    if (rule) {
      // Every rule has a fixer: its own fix(), or the generic AI one (judgment/genericFix.js).
      violationMap.set(fixKey(uriString, v.ruleId, range), v);
    }
    return diagnostic;
  });

  diagnosticCollection.set(document.uri, diagnostics);
}

function clearDiagnostics(document) {
  if (!diagnosticCollection) return;
  purgeFixEntries(document.uri.toString());
  violationMap.delete(document.uri.toString());
  diagnosticCollection.delete(document.uri);
}

function disposeAll() {
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
    diagnosticCollection = null;
  }
  violationMap.clear();
}

function getViolationsForUri(uriString) {
  return violationMap.get(uriString) || [];
}

function getFixableViolation(uriString, ruleId, range) {
  return violationMap.get(fixKey(uriString, ruleId, range)) || null;
}

function registerHoverProvider(context) {
  const provider = vscode.languages.registerHoverProvider(
    [
      { language: 'html' },
      { language: 'javascriptreact' },
      { language: 'typescriptreact' },
      { language: 'css' }
    ],
    {
      provideHover(document, position) {
        const violations = violationMap.get(document.uri.toString());
        if (!violations || !violations.length) return null;

        const violation = violations.find(v => {
          const range = new vscode.Range(
            v.startLine, v.startChar,
            v.endLine, v.endChar
          );
          return range.contains(position);
        });

        if (!violation) return null;

        const severityLabel = { critical: 'Critical', warning: 'Warning' }[violation.severity] || 'Advisory';
        const md = new vscode.MarkdownString();
        md.isTrusted = false;
        md.supportHtml = false;
        const esc = (s) => String(s || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

        md.appendMarkdown(`**${esc(titleOf(violation.ruleId))}**\n\n`);
        md.appendMarkdown(`${esc(severityLabel)} · ${esc(violation.message.wcag)}\n\n---\n\n`);
        md.appendMarkdown(`${esc(violation.message.what)}\n\n`);
        md.appendMarkdown(`**Who is affected:** ${esc(violation.message.why)}\n\n`);
        md.appendMarkdown(`**How to fix:** ${esc(violation.message.fix)}\n\n`);
        md.appendMarkdown(`_AccessGen rule \`${violation.ruleId}\`. Fix it with AI from the lightbulb or the AccessGen panel; silence one finding with \`accessgen-disable-next-line ${violation.ruleId}\`._`);

        const range = new vscode.Range(
          violation.startLine, violation.startChar,
          violation.endLine, violation.endChar
        );
        return new vscode.Hover(md, range);
      }
    }
  );

  context.subscriptions.push(provider);
}

module.exports = {
  init,
  updateDiagnostics,
  clearDiagnostics,
  disposeAll,
  getViolationsForUri,
  getFixableViolation,
  registerHoverProvider
};
