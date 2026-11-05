// AccessGen panel webview. Renders state posted by the extension; every action is posted back as an intent.
// All text from files and AI replies is inserted with textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = { tab: saved.tab || 'issues', filter: saved.filter || '', severity: saved.severity || 'all', show: saved.show || 'pending', collapsed: saved.collapsed || {} };
  let data = null;
  const app = document.getElementById('app');

  const persist = () => vscode.setState(ui);
  const post = (msg) => vscode.postMessage(msg);

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const btn = (label, onclick, opts) => el('button', { type: 'button', class: 'btn ' + ((opts && opts.kind) || ''), onclick, title: opts && opts.title, 'aria-label': opts && opts.aria, disabled: (opts && opts.disabled) || (data && data.busy) ? true : null }, label);
  const sevBadge = (s) => el('span', { class: 'sev sev-' + (s || 'advisory') }, s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Advisory');

  function header() {
    const s = data.summary;
    const score = s.score === null ? '\u2013' : s.score;
    const tone = s.score === null ? '' : s.score >= 90 ? 'good' : s.score >= 60 ? 'ok' : 'bad';
    return el('section', { class: 'summary', 'aria-label': 'Summary' },
      el('div', { class: 'score ' + tone, title: 'Accessibility score: 100 minus weighted issues per scanned file' },
        el('span', { class: 'score-num' }, String(score)), el('span', { class: 'score-label' }, 'score')),
      el('dl', { class: 'counts' },
        el('div', {}, el('dt', {}, 'Critical'), el('dd', { class: 'c-critical' }, String(s.critical))),
        el('div', {}, el('dt', {}, 'Warnings'), el('dd', { class: 'c-warning' }, String(s.warning))),
        el('div', {}, el('dt', {}, 'Advisory'), el('dd', {}, String(s.advisory))),
        el('div', {}, el('dt', {}, 'Files'), el('dd', {}, s.filesWithIssues + '/' + s.files)))
    );
  }

  function toolbar() {
    const issueCount = data.files.reduce((n, f) => n + f.issues.length, 0);
    return el('div', { class: 'toolbar' },
      el('div', { class: 'row' },
        btn('Scan file', () => post({ type: 'scanFile' }), { title: 'Scan the active editor' }),
        btn('Scan files\u2026', () => post({ type: 'scanFiles' }), { title: 'Pick one or more files to scan' }),
        btn('Scan project', () => post({ type: 'scanWorkspace' }), { title: 'Scan every HTML, JSX, TSX and CSS file' })),
      el('div', { class: 'row' },
        btn('Fix all with AI', () => post({ type: 'fixAll' }), { kind: 'primary', disabled: !issueCount, title: 'One request per file (large files are split), only new or changed issues are sent' }),
        btn('Export report', () => post({ type: 'exportReport' }), { disabled: !data.summary.files })),
      el('div', { class: 'busy', role: 'status', 'aria-live': 'polite' }, data.busy ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, data.busy || '')
    );
  }

  function tabs() {
    const pendingFixes = data.proposals.filter(p => p.decision === 'pending').length;
    const issueCount = data.files.reduce((n, f) => n + f.issues.length, 0);
    const defs = [['issues', 'Issues', issueCount], ['fixes', 'Fixes', pendingFixes], ['settings', 'Settings', null]];
    const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'AccessGen views' });
    defs.forEach(([id, label, n], i) => {
      const t = el('button', {
        type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel-' + id, 'aria-selected': String(ui.tab === id), tabindex: ui.tab === id ? '0' : '-1', class: 'tab',
        onclick: () => { ui.tab = id; persist(); render(); document.getElementById('tab-' + id).focus(); },
        onkeydown: (e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          ui.tab = defs[(i + dir + defs.length) % defs.length][0]; persist(); render(); document.getElementById('tab-' + ui.tab).focus();
        }
      }, label, n !== null ? el('span', { class: 'pill' }, String(n)) : null);
      list.append(t);
    });
    return list;
  }

  function issuesView() {
    const wrap = el('div', { role: 'tabpanel', id: 'panel-issues', 'aria-labelledby': 'tab-issues' });
    const q = ui.filter.toLowerCase();
    wrap.append(el('div', { class: 'filters' },
      el('label', { class: 'sr-only', for: 'filter' }, 'Filter issues'),
      el('input', { id: 'filter', type: 'search', placeholder: 'Filter by rule, file or text', value: ui.filter, oninput: (e) => { ui.filter = e.target.value; persist(); renderList(); } }),
      el('label', { class: 'sr-only', for: 'sev' }, 'Severity'),
      (() => {
        const s = el('select', { id: 'sev', onchange: (e) => { ui.severity = e.target.value; persist(); renderList(); } });
        for (const [v, l] of [['all', 'All severities'], ['critical', 'Critical'], ['warning', 'Warning'], ['advisory', 'Advisory']]) s.append(el('option', { value: v, selected: ui.severity === v }, l));
        return s;
      })()));
    const list = el('div', { class: 'list' });
    wrap.append(list);

    function renderList() {
      list.textContent = '';
      const query = ui.filter.toLowerCase();
      const proposalFor = new Map(data.proposals.filter(p => p.decision === 'pending').map(p => [p.uri + '|' + p.ruleId + '|' + p.line, p]));
      let shown = 0;
      for (const f of data.files) {
        const issues = f.issues.filter(it => (ui.severity === 'all' || it.severity === ui.severity || (ui.severity === 'advisory' && it.severity !== 'critical' && it.severity !== 'warning')) &&
          (!query || (f.relPath + ' ' + it.ruleId + ' ' + it.what + ' ' + it.wcag).toLowerCase().includes(query)));
        if (!issues.length) continue;
        shown += issues.length;
        const open = !ui.collapsed[f.uri];
        const body = el('ul', { class: 'issues', hidden: !open });
        for (const it of issues) {
          const p = proposalFor.get(f.uri + '|' + it.ruleId + '|' + it.line);
          body.append(el('li', { class: 'issue' },
            el('div', { class: 'issue-head' }, sevBadge(it.severity), el('code', { class: 'rule' }, it.ruleId), el('span', { class: 'muted' }, 'line ' + it.line)),
            el('p', { class: 'what' }, it.what),
            el('p', { class: 'wcag muted' }, it.wcag),
            el('div', { class: 'row' },
              btn('Go to', () => post({ type: 'open', uri: f.uri, line: it.line }), { aria: 'Go to ' + it.ruleId + ' at line ' + it.line }),
              p ? btn('View fix', () => { ui.tab = 'fixes'; ui.focus = p.id; persist(); render(); }, { kind: 'primary' })
                : btn('Fix with AI', () => post({ type: 'fixIssue', uri: f.uri, index: it.index }), { aria: 'Fix ' + it.ruleId + ' at line ' + it.line + ' with AI' }))));
        }
        list.append(el('section', { class: 'file' },
          el('div', { class: 'file-head' },
            el('button', { type: 'button', class: 'disclosure', 'aria-expanded': String(open), onclick: () => { ui.collapsed[f.uri] = open; persist(); renderList(); } },
              el('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8'), el('span', { class: 'path' }, f.relPath), el('span', { class: 'pill' }, String(issues.length))),
            btn('Fix file', () => post({ type: 'fixFile', uri: f.uri }), { title: 'Fix every issue in this file with one AI request', aria: 'Fix all issues in ' + f.relPath + ' with AI' })),
          body));
      }
      if (!shown) list.append(el('p', { class: 'empty' }, data.files.length ? 'No issues match the filter.' : 'No issues yet. Scan a file, a selection or the whole project.'));
    }
    renderList();
    return wrap;
  }

  function statusOf(p) {
    if (p.decision !== 'pending') return { cls: 'st-done', text: { accepted: 'Applied', rejected: 'Dismissed', stale: 'Out of date' }[p.decision] || p.decision };
    if (p.status === 'error') return { cls: 'st-bad', text: 'Failed' };
    if (p.status === 'false-positive') return { cls: 'st-info', text: 'Likely false positive' };
    if (p.status === 'cannot-fix') return { cls: 'st-info', text: 'Needs a manual fix' };
    if (p.status === 'covered') return { cls: 'st-info', text: 'Fixed together with another issue' };
    if (p.status === 'needs-input') return { cls: 'st-warn', text: 'Needs your input' };
    if (p.verification && p.verification.verified) return { cls: 'st-good', text: 'Verified' };
    return { cls: 'st-warn', text: 'Not verified' };
  }

  function fixesView() {
    const wrap = el('div', { role: 'tabpanel', id: 'panel-fixes', 'aria-labelledby': 'tab-fixes' });
    const verified = data.proposals.filter(p => p.decision === 'pending' && p.status === 'fixed' && p.verification && p.verification.verified).length;
    const showSel = el('select', { id: 'show', onchange: (e) => { ui.show = e.target.value; persist(); render(); } });
    for (const [v, l] of [['pending', 'Pending'], ['all', 'All this session']]) showSel.append(el('option', { value: v, selected: ui.show === v }, l));
    wrap.append(el('div', { class: 'filters' },
      el('label', { class: 'sr-only', for: 'show' }, 'Show'), showSel,
      btn('Accept all verified (' + verified + ')', () => post({ type: 'acceptAllVerified' }), { kind: 'primary', disabled: !verified, title: 'Apply every fix that passed all local checks and needs no input' })));
    const list = data.proposals.filter(p => ui.show === 'all' || p.decision === 'pending');
    if (!list.length) wrap.append(el('p', { class: 'empty' }, 'No fixes yet. Use \u201cFix with AI\u201d on an issue, a file, or everything.'));
    for (const p of list) {
      const st = statusOf(p);
      const v = p.verification;
      const checks = v ? el('ul', { class: 'checks', 'aria-label': 'Local checks' },
        el('li', { class: v.verified ? 'ok' : 'no' }, v.verified ? 'Applies cleanly, still parses, resolves the issue, adds no new issues' : (v.reason || 'Did not pass the local checks'))) : null;
      const diff = p.diff && p.diff.length ? el('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Proposed change' }, ...p.diff.map(d => el('span', { class: 'd d' + (d.t === '-' ? 'del' : d.t === '+' ? 'add' : d.t === '@' ? 'at' : 'ctx') }, (d.t === '@' ? '' : d.t + ' ') + d.s + '\n'))) : null;
      const card = el('article', { class: 'card ' + (p.decision !== 'pending' ? 'decided' : ''), id: 'fix-' + p.id, tabindex: '-1' },
        el('div', { class: 'issue-head' }, sevBadge(p.severity), el('code', { class: 'rule' }, p.ruleId), el('span', { class: 'status ' + st.cls }, st.text),
          p.source === 'ai' && p.status !== 'error' ? el('span', { class: 'muted', title: 'Model confidence' }, Math.round((p.confidence || 0) * 100) + '%') : el('span', { class: 'muted' }, p.source === 'deterministic' ? 'computed' : '')),
        el('p', { class: 'muted loc' }, p.relPath + ':' + p.line),
        p.summary ? el('p', {}, p.summary) : null,
        p.needsInput ? el('p', { class: 'needs' }, el('strong', {}, 'Your input: '), p.needsInput) : null,
        p.steps.length ? el('ol', { class: 'steps' }, ...p.steps.map(s => el('li', {}, s))) : null,
        checks,
        diff,
        p.testing ? el('p', { class: 'muted' }, el('strong', {}, 'How to test: '), p.testing) : null,
        p.decision === 'pending' ? el('div', { class: 'row' },
          p.diff && p.diff.length ? btn('Accept', () => post({ type: 'accept', id: p.id }), { kind: 'primary', aria: 'Accept fix for ' + p.ruleId + ' at line ' + p.line }) : null,
          p.diff && p.diff.length ? btn('Preview diff', () => post({ type: 'preview', id: p.id })) : null,
          btn(p.diff && p.diff.length ? 'Reject' : 'Dismiss', () => post({ type: 'reject', id: p.id }), { aria: 'Reject fix for ' + p.ruleId + ' at line ' + p.line }),
          btn('Go to', () => post({ type: 'open', uri: p.uri, line: p.line }))) : null);
      wrap.append(card);
    }
    return wrap;
  }

  function settingsView() {
    const s = data.settings;
    const wrap = el('div', { role: 'tabpanel', id: 'panel-settings', 'aria-labelledby': 'tab-settings', class: 'settings' });
    const select = (key, label, options, help) => {
      const id = 'set-' + key;
      const sel = el('select', { id, onchange: (e) => post({ type: 'setting', key, value: e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value }) });
      for (const [v, l] of options) sel.append(el('option', { value: String(v), selected: String(s[key]) === String(v) }, l));
      return el('div', { class: 'field' }, el('label', { for: id }, label), sel, help ? el('p', { class: 'help' }, help) : null);
    };
    const text = (key, label, placeholder, help) => {
      const id = 'set-' + key;
      return el('div', { class: 'field' }, el('label', { for: id }, label),
        el('input', { id, type: 'text', value: s[key] || '', placeholder, onchange: (e) => post({ type: 'setting', key, value: e.target.value }) }),
        help ? el('p', { class: 'help' }, help) : null);
    };
    wrap.append(
      el('h2', {}, 'Remediation'),
      select('remediationMode', 'Remediation mode', [['manual', 'Manual: fixes only when you ask'], ['hybrid', 'Hybrid: computed fixes proposed automatically, AI on request'], ['auto', 'Auto: computed and AI fixes proposed automatically']], 'Nothing is ever applied without your Accept, in any mode.'),
      select('aiRemediationStrategy', 'AI request strategy', [['batch', 'Batch: all issues of a file in one request'], ['per-issue', 'Per issue: one request per issue']], 'Batch is cheaper and more accurate: the model sees every issue of the file together.'),
      el('h2', {}, 'AI'),
      select('aiReviewMode', 'AI features', [['off', 'Off: nothing is sent'], ['manual', 'On request'], ['auto', 'On request + automatic review']]),
      select('aiProvider', 'Provider', [['openai', 'OpenAI'], ['anthropic', 'Anthropic']]),
      text('aiRemediationModel', 'Model for fixes', s.remediationModelEffective, 'Empty uses ' + s.remediationModelEffective + '.'),
      text('aiModel', 'Model for review and single quick fixes', 'provider default'),
      select('aiSendImages', 'Send local images for alt text', [[true, 'Yes: the model looks at the image'], [false, 'No: describe from text evidence only']]),
      el('div', { class: 'row' }, btn('Set API key\u2026', () => post({ type: 'setKey' }))),
      el('h2', {}, 'Rules'),
      select('complianceLevel', 'WCAG level', [['A', 'A'], ['AA', 'AA (default)'], ['AAA', 'AAA']]),
      el('p', { class: 'help' }, 'A value in accessgen.config.json overrides these settings for this project. Suppress a single finding with a comment: accessgen-disable-next-line <rule-id>.')
    );
    return wrap;
  }

  function render() {
    if (!data) { app.textContent = ''; app.append(el('p', { class: 'empty' }, 'Loading\u2026')); return; }
    const active = document.activeElement && document.activeElement.id;
    app.textContent = '';
    app.append(header(), toolbar(), tabs());
    app.append(ui.tab === 'fixes' ? fixesView() : ui.tab === 'settings' ? settingsView() : issuesView());
    if (ui.focus) {
      const card = document.getElementById('fix-' + ui.focus);
      ui.focus = null;
      if (card) { card.scrollIntoView({ block: 'center' }); card.focus(); }
    } else if (active && document.getElementById(active)) {
      document.getElementById(active).focus();
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'state') { data = m.data; render(); }
  });
  render();
  post({ type: 'ready' });
})();
