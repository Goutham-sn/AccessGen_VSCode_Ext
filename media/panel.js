// AccessGen panel webview. Renders state posted by the extension; every action is posted back as an intent.
// All text from files and AI replies is inserted with textContent, never as HTML. ASCII only (non-ASCII as \u escapes).
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    tab: saved.tab || 'issues', page: saved.page || 'current', category: saved.category || 'all', filter: saved.filter || '',
    sev: saved.sev || { critical: true, warning: true, advisory: true }, show: saved.show || 'pending', collapsed: saved.collapsed || {}, answers: saved.answers || {}
  };
  let data = null;
  const app = document.getElementById('app');
  const ELLIPSIS = '\u2026';
  const DOT = ' \u00b7 ';
  const SLOT = '{{INPUT}}';
  const SEV = [['critical', 'Critical'], ['warning', 'Warnings'], ['advisory', 'Advisory']];
  const sevName = (s) => (s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Advisory');
  const sevKey = (s) => (s === 'critical' || s === 'warning' ? s : 'advisory');

  const persist = () => vscode.setState(ui);
  const post = (msg) => vscode.postMessage(msg);
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();

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
  // Severity is shown as a shape and a word, never by color alone.
  const sevDot = (s) => el('span', { class: 'sev sev-' + sevKey(s) }, el('span', { class: 'sev-icon', 'aria-hidden': 'true' }), el('span', { class: 'sr-only' }, sevName(s) + ': '));

  // ---------------------------------------------------------------------------------- filtering
  // The page the filters point at: a uri, or null for all pages.
  function currentPage() {
    if (ui.page === 'all') return null;
    if (ui.page === 'current') return data.activeUri || null;
    return ui.page;
  }
  const pageLabel = (uri) => { const f = data.files.find(x => x.uri === uri); return f ? f.relPath : baseName(uri); };
  const pageMatches = (uri) => { const p = currentPage(); return !p || p === uri; };
  const issueMatches = (f, it) => ui.sev[sevKey(it.severity)] && (ui.category === 'all' || it.category === ui.category) &&
    (!ui.filter || (f.relPath + ' ' + it.title + ' ' + it.ruleId + ' ' + it.what + ' ' + it.wcag).toLowerCase().includes(ui.filter.toLowerCase()));

  // ---------------------------------------------------------------------------------- header
  function header() {
    const s = data.summary;
    const tone = s.score === null ? '' : s.score >= 90 ? 'good' : s.score >= 60 ? 'ok' : 'bad';
    const counts = { critical: 0, warning: 0, advisory: 0 };
    for (const f of data.files) if (pageMatches(f.uri)) for (const it of f.issues) counts[sevKey(it.severity)]++;
    return el('section', { class: 'summary', 'aria-label': 'Summary' },
      el('div', { class: 'score ' + tone, role: 'img', 'aria-label': s.score === null ? 'No score yet' : 'Accessibility score ' + s.score + ' out of 100' },
        el('span', { class: 'score-num', 'aria-hidden': 'true' }, s.score === null ? '-' : String(s.score)), el('span', { class: 'score-label', 'aria-hidden': 'true' }, 'score')),
      el('div', { class: 'sev-filters', role: 'group', 'aria-label': 'Show severities' },
        ...SEV.map(([k, label]) => el('button', {
          type: 'button', class: 'chip-toggle sev-' + k, 'aria-pressed': String(!!ui.sev[k]),
          title: (ui.sev[k] ? 'Hide ' : 'Show ') + label.toLowerCase(),
          onclick: () => { ui.sev[k] = !ui.sev[k]; if (!SEV.some(([x]) => ui.sev[x])) ui.sev[k] = true; persist(); render(); }
        }, el('span', { class: 'sev-icon', 'aria-hidden': 'true' }), el('span', { class: 'chip-count' }, String(counts[k])), ' ' + label))));
  }

  function toolbar() {
    const page = currentPage();
    const pageHasIssues = page ? data.files.some(f => f.uri === page && f.issues.length) : data.files.some(f => f.issues.length);
    return el('div', { class: 'toolbar' },
      el('div', { class: 'row', role: 'group', 'aria-label': 'Scan' },
        btn('Scan file', () => post({ type: 'scanFile' }), { title: 'Check the file open in the editor' }),
        btn('Scan files' + ELLIPSIS, () => post({ type: 'scanFiles' }), { title: 'Pick files to check; they open in tabs' }),
        btn('Scan project', () => post({ type: 'scanWorkspace' }), { title: 'Check every HTML, JSX, TSX and CSS file' })),
      el('div', { class: 'row', role: 'group', 'aria-label': 'Fix' },
        page ? btn('Fix this page with AI', () => post({ type: 'fixFile', uri: page }), { kind: 'primary', disabled: !pageHasIssues, title: 'One AI request for every issue on ' + baseName(pageLabel(page)) })
          : btn('Fix all pages with AI', () => post({ type: 'fixAll' }), { kind: 'primary', disabled: !pageHasIssues, title: 'One AI request per page. Issues already answered are not sent again.' }),
        btn('Export report', () => post({ type: 'exportReport' }), { disabled: !data.summary.files })),
      el('div', { class: 'busy', role: 'status', 'aria-live': 'polite' }, busy() ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, data.busy || ''));
  }

  function tabs() {
    const toReview = data.proposals.filter(p => p.decision === 'pending' && p.status !== 'covered' && pageMatches(p.uri)).length;
    const issueCount = data.files.filter(f => pageMatches(f.uri)).reduce((n, f) => n + f.issues.filter(it => issueMatches(f, it)).length, 0);
    const defs = [['issues', 'Issues', issueCount], ['fixes', 'Fixes', toReview], ['settings', 'Settings', null]];
    const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'AccessGen views' });
    defs.forEach(([id, label, n], i) => {
      list.append(el('button', {
        type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel-' + id, 'aria-selected': String(ui.tab === id), tabindex: ui.tab === id ? '0' : '-1', class: 'tab',
        onclick: () => { ui.tab = id; persist(); render(); document.getElementById('tab-' + id).focus(); },
        onkeydown: (e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          const jump = e.key === 'Home' ? 0 : e.key === 'End' ? defs.length - 1 : null;
          if (!dir && jump === null) return;
          e.preventDefault();
          ui.tab = defs[jump !== null ? jump : (i + dir + defs.length) % defs.length][0]; persist(); render(); document.getElementById('tab-' + ui.tab).focus();
        }
      }, label, n !== null ? el('span', { class: 'pill', 'aria-label': '(' + n + ')' }, String(n)) : null));
    });
    return list;
  }

  // Page and category selectors, shared by the Issues and Fixes tabs.
  function pageFilters(withCategory) {
    const pageSel = el('select', { id: 'page', onchange: (e) => { ui.page = e.target.value; persist(); render(); } });
    const activeName = data.activeUri ? baseName(pageLabel(data.activeUri)) : 'none open';
    pageSel.append(el('option', { value: 'current', selected: ui.page === 'current' }, 'Current page (' + activeName + ')'));
    pageSel.append(el('option', { value: 'all', selected: ui.page === 'all' }, 'All pages (' + data.files.filter(f => f.issues.length).length + ')'));
    for (const f of data.files) if (f.issues.length) pageSel.append(el('option', { value: f.uri, selected: ui.page === f.uri }, f.relPath + ' (' + f.issues.length + ')'));
    const row = el('div', { class: 'filters' },
      el('div', { class: 'field-inline' }, el('label', { for: 'page' }, 'Page'), pageSel));
    if (withCategory) {
      const cat = el('select', { id: 'category', onchange: (e) => { ui.category = e.target.value; persist(); render(); } });
      cat.append(el('option', { value: 'all', selected: ui.category === 'all' }, 'All categories'));
      for (const c of data.categories) cat.append(el('option', { value: c, selected: ui.category === c }, c));
      row.append(el('div', { class: 'field-inline' }, el('label', { for: 'category' }, 'Category'), cat),
        el('div', { class: 'field-inline grow' }, el('label', { for: 'filter' }, 'Search'),
          el('input', { id: 'filter', type: 'search', placeholder: 'Problem, rule or file', value: ui.filter, oninput: (e) => { ui.filter = e.target.value; persist(); renderIssueList(); } })));
    }
    return row;
  }

  // ---------------------------------------------------------------------------------- issues
  let issueList = null, issueCountLine = null;
  function issuesView() {
    const wrap = el('div', { role: 'tabpanel', id: 'panel-issues', 'aria-labelledby': 'tab-issues', tabindex: '-1' });
    wrap.append(pageFilters(true));
    issueCountLine = el('p', { class: 'result-count', role: 'status', 'aria-live': 'polite' });
    issueList = el('div', { class: 'list' });
    wrap.append(issueCountLine, issueList);
    renderIssueList();
    return wrap;
  }

  function issueRow(f, it, fixFor) {
    const p = fixFor.get(f.uri + '|' + it.ruleId + '|' + it.line);
    return el('li', { class: 'issue' },
      el('div', { class: 'issue-main' },
        sevDot(it.severity),
        el('div', { class: 'issue-text' },
          el('button', { type: 'button', class: 'link-btn title', onclick: () => post({ type: 'open', uri: f.uri, line: it.line }), title: 'Go to line ' + it.line },
            it.title, el('span', { class: 'sr-only' }, ', line ' + it.line + '. Go to code')),
          el('p', { class: 'muted small' }, it.impact || it.what)),
        el('span', { class: 'line-no', 'aria-hidden': 'true' }, 'L' + it.line),
        p ? btn('Review fix', () => { ui.tab = 'fixes'; ui.focus = p.id; persist(); render(); }, { kind: 'primary small', aria: 'Review fix for ' + it.title + ', line ' + it.line })
          : btn('Fix', () => post({ type: 'fixIssue', uri: f.uri, index: it.index }), { kind: 'small', aria: 'Fix ' + it.title + ', line ' + it.line + ', with AI' })));
  }

  function renderIssueList() {
    if (!issueList) return;
    issueList.textContent = '';
    const fixFor = new Map(data.proposals.filter(p => p.decision === 'pending').map(p => [p.uri + '|' + p.ruleId + '|' + p.line, p]));
    const page = currentPage();
    if (ui.page === 'current' && !data.activeUri) {
      issueCountLine.textContent = '';
      issueList.append(el('div', { class: 'empty' }, el('p', {}, 'Open a file to see its issues, or choose "All pages".'), btn('Show all pages', () => { ui.page = 'all'; persist(); render(); })));
      return;
    }
    if (page && !data.files.some(f => f.uri === page)) {
      issueCountLine.textContent = '';
      issueList.append(el('div', { class: 'empty' }, el('p', {}, baseName(page) + ' has not been scanned yet.'), btn('Scan this file', () => post({ type: 'scanFile' }), { kind: 'primary' })));
      return;
    }
    let total = 0, pages = 0;
    const files = data.files.filter(f => pageMatches(f.uri));
    for (const f of files) {
      const issues = f.issues.filter(it => issueMatches(f, it));
      if (!issues.length) continue;
      total += issues.length; pages++;
      const list = el('ul', { class: 'issues', 'aria-label': f.relPath });
      for (const it of issues) list.append(issueRow(f, it, fixFor));
      if (page) { issueList.append(list); continue; }
      const open = !ui.collapsed[f.uri];
      const headId = 'page-' + pages;
      issueList.append(el('section', { class: 'page', 'aria-labelledby': headId },
        el('div', { class: 'page-head' },
          el('h2', { class: 'page-title', id: headId },
            el('button', { type: 'button', class: 'disclosure', 'aria-expanded': String(open), onclick: () => { ui.collapsed[f.uri] = open; persist(); renderIssueList(); } },
              el('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8'), el('span', { class: 'path' }, f.relPath), el('span', { class: 'pill' }, String(issues.length)))),
          btn('Open', () => post({ type: 'open', uri: f.uri, line: issues[0].line }), { kind: 'small', aria: 'Open ' + f.relPath }),
          btn('Fix page', () => post({ type: 'fixFile', uri: f.uri }), { kind: 'small', aria: 'Fix all issues on ' + f.relPath + ' with AI' })),
        open ? list : null));
    }
    const filtered = ui.category !== 'all' || ui.filter || SEV.some(([k]) => !ui.sev[k]);
    issueCountLine.textContent = total ? total + ' issue' + (total === 1 ? '' : 's') + (page ? ' on this page' : ' on ' + pages + ' page' + (pages === 1 ? '' : 's')) + (filtered ? ' (filtered)' : '') : '';
    if (!total) {
      const scannedClean = page && data.files.some(f => f.uri === page && !f.issues.length);
      issueList.append(el('div', { class: 'empty' },
        el('p', {}, scannedClean ? '\u2713 No issues found on this page.' : filtered ? 'No issues match these filters.' : data.files.length ? 'No issues.' : 'Nothing scanned yet. Scan a file, some files, or the whole project.'),
        filtered ? btn('Clear filters', () => { ui.category = 'all'; ui.filter = ''; ui.sev = { critical: true, warning: true, advisory: true }; persist(); render(); }) : null));
    }
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
    const wrap = el('div', { role: 'tabpanel', id: 'panel-fixes', 'aria-labelledby': 'tab-fixes', tabindex: '-1' });
    wrap.append(pageFilters(false));
    const inScope = data.proposals.filter(p => pageMatches(p.uri) && ui.sev[sevKey(p.severity)]);
    const ready = inScope.filter(p => p.decision === 'pending' && p.status === 'fixed' && !p.hasInput && p.verification && p.verification.verified).length;
    const showSel = el('select', { id: 'show', onchange: (e) => { ui.show = e.target.value; persist(); render(); } });
    for (const [v, l] of [['pending', 'To review'], ['all', 'All, including done']]) showSel.append(el('option', { value: v, selected: ui.show === v }, l));
    wrap.append(el('div', { class: 'filters' },
      el('div', { class: 'field-inline' }, el('label', { for: 'show' }, 'Show'), showSel),
      btn('Apply all ready fixes (' + ready + ')', () => post({ type: 'acceptAllVerified' }), { kind: 'primary', disabled: !ready, title: 'Applies every fix marked Ready. Fixes that need your answer or a review are left for you.' })));
    const list = inScope.filter(p => p.status !== 'covered' && (ui.show === 'all' || p.decision === 'pending'));
    if (!list.length) {
      wrap.append(el('div', { class: 'empty' }, el('p', {}, data.proposals.length ? 'Nothing left to review here.' : 'No fixes yet. Use "Fix" on an issue, or fix a whole page with AI.')));
      return wrap;
    }
    const order = { 'Needs your answer': 0, 'Ready': 1, 'Review carefully': 2 };
    const byFile = new Map();
    for (const p of list) { if (!byFile.has(p.relPath)) byFile.set(p.relPath, []); byFile.get(p.relPath).push(p); }
    for (const [file, items] of byFile) {
      items.sort((a, b) => (order[statusOf(a).text] ?? 3) - (order[statusOf(b).text] ?? 3) || a.line - b.line);
      const section = el('section', { class: 'page', 'aria-label': file });
      section.append(el('h2', { class: currentPage() ? 'sr-only' : 'file-title' }, 'Fixes for ' + file));
      for (const p of items) section.append(fixCard(p));
      wrap.append(section);
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
    app.append(el('h1', { class: 'sr-only' }, 'AccessGen accessibility'), header(), toolbar(), tabs());
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
