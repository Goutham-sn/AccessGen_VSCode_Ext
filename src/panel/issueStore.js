// In-memory record of scan results and fix proposals across files, for the panel and the report. vscode-free.
//
// files      uri -> { uri, filePath, relPath, languageId, violations, scannedAt, sourceHash }
// proposals  id  -> proposal (remediation/batch/engine.js) + { uri, decision: 'pending' | 'accepted' | 'rejected' | 'stale' }
//
// A file rescan drops pending proposals whose issue no longer exists or whose code changed (their text would not
// match any more); decided ones are kept for the session summary. Listeners get a single 'change' event, coalesced.

function createIssueStore() {
  const files = new Map();
  const proposals = new Map();
  const listeners = new Set();
  let timer = null;

  function changed() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const fn of listeners) { try { fn(); } catch (e) { console.error('AccessGen: store listener error:', e && e.message); } }
    }, 30);
  }

  function setFile(uri, info) {
    files.set(uri, { uri, ...info, scannedAt: Date.now() });
    const live = new Set((info.issueKeys || []));
    for (const [id, p] of proposals) {
      if (p.uri !== uri || p.decision !== 'pending') continue;
      // The proposal's ranges must still describe the current text, and its issue must still be reported.
      const text = typeof info.source === 'string' ? info.source : null;
      const textOk = !text || (p.ranges || []).every(r => text.slice(r.start, r.end) === r.oldText);
      const issueOk = !info.issueKeys || live.has(p.matchKey) || p.status === 'covered';
      if (!textOk || !issueOk) proposals.delete(id);
    }
    changed();
  }

  function removeFile(uri) {
    files.delete(uri);
    for (const [id, p] of proposals) if (p.uri === uri && p.decision === 'pending') proposals.delete(id);
    changed();
  }

  function addProposals(uri, list) {
    for (const p of list) {
      const existing = proposals.get(p.id);
      if (existing && existing.decision !== 'pending') continue; // a decided issue is not proposed again until its code changes
      proposals.set(p.id, { ...p, uri, decision: 'pending' });
    }
    changed();
  }

  function decide(id, decision) {
    const p = proposals.get(id);
    if (!p) return null;
    p.decision = decision;
    changed();
    return p;
  }

  // After an accepted edit moved text in a file, keep the other pending proposals of that file pointing at their text.
  function shiftAfterEdit(uri, applied) {
    for (const p of proposals.values()) {
      if (p.uri !== uri || p.decision !== 'pending') continue;
      let ok = true;
      const moved = (p.ranges || []).map(r => {
        let delta = 0;
        for (const a of applied) {
          if (a.end <= r.start) delta += a.newText.length - (a.end - a.start);
          else if (a.start < r.end && a.end > r.start) ok = false;
        }
        return { ...r, start: r.start + delta, end: r.end + delta };
      });
      if (ok) p.ranges = moved; else p.decision = 'stale';
    }
    changed();
  }

  function summary() {
    const s = { files: 0, filesWithIssues: 0, issues: 0, critical: 0, warning: 0, advisory: 0, proposals: 0, verified: 0, accepted: 0 };
    for (const f of files.values()) {
      s.files++;
      if (f.violations.length) s.filesWithIssues++;
      for (const v of f.violations) { s.issues++; s[v.severity === 'critical' ? 'critical' : v.severity === 'warning' ? 'warning' : 'advisory']++; }
    }
    for (const p of proposals.values()) {
      if (p.decision === 'accepted') s.accepted++;
      if (p.decision !== 'pending') continue;
      s.proposals++;
      if (p.verification && p.verification.verified && p.status === 'fixed') s.verified++;
    }
    // A simple, explainable score: 100 minus weighted issues per scanned file, floored at 0.
    const weighted = s.critical * 5 + s.warning * 2 + s.advisory;
    s.score = s.files ? Math.max(0, Math.round(100 - (weighted / s.files) * 4)) : null;
    return s;
  }

  return {
    setFile, removeFile, addProposals, decide, shiftAfterEdit, summary,
    getFile: (uri) => files.get(uri),
    listFiles: () => [...files.values()],
    getProposal: (id) => proposals.get(id),
    listProposals: () => [...proposals.values()],
    clear() { files.clear(); proposals.clear(); changed(); },
    onChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }
  };
}

module.exports = { createIssueStore };
