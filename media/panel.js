// AccessGen panel webview. Renders state posted by the extension; every action is posted back as an intent.
// All text from files and AI replies is inserted with textContent, never as HTML. ASCII only (non-ASCII as \u escapes).
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = { tab: saved.tab || 'issues', filter: saved.filter || '', severity: saved.severity || 'all', show: saved.show || 'pending', collapsed: saved.collapsed || {}, answers: saved.answers || {} };
  let data = null;
  const app = document.getElementById('app');
  const ELLIPSIS = '\u2026';
  const SLOT = '{{INPUT}}';

  const persist = () => vscode.setState(ui);
  const post = (msg) => vscode.postMessage(msg);

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const busy = () => !!(data && data.busy);
  const btn = (label, onclick, opts) => el('button', {
    type: 'button', class: 'btn ' + ((opts && opts.kind) || ''), onclick, title: opts && opts.title, 'aria-label': opts && opts.aria,
    disabled: (opts && opts.disabled) || busy() ? true : null
  }, label);
  const sevDot = (s) => el('span', { class: 'dot dot-' + (s || 'advisory'), title: s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Advisory', 'aria-label': s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Advisory', role: 'img' });

  // ---------------------------------------------------------------------------------- header + toolbar
  function header() {
    const s = data.summary;
    const score = s.score === null ? '-' : s.score;
    const tone = s.score === null ? '' : s.score >= 90 ? 'good' : s.score >= 60 ? 'ok' : 'bad';
    return el('section', { class: 'summary', 'aria-label': 'Summary' },
      el('div', { class: 'score ' + tone, title: 'Accessibility score: 100 minus weighted issues per scanned file' },
        el('span', { class: 'score-num' }, String(score)), el('span', { class: 'score-label' }, 'score')),
      el('dl', { class: 'counts' },
        el('div', {}, el('dt', {}, 'Critical'), el('dd', { class: 'c-critical' }, String(s.critical))),
        el('div', {}, el('dt', {}, 'Warnings'), el('dd', { class: 'c-warning' }, String(s.warning))),
        el('div', {}, el('dt', {}, 'Advisory'), el('dd', {}, String(s.advisory))),
        el('div', {}, el('dt', {}, 'Files'), el('dd', {}, s.filesWithIssues + '/' + s.files))));
  }

  function toolbar() {
    const issueCount = data.files.reduce((n, f) => n + f.issues.length, 0);
    return el('div', { class: 'toolbar' },
      el('div', { class: 'row' },
        btn('Scan file', () => post({ type: 'scanFile' }), { title: 'Check the file open in the editor' }),
        btn('Scan files' + ELLIPSIS, () => post({ type: 'scanFiles' }), { title: 'Pick one or more files to check' }),
        btn('Scan project', () => post({ type: 'scanWorkspace' }), { title: 'Check every HTML, JSX, TSX and CSS file' })),
      el('div', { class: 'row' },
        btn('Fix all with AI', () => post({ type: 'fixAll' }), { kind: 'primary', disabled: !issueCount, title: 'One AI request per file. Issues already answered are not sent again.' }),
        btn('Export report', () => post({ type: 'exportReport' }), { disabled: !data.summary.files })),
      el('div', { class: 'busy', role: 'status', 'aria-live': 'polite' }, busy() ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, data.busy || ''));
  }

  function tabs() {
    const toReview = data.proposals.filter(p => p.decision === 'pending' && p.status !== 'covered').length;
    const issueCount = data.files.reduce((n, f) => n + f.issues.length, 0);
    const defs = [['issues', 'Issues', issueCount], ['fixes', 'Fixes', toReview], ['settings', 'Settings', null]];
    const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'AccessGen views' });
    defs.forEach(([id, label, n], i) => {
      list.append(el('button', {
        type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel-' + id, 'aria-selected': String(ui.tab === id), tabindex: ui.tab === id ? '0' : '-1', class: 'tab',
        onclick: () => { ui.tab = id; persist(); render(); document.getElementById('tab-' + id).focus(); },
        onkeydown: (e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          ui.tab = defs[(i + dir + defs.length) % defs.length][0]; persist(); render(); document.getElementById('tab-' + ui.tab).focus();
        }
      }, label, n !== null ? el('span', { class: 'pill' }, String(n)) : null));
    });
    return list;
  }

  // ---------------------------------------------------------------------------------- issues
  function issuesView() {
    const wrap = el('div', { role: 'tabpanel', id: 'panel-issues', 'aria-labelledby': 'tab-issues' });
    const sev = el('select', { id: 'sev', onchange: (e) => { ui.severity = e.target.value; persist(); renderList(); } });
    for (const [v, l] of [['all', 'All severities'], ['critical', 'Critical'], ['warning', 'Warnings'], ['advisory', 'Advisory']]) sev.append(el('option', { value: v, selected: ui.severity === v }, l));
    wrap.append(el('div', { class: 'filters' },
      el('label', { class: 'sr-only', for: 'filter' }, 'Filter issues'),
      el('input', { id: 'filter', type: 'search', placeholder: 'Filter by file or problem', value: ui.filter, oninput: (e) => { ui.filter = e.target.value; persist(); renderList(); } }),
      el('label', { class: 'sr-only', for: 'sev' }, 'Severity'), sev));
    const list = el('div', { class: 'list' });
    wrap.append(list);

    function renderList() {
      list.textContent = '';
      const q = ui.filter.toLowerCase();
      const fixFor = new Map(data.proposals.filter(p => p.decision === 'pending').map(p => [p.uri + '|' + p.ruleId + '|' + p.line, p]));
      let shown = 0;
      for (const f of data.files) {
        const issues = f.issues.filter(it => (ui.severity === 'all' || it.severity === ui.severity || (ui.severity === 'advisory' && it.severity !== 'critical' && it.severity !== 'warning')) &&
          (!q || (f.relPath + ' ' + it.title + ' ' + it.ruleId + ' ' + it.what).toLowerCase().includes(q)));
        if (!issues.length) continue;
        shown += issues.length;
        const open = !ui.collapsed[f.uri];
        const body = el('ul', { class: 'issues', hidden: !open });
        for (const it of issues) {
          const p = fixFor.get(f.uri + '|' + it.ruleId + '|' + it.line);
          body.append(el('li', { class: 'issue' },
            el('div', { class: 'title-row' }, sevDot(it.severity), el('span', { class: 'title' }, it.title), el('span', { class: 'muted nowrap' }, 'line ' + it.line)),
            el('p', { class: 'muted small' }, it.impact || it.what),
            el('div', { class: 'row' },
              btn('Go to', () => post({ type: 'open', uri: f.uri, line: it.line }), { aria: 'Go to ' + it.title + ', line ' + it.line }),
              p ? btn('See the fix', () => { ui.tab = 'fixes'; ui.focus = p.id; persist(); render(); }, { kind: 'primary' })
                : btn('Fix with AI', () => post({ type: 'fixIssue', uri: f.uri, index: it.index }), { aria: 'Fix ' + it.title + ' at line ' + it.line + ' with AI' }))));
        }
        list.append(el('section', { class: 'file' },
          el('div', { class: 'file-head' },
            el('button', { type: 'button', class: 'disclosure', 'aria-expanded': String(open), onclick: () => { ui.collapsed[f.uri] = open; persist(); renderList(); } },
              el('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8'), el('span', { class: 'path' }, f.relPath), el('span', { class: 'pill' }, String(issues.length))),
            btn('Fix file', () => post({ type: 'fixFile', uri: f.uri }), { title: 'Fix every issue in this file with one AI request', aria: 'Fix all issues in ' + f.relPath + ' with AI' })),
          body));
      }
      if (!shown) list.append(el('p', { class: 'empty' }, data.files.length ? 'No issues match the filter.' : 'No issues yet. Scan a file, some files, or the whole project.'));
    }
    renderList();
    return wrap;
  }

  // ---------------------------------------------------------------------------------- fixes
  function statusOf(p) {
    if (p.decision === 'accepted') return { cls: 'st-done', text: 'Applied' };
    if (p.decision === 'rejected') return { cls: 'st-done', text: 'Skipped' };
    if (p.decision === 'stale') return { cls: 'st-done', text: 'Out of date: the code changed' };
    if (p.status === 'error') return { cls: 'st-bad', text: 'AI request failed' };
    if (p.status === 'false-positive') return { cls: 'st-info', text: 'Probably not a problem' };
    if (p.status === 'cannot-fix') return { cls: 'st-info', text: 'Fix by hand' };
    if (p.status === 'covered') return { cls: 'st-info', text: 'Fixed by another change' };
    if (p.hasInput) return { cls: 'st-warn', text: 'Needs your answer' };
    if (p.verification && p.verification.verified) return { cls: 'st-good', text: 'Ready' };
    return { cls: 'st-warn', text: 'Review carefully' };
  }

  // Common prefix / suffix of two lines, so only the part that changes is highlighted.
  function splitChange(a, b) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    return { pre: a.slice(0, s), oldMid: a.slice(s, a.length - e), newMid: b.slice(s, b.length - e), post: a.slice(a.length - e) };
  }

  // The "what changes" block: per hunk, the after-line with the added part highlighted, and the before-line only when
  // something is removed. Slots show the developer's answer as they type.
  function changeView(p, answer) {
    const box = el('div', { class: 'change', role: 'group', 'aria-label': 'What changes' });
    const hunks = [];
    let cur = null;
    for (const d of p.diff || []) {
      if (d.t === '@') { cur = { label: d.s, del: [], add: [] }; hunks.push(cur); }
      else if (cur && d.t === '-') cur.del.push(d.s);
      else if (cur && d.t === '+') cur.add.push(d.s);
    }
    const fill = (s) => s.split(SLOT).join(answer || ELLIPSIS);
    for (const h of hunks) {
      const del = h.del, add = h.add.map(fill);
      const indent = Math.min(...[...del, ...add].filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length), 1e9);
      const strip = (l) => (indent < 1e9 ? l.slice(indent) : l);
      if (hunks.length > 1) box.append(el('div', { class: 'hunk-label' }, h.label));
      // Line-level alignment: unchanged lines are plain context; a removed line directly followed by an added one is a
      // modified line, shown with only its changed part highlighted.
      const ops = lineDiff(del.map(strip), add.map(strip));
      const rows = [];
      for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        if (o.t === '=') rows.push({ cls: 'ctx', tag: '', code: [o.s] });
        else if (o.t === '-' && ops[i + 1] && ops[i + 1].t === '+') {
          const c = splitChange(o.s, ops[i + 1].s);
          if (c.oldMid) rows.push({ cls: 'before', tag: 'before', code: [c.pre, el('del', {}, c.oldMid), c.post] });
          rows.push({ cls: 'after', tag: c.oldMid ? 'after' : '', code: [c.pre, el('ins', {}, c.newMid), c.post] });
          i++;
        } else if (o.t === '-') rows.push({ cls: 'before', tag: 'removed', code: [el('del', {}, o.s)] });
        else rows.push({ cls: 'after', tag: 'added', code: [el('ins', {}, o.s)] });
      }
      const tagged = rows.some(r => r.tag);
      for (const r of rows) box.append(el('div', { class: 'line ' + r.cls }, tagged ? el('span', { class: 'tag', 'aria-hidden': 'true' }, r.tag) : null, el('code', {}, ...r.code)));
    }
    return box;
  }

  // Minimal line diff (LCS); fixes touch a few lines, so the quadratic table is tiny.
  function lineDiff(a, b) {
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { out.push({ t: '=', s: a[i] }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
        // Prefer pairing a removal with the next addition (a modified line) when both are pending.
        if (i < n && L[i + 1][j] === L[i][j + 1]) { out.push({ t: '-', s: a[i++] }); }
        else out.push({ t: '+', s: b[j++] });
      } else out.push({ t: '-', s: a[i++] });
    }
    return out;
  }

  function fixCard(p) {
    const st = statusOf(p);
    const pending = p.decision === 'pending';
    const hasChange = p.diff && p.diff.length > 0;
    const answer = ui.answers[p.id] !== undefined ? ui.answers[p.id] : '';
    const card = el('article', { class: 'card ' + (pending ? '' : 'decided'), id: 'fix-' + p.id, tabindex: '-1', 'aria-labelledby': 'fix-title-' + p.id });
    card.append(
      el('div', { class: 'title-row' }, sevDot(p.severity), el('h3', { class: 'title', id: 'fix-title-' + p.id }, p.title), el('span', { class: 'status ' + st.cls }, st.text)),
      el('p', { class: 'muted small' }, 'line ' + p.line + (p.impact ? ' \u00b7 ' + p.impact : '')));
    if (p.summary) card.append(el('p', { class: 'summary-text' }, p.summary));

    let changeBox = null;
    if (pending && p.hasInput) {
      const inputId = 'answer-' + p.id;
      const input = el('input', { id: inputId, type: 'text', class: 'answer', value: answer, placeholder: p.suggestions[0] ? 'e.g. ' + p.suggestions[0] : 'Type the text', autocomplete: 'off' });
      const apply = btn('Apply fix', () => post({ type: 'accept', id: p.id, value: ui.answers[p.id] || '' }), { kind: 'primary', disabled: !answer.trim() });
      const refresh = () => {
        ui.answers[p.id] = input.value; persist();
        apply.disabled = !input.value.trim() || busy();
        if (changeBox) { const next = changeView(p, input.value.trim()); changeBox.replaceWith(next); changeBox = next; }
      };
      input.addEventListener('input', refresh);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) post({ type: 'accept', id: p.id, value: input.value }); });
      card.append(el('div', { class: 'question' },
        el('label', { for: inputId }, p.needsInput || 'What text should be used here?'),
        input,
        p.suggestions.length ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Suggested answers' },
          ...p.suggestions.map(s => el('button', { type: 'button', class: 'chip', onclick: () => { input.value = s; refresh(); input.focus(); } }, s))) : null));
      if (hasChange) { card.append(el('h4', { class: 'sub' }, 'What changes')); changeBox = changeView(p, answer.trim()); card.append(changeBox); }
      card.append(el('div', { class: 'row actions' }, apply,
        btn('Show in editor', () => post({ type: 'preview', id: p.id, value: ui.answers[p.id] || '' }), { title: 'Open a side-by-side preview of the whole file' }),
        btn('Skip', () => post({ type: 'reject', id: p.id }), { aria: 'Skip this fix' })));
    } else {
      if (hasChange && pending) { card.append(el('h4', { class: 'sub' }, 'What changes')); card.append(changeView(p, '')); }
      const v = p.verification;
      if (pending && hasChange && v) {
        card.append(el('p', { class: 'check ' + (v.verified ? 'ok' : 'no') },
          v.verified ? '\u2713 Checked: applies cleanly and fixes the issue without creating new ones.' : '! AccessGen could not confirm this fix: ' + (v.reason || 'it did not pass the checks') + '.'));
      }
      if (pending) {
        const actions = el('div', { class: 'row actions' });
        if (hasChange) actions.append(btn('Apply fix', () => post({ type: 'accept', id: p.id }), { kind: 'primary', aria: 'Apply fix: ' + p.title + ', line ' + p.line }),
          btn('Show in editor', () => post({ type: 'preview', id: p.id }), { title: 'Open a side-by-side preview of the whole file' }));
        else actions.append(btn('Go to code', () => post({ type: 'open', uri: p.uri, line: p.line }), { kind: 'primary' }));
        actions.append(btn(hasChange ? 'Skip' : 'Dismiss', () => post({ type: 'reject', id: p.id }), { aria: (hasChange ? 'Skip' : 'Dismiss') + ': ' + p.title }));
        card.append(actions);
      }
    }

    const details = [];
    if (p.steps.length) details.push(el('div', {}, el('h4', { class: 'sub' }, 'Also check'), el('ul', { class: 'steps' }, ...p.steps.map(s => el('li', {}, s)))));
    if (p.testing) details.push(el('div', {}, el('h4', { class: 'sub' }, 'How to test'), el('p', {}, p.testing)));
    details.push(el('p', { class: 'muted small' }, 'Rule ' + p.ruleId + (p.wcag ? ' \u00b7 ' + p.wcag : '') +
      (p.source === 'deterministic' ? ' \u00b7 computed fix' : p.status !== 'error' ? ' \u00b7 AI confidence ' + Math.round((p.confidence || 0) * 100) + '%' : '')));
    card.append(el('details', { class: 'more' }, el('summary', {}, 'Details'), ...details));
    return card;
  }

  function fixesView() {
    const wrap = el('div', { role: 'tabpanel', id: 'panel-fixes', 'aria-labelledby': 'tab-fixes' });
    const ready = data.proposals.filter(p => p.decision === 'pending' && p.status === 'fixed' && !p.hasInput && p.verification && p.verification.verified).length;
    const showSel = el('select', { id: 'show', onchange: (e) => { ui.show = e.target.value; persist(); render(); } });
    for (const [v, l] of [['pending', 'To review'], ['all', 'All, including done']]) showSel.append(el('option', { value: v, selected: ui.show === v }, l));
    wrap.append(el('div', { class: 'filters' },
      el('label', { class: 'sr-only', for: 'show' }, 'Show'), showSel,
      btn('Apply all ready fixes (' + ready + ')', () => post({ type: 'acceptAllVerified' }), { kind: 'primary', disabled: !ready, title: 'Applies every fix marked Ready. Fixes that need your answer or a review are left for you.' })));
    const list = data.proposals.filter(p => p.status !== 'covered' && (ui.show === 'all' || p.decision === 'pending'));
    if (!list.length) {
      wrap.append(el('p', { class: 'empty' }, data.proposals.length ? 'Nothing left to review.' : 'No fixes yet. Use "Fix with AI" on an issue or a file, or "Fix all with AI".'));
      return wrap;
    }
    const order = { 'Needs your answer': 0, 'Ready': 1, 'Review carefully': 2 };
    const byFile = new Map();
    for (const p of list) { if (!byFile.has(p.relPath)) byFile.set(p.relPath, []); byFile.get(p.relPath).push(p); }
    for (const [file, items] of byFile) {
      items.sort((a, b) => (order[statusOf(a).text] ?? 3) - (order[statusOf(b).text] ?? 3) || a.line - b.line);
      wrap.append(el('h2', { class: 'file-title' }, file));
      for (const p of items) wrap.append(fixCard(p));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------------- settings
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
      el('h2', {}, 'Fixing'),
      select('remediationMode', 'When to suggest fixes', [['manual', 'Only when I ask'], ['hybrid', 'Suggest simple fixes automatically, AI fixes when I ask'], ['auto', 'Suggest all fixes automatically, including AI']], 'Nothing is ever changed until you click Apply.'),
      select('aiRemediationStrategy', 'How to ask the AI', [['batch', 'One request per file (recommended)'], ['per-issue', 'One request per issue']], 'One request per file is cheaper and more accurate: the AI sees all issues of the file together.'),
      el('h2', {}, 'AI'),
      select('aiReviewMode', 'AI features', [['off', 'Off: nothing is sent'], ['manual', 'On when I ask'], ['auto', 'On, and review text automatically']]),
      select('aiProvider', 'Provider', [['openai', 'OpenAI'], ['anthropic', 'Anthropic']]),
      text('aiRemediationModel', 'Model for fixes', s.remediationModelEffective, 'Leave empty to use ' + s.remediationModelEffective + '.'),
      text('aiModel', 'Model for text review and single quick fixes', 'provider default'),
      select('aiSendImages', 'Let the AI see local images when writing alt text', [[true, 'Yes'], [false, 'No: describe from the code only']]),
      el('div', { class: 'row' }, btn('Set API key' + ELLIPSIS, () => post({ type: 'setKey' }))),
      el('h2', {}, 'Checks'),
      select('complianceLevel', 'WCAG level', [['A', 'A'], ['AA', 'AA (recommended)'], ['AAA', 'AAA']]),
      el('p', { class: 'help' }, 'Values in accessgen.config.json override these settings for this project. To silence one finding, add a comment above it: accessgen-disable-next-line <rule-id>.'));
    return wrap;
  }

  // ---------------------------------------------------------------------------------- render
  function render() {
    if (!data) { app.textContent = ''; app.append(el('p', { class: 'empty' }, 'Loading' + ELLIPSIS)); return; }
    const active = document.activeElement && document.activeElement.id;
    const caret = active && document.activeElement.selectionStart;
    app.textContent = '';
    app.append(header(), toolbar(), tabs());
    app.append(ui.tab === 'fixes' ? fixesView() : ui.tab === 'settings' ? settingsView() : issuesView());
    if (ui.focus) {
      const card = document.getElementById('fix-' + ui.focus);
      ui.focus = null;
      if (card) { card.scrollIntoView({ block: 'center' }); card.focus(); }
    } else if (active && document.getElementById(active)) {
      const n = document.getElementById(active);
      n.focus();
      if (typeof caret === 'number' && n.setSelectionRange) { try { n.setSelectionRange(caret, caret); } catch (e) { /* not a text field */ } }
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'state') { data = m.data; render(); }
  });
  render();
  post({ type: 'ready' });
})();
