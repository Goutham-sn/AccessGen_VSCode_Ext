// A Markdown accessibility report of everything scanned this session: summary, rule breakdown, every issue with its
// WCAG criterion, and what happened to its fix. vscode-free: relPath is supplied.

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function buildReport({ store, relPath, generatedAt }) {
  const s = store.summary();
  const files = store.listFiles().filter(f => f.violations.length).sort((a, b) => relPath(a.uri).localeCompare(relPath(b.uri)));
  const proposals = store.listProposals();
  const fixFor = (uri, v) => proposals.find(p => p.uri === uri && p.ruleId === v.ruleId && p.line === v.startLine + 1);
  const lines = [];
  lines.push('# AccessGen accessibility report', '');
  lines.push('Generated ' + (generatedAt || new Date()).toISOString() + '.', '');
  lines.push('| Score | Files scanned | Files with issues | Critical | Warnings | Advisory | Fixes applied |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push('| ' + [s.score === null ? '-' : s.score, s.files, s.filesWithIssues, s.critical, s.warning, s.advisory, s.accepted].join(' | ') + ' |', '');

  const byRule = new Map();
  for (const f of files) for (const v of f.violations) {
    const r = byRule.get(v.ruleId) || { count: 0, wcag: (v.message && v.message.wcag) || '', severity: v.severity };
    r.count++; byRule.set(v.ruleId, r);
  }
  if (byRule.size) {
    lines.push('## Issues by rule', '', '| Rule | Severity | WCAG | Count |', '|---|---|---|---|');
    for (const [id, r] of [...byRule].sort((a, b) => b[1].count - a[1].count)) lines.push('| `' + id + '` | ' + r.severity + ' | ' + esc(r.wcag) + ' | ' + r.count + ' |');
    lines.push('');
  }

  lines.push('## Issues by file', '');
  if (!files.length) lines.push('No issues found.');
  for (const f of files) {
    lines.push('### ' + relPath(f.uri) + ' (' + f.violations.length + ')', '', '| Line | Severity | Rule | Problem | WCAG | Fix |', '|---|---|---|---|---|---|');
    for (const v of [...f.violations].sort((a, b) => a.startLine - b.startLine)) {
      const p = fixFor(f.uri, v);
      const fix = !p ? '' : p.decision === 'accepted' ? 'applied' : p.decision === 'rejected' ? 'rejected' : p.status === 'fixed' && p.verification && p.verification.verified ? 'verified fix pending' : p.status;
      lines.push('| ' + (v.startLine + 1) + ' | ' + v.severity + ' | `' + v.ruleId + '` | ' + esc(v.message && v.message.what) + ' | ' + esc(v.message && v.message.wcag) + ' | ' + esc(fix) + ' |');
    }
    lines.push('');
  }
  lines.push('_Static analysis finds a subset of WCAG failures. Also test with a keyboard and a screen reader._', '');
  return lines.join('\n');
}

module.exports = { buildReport };
