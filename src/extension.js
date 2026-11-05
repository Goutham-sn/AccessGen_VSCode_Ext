const vscode = require('vscode');

// Persistently log to a file so we can debug Extension Host startup issues even when VS Code Output is empty.
function writeDebugLine(line) {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const stamp = new Date().toISOString();
    const tmpLogPath = path.join(os.tmpdir(), 'accessgen-debug.log');
    fs.appendFileSync(tmpLogPath, `${stamp} ${line}\n`, 'utf8');

    // Also best-effort write to workspace root for convenience.
    try {
      const root = (vscode.workspace && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri)
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : null;
      if (root) {
        fs.appendFileSync(path.join(root, 'accessgen-debug.log'), `${stamp} ${line}\n`, 'utf8');
      }
    } catch (e2) {
      // ignore nested write failure
    }
  } catch (e) {
    // ignore
  }
}

writeDebugLine('module: extension.js loaded');
console.log('AccessGen: module loaded');

function safeRequire(modulePath, exportName) {
  try {
    return require(modulePath);
  } catch (e) {
    writeDebugLine('require failed: ' + modulePath + ' err=' + (e && e.message ? e.message : String(e)));
    throw e;
  }
}

const { getConfig, reloadConfig, isRuleDisabled, isTrustedComponent } = safeRequire('./config');
const { analyzeDocument } = safeRequire('./analyzer');
const { applyHighlights, clearHighlights, disposeDecorations } = safeRequire('./highlighter');
const { init: initDiagnostics, updateDiagnostics, clearDiagnostics, disposeAll: disposeDiagnostics, registerHoverProvider } = safeRequire('./diagnostics');
const { registerCodeActions } = safeRequire('./codeActions');
const { createStatusBar, updateStatusBar, showToggleNotification } = safeRequire('./statusBar');
// Held as a module object (not destructured) so callers resolve the functions at call time.
const aiReview = safeRequire('./judgment/aiReview');
const { createAutoFixer } = safeRequire('./remediation/autoFix');
const { createInlineDiff } = safeRequire('./remediation/inlineDiff');
const providers = safeRequire('./judgment/providers');
const { secretKeyFor, PROVIDERS, getApiKey, providerName, resolveModel } = providers;
const { createAiFixer } = safeRequire('./judgment/aiFixer');
const disclosure = safeRequire('./judgment/disclosure');
const { createRemediationEngine, matchKeysFor } = safeRequire('./remediation/batch/engine');
const { createIssueStore } = safeRequire('./panel/issueStore');
const { createFixController } = safeRequire('./panel/fixController');
const { createPanelProvider } = safeRequire('./panel/panelProvider');
const workspaceScan = safeRequire('./workspaceScan');
const { buildReport } = safeRequire('./report');

let debounceTimer = null;
let statusBarItem = null;
let enabled = true;
let lastIssueCount = 0;
let aiChannel = null;
let autoFixChannel = null;
const warnedNoKey = new Set(); // providers we've already told the user about (auto mode nags once)
const aiTimers = new Map();    // filePath -> pending auto-review timer (see scheduleAutoReview)
const aiFixTimers = new Map(); // filePath -> pending proactive AI-fix timer (see scheduleAiFix)
const batchTimers = new Map(); // filePath -> pending proactive batch-remediation timer (see scheduleBatchFix)
let inlineDiffRef = null;      // the inline-diff instance of this activation (disposed in deactivate)

function cancelPendingAiFixes() {
  for (const t of aiFixTimers.values()) clearTimeout(t);
  aiFixTimers.clear();
  for (const t of batchTimers.values()) clearTimeout(t);
  batchTimers.clear();
}

function cancelPendingAiReviews() {
  for (const t of aiTimers.values()) clearTimeout(t);
  aiTimers.clear();
  cancelPendingAiFixes(); // a queued proactive AI fix is an AI request too: it must not fire after AI is switched off
}

// The one message shown when AI review is requested but no key is stored for the provider.
// Auto mode shows it once per provider per session; the manual command always shows it.
function notifyNoApiKey(provider, always) {
  if (!always && warnedNoKey.has(provider)) return;
  warnedNoKey.add(provider);
  const choice = vscode.window.showWarningMessage(
    `AccessGen: no API key is set for ${provider}. Run "AccessGen: Set AI API Key" (accessgen.setAiApiKey) to enable AI review.`,
    'Set API Key'
  );
  if (choice && typeof choice.then === 'function') {
    choice.then((picked) => {
      if (picked === 'Set API Key') vscode.commands.executeCommand('accessgen.setAiApiKey');
    }, () => {});
  }
}

// Created on first use only, so aiReviewMode 'off' (the default) never allocates it.
// In-session record of inline fix suggestions and the developer's decisions. Created on first use, so 'manual' mode never allocates it.
function getAutoFixChannel() {
  if (!autoFixChannel) autoFixChannel = vscode.window.createOutputChannel('AccessGen Auto-fix');
  return autoFixChannel;
}

function getAiChannel() {
  if (!aiChannel) aiChannel = vscode.window.createOutputChannel('AccessGen AI Review');
  return aiChannel;
}

console.log('AccessGen: extension.js module loaded');

function activate(context) {
  try {
    const config = getConfig();
    initDiagnostics();

    console.log('AccessGen: activate() called');
    writeDebugLine('activate() called');

    enabled = vscode.workspace.getConfiguration('accessgen').get('enabled', true);
    statusBarItem = createStatusBar();
    updateStatusBar(statusBarItem, enabled, 0);
    console.log('AccessGen: enabled =', enabled);
    writeDebugLine('enabled=' + enabled);
    writeDebugLine('complianceLevel=' + (config && config.complianceLevel ? config.complianceLevel : 'undefined'));
    writeDebugLine('disabledRulesCount=' + (config && config.disabledRules ? config.disabledRules.length : '0'));

    // Visible confirmation that the extension activated.
    if (enabled) showToggleNotification(true);
    else showToggleNotification(false);

    // ---- suggested fixes (remediationMode "hybrid" / "auto") ----------------------------
    // Nothing is applied without an explicit Accept: fixes are computed on scan and rendered inline (strikethrough
    // old text, new text after it, a CodeLens "Accept fix" / "Dismiss"). Session state only (nothing persisted or
    // sent anywhere). The report callbacks are the visibility: a non-modal status bar message on accept plus a
    // line in the 'AccessGen Auto-fix' channel for every suggestion and decision.
    const inlineDiff = createInlineDiff();
    inlineDiffRef = inlineDiff;
    const whereOf = (rec) => require('path').basename(rec.filePath) + ':' + rec.line;
    const autoFixReport = {
      suggested(rec) {
        getAutoFixChannel().appendLine('suggested (' + rec.tier + '): ' + rec.ruleId + ' - ' + rec.filePath + ' line ' + rec.line);
      },
      failed(rec) {
        const why = rec.reason === 'edit-rejected' ? 'the edit was rejected' : 'it did not resolve the violation';
        getAutoFixChannel().appendLine('auto-fix-failed, manual review needed: ' + rec.ruleId + ' - ' + rec.filePath + ' line ' + rec.line + ' (' + why + '; not suggested again, use the quick fix)');
        console.error('AccessGen: auto-fix failed for ' + rec.ruleId + ' at line ' + rec.line + ' (' + why + ')');
      }
    };
    const autoFixer = createAutoFixer({ inline: inlineDiff, report: autoFixReport });
    inlineDiff.on('accepted', (rec) => {
      getAutoFixChannel().appendLine('accepted (' + rec.tier + '): ' + rec.ruleId + ' - ' + rec.filePath + ' line ' + rec.line);
      vscode.window.setStatusBarMessage('AccessGen applied (' + rec.tier + '): ' + rec.ruleId + ' at ' + whereOf(rec), 6000);
    });
    inlineDiff.on('rejected', (rec) => {
      getAutoFixChannel().appendLine('dismissed (' + rec.tier + '): ' + rec.ruleId + ' - ' + rec.filePath + ' line ' + rec.line + ' (not suggested again unless the code changes)');
    });
    inlineDiff.on('stale', (rec) => {
      getAutoFixChannel().appendLine('stale, not applied (' + rec.tier + '): ' + rec.ruleId + ' - ' + rec.filePath + ' line ' + rec.line + ' (the code changed under the suggestion)');
      vscode.window.setStatusBarMessage('AccessGen: the code changed under that suggestion, so nothing was applied. It will be re-suggested on the next scan.', 6000);
    });
    try {
      inlineDiff.register(context);
    } catch (e) {
      // The review UI is optional: if this host cannot register CodeLens/commands, every other command must still work.
      console.error('AccessGen: could not register the inline-fix review UI:', e && e.message ? e.message : e);
    }

    // ---- one-time disclosure ----------------------------------------------------------
    // Informational, shown once ever (tracked in globalState, never in settings): enabling AI
    // review sends a small amount of text to a third party. Any way of closing the message counts
    // as seen. It is deliberately not awaited by callers: it must never block a command.
    const README_SECTION = '## AI Review and Data Sent to Third Parties';
    const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic' };
    let disclosureShowing = false;
    let disclosureInMemory; // fallback record when globalState is unavailable

    // Has the user acknowledged the CURRENT disclosure wording? The stored value is versioned (see
    // judgment/disclosure.js): the old plain `true` and any older version read as "not yet", so they are
    // asked again before the next real send, exactly like a first-time user.
    function disclosureAlreadySeen() {
      const gs = context.globalState;
      const stored = gs && typeof gs.get === 'function' ? gs.get(disclosure.DISCLOSURE_KEY, undefined) : disclosureInMemory;
      return disclosure.isDisclosureCurrent(stored);
    }
    function markDisclosureSeen() {
      const gs = context.globalState;
      const record = disclosure.disclosureRecord();
      if (gs && typeof gs.update === 'function') return Promise.resolve(gs.update(disclosure.DISCLOSURE_KEY, record));
      disclosureInMemory = record;
      return Promise.resolve();
    }

    async function openReadmeSection() {
      if (!context.extensionPath) return;
      const readmePath = require('path').join(context.extensionPath, 'README.md');
      let line = 0;
      try {
        const lines = require('fs').readFileSync(readmePath, 'utf8').split(/\r?\n/);
        const i = lines.findIndex(l => l.trim() === README_SECTION);
        if (i >= 0) line = i;
      } catch (e) { /* open at the top */ }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(readmePath));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
    }

    function disclosureText() {
      const provider = PROVIDER_LABELS[getConfig().aiProvider] || getConfig().aiProvider;
      return disclosure.disclosureText(provider);
    }

    function maybeShowAiDisclosure() {
      try {
        if (disclosureShowing || disclosureAlreadySeen()) return;
        disclosureShowing = true;
        const shown = vscode.window.showInformationMessage(disclosureText(), 'OK', 'Learn more');
        Promise.resolve(shown).then(async (choice) => {
          await markDisclosureSeen();
          if (choice === 'Learn more') await openReadmeSection();
        }).catch((e) => {
          console.error('AccessGen: disclosure error:', e && e.message ? e.message : e);
        }).then(() => { disclosureShowing = false; });
      } catch (e) {
        disclosureShowing = false;
        console.error('AccessGen: disclosure error:', e && e.message ? e.message : e);
      }
    }

    // ---- blocking confirmation before the first request ever sent ---------------------
    // The informational notices above fire when AI review is merely switched on or a key is
    // stored: nothing has been sent at that point. THIS is the moment data would actually leave
    // the machine, so it is a modal. It is a no-op once the same globalState flag is set (by
    // this dialog or by either notice). OK sends the batch and sets the flag. Cancel sends
    // nothing and switches AI review off, so nothing fires again until it is turned back on.
    function turnOffModeInFileConfig() {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || !folders.length) return;
      const file = require('path').join(folders[0].uri.fsPath, 'accessgen.config.json');
      const fs = require('fs');
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return; } // unreadable: leave the file alone
      if (!parsed || (parsed.aiReviewMode !== 'manual' && parsed.aiReviewMode !== 'auto')) return;
      // The project file overrides the VS Code setting, so it has to change too. Only the value
      // is replaced, which keeps the file's formatting, key order and line endings intact.
      const edited = raw.replace(/("aiReviewMode"\s*:\s*)"(?:manual|auto)"/, '$1"off"');
      fs.writeFileSync(file, edited !== raw ? edited : JSON.stringify({ ...parsed, aiReviewMode: 'off' }, null, 2) + '\n', 'utf8');
    }

    // Does what a developer changing the setting would: "off" at every settings scope that
    // enables it, and in accessgen.config.json when that is where it is enabled.
    async function turnAiReviewOff() {
      const folders = vscode.workspace.workspaceFolders;
      const resource = folders && folders.length ? folders[0].uri : undefined;
      const cfg = vscode.workspace.getConfiguration('accessgen', resource);
      const inspected = typeof cfg.inspect === 'function' ? cfg.inspect('aiReviewMode') : undefined;
      const target = vscode.ConfigurationTarget;
      const scopes = [
        [inspected && inspected.workspaceFolderValue, target.WorkspaceFolder],
        [inspected && inspected.workspaceValue, target.Workspace],
        [inspected && inspected.globalValue, target.Global]
      ];
      for (const [value, where] of scopes) {
        if (value !== undefined && value !== 'off') {
          try { await cfg.update('aiReviewMode', 'off', where); } catch (e) { /* verified below */ }
        }
      }
      try { turnOffModeInFileConfig(); } catch (e) { /* verified below */ }
      reloadConfig();
      lastAiMode = getConfig().aiReviewMode;
      cancelPendingAiReviews();
      return lastAiMode === 'off';
    }

    let sendDecision = null; // one dialog at a time: overlapping reviews share its answer
    function confirmFirstSend() {
      if (disclosureAlreadySeen()) return Promise.resolve(true);
      if (!sendDecision) {
        sendDecision = (async () => {
          let choice;
          try {
            choice = await vscode.window.showInformationMessage(
              disclosureText(),
              { modal: true, detail: 'Choose OK to send this batch now, or Cancel to send nothing and turn AI review off.' },
              'OK'
            );
          } catch (e) {
            console.error('AccessGen: could not show the AI disclosure dialog:', e && e.message ? e.message : e);
            return false; // cannot ask => do not send
          }
          if (choice === 'OK') {
            await markDisclosureSeen();
            return true;
          }
          // Cancel (or the dialog was dismissed): send nothing, turn AI review off.
          if (await turnAiReviewOff()) {
            vscode.window.showInformationMessage('AccessGen: AI review is now off and nothing was sent. Set accessgen.aiReviewMode to "manual" or "auto" to turn it back on.');
          } else {
            vscode.window.showWarningMessage('AccessGen: nothing was sent, but AI review could not be switched off automatically. Set accessgen.aiReviewMode to "off" yourself.');
          }
          return false;
        })().then((answer) => { sendDecision = null; return answer; }, () => { sendDecision = null; return false; });
      }
      return sendDecision;
    }

    // ---- AI-suggested quick fixes ---------------------------------------------------------
    // The code-action provider hands out a lightweight "AccessGen (AI): Suggest ..." action with no edit;
    // only when the developer selects it does resolve() below run. It goes through exactly the gates the
    // judgment layer uses, in the same order and only when a request is actually about to be sent:
    //   1. no API key stored  -> the same "no key" message (accessgen.setAiApiKey), nothing sent
    //   2. first send ever    -> the same blocking disclosure dialog (confirmFirstSend, same flag)
    // The actions exist only while AI features are on (aiReviewMode is not "off"), so "off sends nothing"
    // still holds. Every outcome that is not an edit is reported in one line; nothing here can throw.
    const aiFixer = createAiFixer();
    const aiFixServices = {
      enabled: () => getConfig().aiReviewMode !== 'off',
      // opts.quiet (the proactive path): no pop-ups for outcomes that are not an edit, because they would fire for
      // every element on every scan. The key warning still shows, but once per provider per session, exactly like
      // auto-mode AI review; everything else goes to the AI channel.
      async resolve({ rule, violation, document }, opts) {
        const quiet = !!(opts && opts.quiet);
        const config = { ...getConfig(), isRuleDisabled, isTrustedComponent, secrets: context.secrets };
        const filePath = (document.uri && (document.uri.fsPath || document.uri.toString())) || '(unknown)';
        const res = await aiFixer.resolve({
          rule, violation, sourceCode: document.getText(), filePath, config,
          gates: { hasKey: getApiKey, confirm: confirmFirstSend }
        });
        try {
          if (res.status === 'no-key') notifyNoApiKey(res.provider || config.aiProvider, !quiet);
          else if (quiet && (res.status === 'error' || res.status === 'low-confidence' || res.status === 'unavailable')) {
            getAiChannel().appendLine('AI-suggested ' + (rule.aiFixLabel || 'text') + ' for ' + filePath + ' line ' + (violation.startLine + 1) + ': ' + res.status + (res.message ? ' - ' + res.message : ''));
          }
          else if (res.status === 'error') vscode.window.showErrorMessage(res.message);
          else if (res.status === 'low-confidence' || res.status === 'unavailable') vscode.window.showInformationMessage(res.message);
          else if (res.status === 'ok') {
            getAiChannel().appendLine('AI-suggested ' + (rule.aiFixLabel || 'text') + ' for ' + filePath + ' line ' + (violation.startLine + 1) +
              ': ' + JSON.stringify(res.suggestion.suggestedText) + ' (confidence ' + res.suggestion.confidence.toFixed(2) + '): ' + res.suggestion.reasoning +
              (res.cached ? ' (cached)' : ''));
          }
        } catch (e) {
          console.error('AccessGen: could not report the AI fix outcome:', e && e.message ? e.message : e);
        }
        return res;
      }
    };

    // ---- auto-mode AI review, on its own (longer) debounce ----------------------------
    // The structural scan runs on accessgen.debounceMs. The paid AI step instead waits for
    // accessgen.aiReviewDebounceMs of quiet: every completed scan re-arms one timer per file,
    // so a burst of edits produces a single batch, judging the latest scan's content.
    function scheduleAutoReview(job) {
      const previous = aiTimers.get(job.filePath);
      if (previous) clearTimeout(previous);
      const delay = getConfig().aiReviewDebounceMs;
      aiTimers.set(job.filePath, setTimeout(() => {
        aiTimers.delete(job.filePath);
        runScheduledAutoReview(job);
      }, delay));
    }

    function runScheduledAutoReview(job) {
      // Re-checked at fire time: the mode may have been switched, or AccessGen turned off,
      // while the timer was waiting. Config is re-read so a changed model/provider is honoured.
      const live = getConfig();
      if (!enabled || live.aiReviewMode !== 'auto') return;
      try {
        const aiConfig = { ...live, isRuleDisabled, isTrustedComponent, secrets: context.secrets };
        Promise.resolve(aiReview.runAutoReview({
          sourceCode: job.sourceCode, languageId: job.lang, violations: job.violations,
          config: aiConfig, filePath: job.filePath, confirmFirstSend
        }, (line) => getAiChannel().appendLine(line))).then((outcome) => {
          if (outcome && outcome.status === 'no-key') notifyNoApiKey(outcome.provider, false);
        }).catch((e) => {
          console.error('AccessGen: AI review (auto) error:', e && e.message ? e.message : e);
        });
      } catch (e) {
        console.error('AccessGen: AI review (auto) error:', e && e.message ? e.message : e);
      }
    }

    // ---- auto-mode proactive AI fixes, on the same (longer) AI debounce -----------------------
    // Only remediationMode "auto" does this, and never while aiReviewMode is "off". It is NOT a separate pipeline:
    // one timer per file on accessgen.aiReviewDebounceMs (re-armed by every scan, like the judgment layer), the
    // changeTracker identity so nothing is requested twice, the same per-run cap, and the same two gates inside
    // the request (no key -> the same warning, once; first real send -> the same blocking disclosure modal).
    function scheduleAiFix(job) {
      const previous = aiFixTimers.get(job.filePath);
      if (previous) clearTimeout(previous);
      const delay = getConfig().aiReviewDebounceMs;
      aiFixTimers.set(job.filePath, setTimeout(() => {
        aiFixTimers.delete(job.filePath);
        runScheduledAiFix(job);
      }, delay));
    }

    function runScheduledAiFix(job) {
      // Re-checked at fire time, as for the review: modes may have changed while the timer was waiting.
      const live = getConfig();
      if (!enabled || live.remediationMode !== 'auto' || live.aiReviewMode === 'off') return;
      try {
        const salt = providerName(live) + '/' + resolveModel(live);
        Promise.resolve(autoFixer.runAi({
          document: job.document, languageId: job.lang, violations: job.violations, sourceAtScan: job.sourceCode,
          mode: live.remediationMode, salt, report: autoFixReport,
          resolve: (args) => aiFixServices.resolve(args, { quiet: true }),
          log: (line) => getAiChannel().appendLine(line)
        })).then((out) => {
          // A previous run for this file was still waiting on the provider (or stopped because the text changed under it):
          // try again once it is free, unless a newer scan has already armed a timer with fresher content.
          if (out && out.blocked && !aiFixTimers.has(job.filePath)) scheduleAiFix(job);
        }).catch((e) => {
          console.error('AccessGen: AI fix (auto) error:', e && e.message ? e.message : e);
        });
      } catch (e) {
        console.error('AccessGen: AI fix (auto) error:', e && e.message ? e.message : e);
      }
    }

    // ---- batch remediation, scan scopes and the side panel --------------------------------------
    // All issues of a file go to the model in ONE request (split only when large), with rich local context, and every
    // answer is verified locally before it is shown. Proposals live in the issue store; the panel and the inline diff
    // both review them, and nothing is applied without Accept. Same consent gates as every other AI feature.
    const store = createIssueStore();
    const engine = createRemediationEngine({
      requestFix: (request, cfg) => providers.remediate(request, cfg),
      salt: (cfg) => providerName(cfg) + '/' + providers.resolveRemediationModel(cfg)
    });
    let projectFacts = null; // collected once per session, on the first batch run
    const fileKeyOfUri = (uri) => uri.fsPath || uri.toString();

    function recordScan(uri, languageId, source, violations) {
      store.setFile(uri.toString(), { filePath: fileKeyOfUri(uri), languageId, violations, source: violations.length ? source : null, issueKeys: matchKeysFor(source, violations) });
    }

    const analyzeForScan = (document) => analyzeDocument(document, { ...getConfig(), isRuleDisabled, isTrustedComponent });

    async function rescanUri(uri) {
      await workspaceScan.scanUris([uri], {
        analyze: analyzeForScan,
        onResult: (r) => { updateDiagnostics(r.document, r.violations); recordScan(r.uri, r.languageId, r.source, r.violations); }
      });
    }

    const controller = createFixController({ store, rescan: (uri) => rescanUri(uri) });
    try { controller.register(context); } catch (e) { console.error('AccessGen: could not register the fix preview:', e && e.message ? e.message : e); }

    // Batch fixes shown inline too (single-range ones): the inline Accept / Dismiss and the panel stay in sync.
    function syncInline(proposals, document) {
      if (!document) return;
      for (const p of proposals) {
        if (p.decision !== 'pending' || p.status !== 'fixed' || !p.verification || !p.verification.verified || !p.ranges || p.ranges.length !== 1) continue;
        const r = p.ranges[0];
        const start = document.positionAt(r.start), end = document.positionAt(r.end);
        const range = { startLine: start.line, startChar: start.character, endLine: end.line, endChar: end.character };
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(start, end), r.newText);
        inlineDiff.propose({
          document, id: p.id, slot: p.id, ruleId: p.ruleId, tier: 'ai-suggested', kind: 'batch',
          built: { edit, newText: r.newText, range }, oldText: r.oldText,
          detail: 'verified, confidence ' + Math.round(p.confidence * 100) + '%: ' + (p.summary || '')
        });
      }
      inlineDiff.flush(document);
    }
    const syncDecision = (decision) => (rec) => {
      const p = store.getProposal(rec.id);
      if (p && p.decision === 'pending') {
        store.decide(rec.id, decision);
        if (decision === 'accepted') rescanUri(vscode.Uri.parse(p.uri)).catch(() => {});
      }
    };
    inlineDiff.on('accepted', syncDecision('accepted'));
    inlineDiff.on('rejected', syncDecision('rejected'));
    store.onChange(() => {
      // A proposal decided in the panel must disappear from the inline diff as well.
      for (const p of store.listProposals()) {
        if (p.decision !== 'pending' && inlineDiff.has(p.file, p.id)) {
          inlineDiff.remove(p.file, p.id);
          const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === p.uri);
          if (doc) inlineDiff.flush(doc);
        }
      }
    });

    async function ensureAiOn() {
      if (getConfig().aiReviewMode !== 'off') return true;
      const pick = await vscode.window.showInformationMessage(
        'AccessGen: AI features are off, so nothing can be sent for remediation. Turn them on (on request only)?',
        'Turn on', 'Cancel');
      if (pick !== 'Turn on') return false;
      await vscode.workspace.getConfiguration('accessgen').update('aiReviewMode', 'manual', vscode.ConfigurationTarget.Global);
      reloadConfig();
      return getConfig().aiReviewMode !== 'off';
    }

    // files: [{ uri, languageId, source, violations }]. opts.quiet: proactive (auto mode) run, no progress UI or pop-ups.
    async function runBatch(files, opts = {}) {
      const quiet = !!opts.quiet;
      const live = getConfig();
      const cfg = { ...live, isRuleDisabled, isTrustedComponent, secrets: context.secrets };
      if (!projectFacts) projectFacts = await workspaceScan.collectProjectFacts();
      const work = files.filter(f => f.violations && f.violations.length);
      if (!work.length) {
        if (!quiet) vscode.window.showInformationMessage('AccessGen: no issues to fix.');
        return null;
      }
      const go = async (progress, token) => engine.remediate({
        files: work.map(f => ({ filePath: fileKeyOfUri(f.uri), languageId: f.languageId, source: f.source, violations: f.violations, uri: f.uri })),
        config: cfg,
        gates: { hasKey: getApiKey, confirm: confirmFirstSend },
        readAssetFor: live.aiSendImages ? (filePath) => workspaceScan.assetReaderFor(filePath) : null,
        projectFacts,
        maxIssues: opts.maxIssues,
        retryUnresolved: !quiet,
        onProgress: (msg) => { if (progress) progress.report({ message: msg }); },
        isCancelled: () => !!(token && token.isCancellationRequested)
      });
      const out = quiet ? await go(null, null) : await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AccessGen', cancellable: true },
        (progress, token) => go(progress, token));

      if (out.stopped === 'no-key') { notifyNoApiKey(providerName(cfg), !quiet); return out; }
      if (out.stopped === 'declined') return out;
      const byUri = new Map(work.map(f => [fileKeyOfUri(f.uri), f.uri]));
      const groups = new Map();
      for (const p of out.proposals) {
        const uri = byUri.get(p.file);
        if (!uri) continue;
        if (!groups.has(uri.toString())) groups.set(uri.toString(), []);
        groups.get(uri.toString()).push(p);
      }
      for (const [uri, list] of groups) {
        store.addProposals(uri, list);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri);
        if (doc && live.remediationMode !== 'manual') syncInline(store.listProposals().filter(p => p.uri === uri), doc);
      }
      const verified = out.proposals.filter(p => p.status === 'fixed' && p.verification && p.verification.verified).length;
      const channel = getAiChannel();
      channel.appendLine('batch remediation (' + providerName(cfg) + '/' + providers.resolveRemediationModel(cfg) + '): ' + out.proposals.length + ' answers, ' + verified + ' verified, ' +
        out.requests + ' request' + (out.requests === 1 ? '' : 's') + ', ' + out.cached + ' from cache' + (out.deferred ? ', ' + out.deferred + ' deferred (per-run limit)' : '') + (out.stopped ? ', stopped: ' + out.stopped : ''));
      for (const e of out.errors) channel.appendLine('  error in ' + require('path').basename(e.file) + ': ' + e.message);
      if (!quiet) {
        const msg = 'AccessGen: ' + out.proposals.length + ' fix' + (out.proposals.length === 1 ? '' : 'es') + ' proposed (' + verified + ' verified) with ' +
          out.requests + ' AI request' + (out.requests === 1 ? '' : 's') + (out.cached ? ' (' + out.cached + ' reused)' : '') + (out.errors.length ? '; ' + out.errors.length + ' failed (see the AI Review output)' : '') + '.';
        vscode.window.showInformationMessage(msg, 'Review fixes').then((pick) => { if (pick) vscode.commands.executeCommand('accessgen.panel.focus'); }, () => {});
      }
      return out;
    }

    async function filesForBatch(uriStrings) {
      const out = [];
      const targets = uriStrings ? store.listFiles().filter(f => uriStrings.includes(f.uri)) : store.listFiles();
      for (const f of targets) {
        if (!f.violations.length) continue;
        const uri = vscode.Uri.parse(f.uri);
        const read = await workspaceScan.readSource(uri);
        if (typeof read.text !== 'string') continue;
        // Re-analyse the current text so the fixes describe exactly what is in the file now.
        const violations = await analyzeForScan(read.document || workspaceScan.documentShim(uri, read.text, f.languageId));
        recordScan(uri, f.languageId, read.text, violations);
        out.push({ uri, languageId: f.languageId, source: read.text, violations });
      }
      return out;
    }

    async function fixFiles(uriStrings) {
      if (!(await ensureAiOn())) return;
      await runBatch(await filesForBatch(uriStrings));
    }

    async function fixIssue(uriString, index) {
      if (!(await ensureAiOn())) return;
      const f = store.getFile(uriString);
      const v = f && f.violations[index];
      if (!v) return;
      const [file] = await filesForBatch([uriString]);
      if (!file) return;
      const same = file.violations.filter(x => x.ruleId === v.ruleId && x.startLine === v.startLine && x.startChar === v.startChar);
      await runBatch([{ ...file, violations: same.length ? same : [v] }]);
    }

    async function scanWithProgress(uris, title) {
      let result;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        result = await workspaceScan.scanUris(uris, {
          analyze: analyzeForScan, progress, token,
          onResult: (r) => { updateDiagnostics(r.document, r.violations); recordScan(r.uri, r.languageId, r.source, r.violations); }
        });
      });
      const s = store.summary();
      vscode.window.showInformationMessage('AccessGen: scanned ' + result.scanned + ' file' + (result.scanned === 1 ? '' : 's') + (result.cancelled ? ' (cancelled)' : '') + '. ' + s.issues + ' issue' + (s.issues === 1 ? '' : 's') + ' in ' + s.filesWithIssues + ' file' + (s.filesWithIssues === 1 ? '' : 's') + '.', 'Open panel')
        .then((pick) => { if (pick) vscode.commands.executeCommand('accessgen.panel.focus'); }, () => {});
      return result;
    }

    async function scanActive() {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !workspaceScan.languageOf(editor.document.uri) && !['html', 'javascriptreact', 'typescriptreact', 'css'].includes(editor.document.languageId)) {
        vscode.window.showInformationMessage('AccessGen: open an HTML, JSX, TSX or CSS file to scan it.');
        return;
      }
      const document = editor.document;
      const violations = await analyzeForScan(document);
      updateDiagnostics(document, violations);
      applyHighlights(editor, violations);
      recordScan(document.uri, document.languageId, document.getText(), violations);
      vscode.commands.executeCommand('accessgen.panel.focus');
    }

    async function scanSelected(uris) {
      const picked = uris && uris.length ? uris : await workspaceScan.pickFiles();
      if (!picked) return;
      const files = [];
      for (const u of picked) {
        let stat;
        try { stat = await vscode.workspace.fs.stat(u); } catch (e) { continue; }
        if (stat.type & vscode.FileType.Directory) {
          const inside = await vscode.workspace.findFiles(new vscode.RelativePattern(u, '**/*.{html,htm,jsx,tsx,css}'), '**/{node_modules,dist,build,out,.git,.next}/**', 5000);
          files.push(...inside);
        } else files.push(u);
      }
      await scanWithProgress(files, 'AccessGen: scanning ' + files.length + ' file' + (files.length === 1 ? '' : 's'));
      await openInTabs(files);
    }

    // The files the developer picked are opened as editor tabs, so each page's issues can be reviewed in place.
    const MAX_TABS = 20;
    async function openInTabs(uris) {
      let list = uris;
      if (uris.length > MAX_TABS) {
        const pick = await vscode.window.showInformationMessage('AccessGen: open all ' + uris.length + ' scanned files in tabs?', 'Open first ' + MAX_TABS, 'Open all', 'Don\'t open');
        if (!pick || pick === 'Don\'t open') return;
        if (pick !== 'Open all') list = uris.slice(0, MAX_TABS);
      }
      for (let i = 0; i < list.length; i++) {
        try {
          const doc = await vscode.workspace.openTextDocument(list[i]);
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: i < list.length - 1 });
        } catch (e) { /* a file that cannot be opened is skipped */ }
      }
    }

    async function scanWorkspace() {
      const uris = await workspaceScan.findCandidateFiles();
      if (!uris.length) { vscode.window.showInformationMessage('AccessGen: no HTML, JSX, TSX or CSS files found in this workspace.'); return; }
      await scanWithProgress(uris, 'AccessGen: scanning project (' + uris.length + ' files)');
    }

    // Proactive batch fixes in remediationMode 'auto' (strategy 'batch'): one request per changed file, on the AI debounce,
    // only issues that are new or changed are sent (the engine cache), at most 25 per run.
    function scheduleBatchFix(job) {
      const previous = batchTimers.get(job.filePath);
      if (previous) clearTimeout(previous);
      batchTimers.set(job.filePath, setTimeout(() => {
        batchTimers.delete(job.filePath);
        const live = getConfig();
        if (!enabled || live.remediationMode !== 'auto' || live.aiReviewMode === 'off' || live.aiRemediationStrategy !== 'batch') return;
        if (job.document.getText() !== job.sourceCode) return; // typed meanwhile: the next scan schedules again
        runBatch([{ uri: job.document.uri, languageId: job.lang, source: job.sourceCode, violations: job.violations }], { quiet: true, maxIssues: 25 })
          .catch((e) => console.error('AccessGen: batch fix (auto) error:', e && e.message ? e.message : e));
      }, getConfig().aiReviewDebounceMs));
    }

    const relPathOf = (uriString) => { try { return workspaceScan.relPath(vscode.Uri.parse(uriString)); } catch (e) { return uriString; } };
    const panel = createPanelProvider({
      extensionUri: () => context.extensionUri || vscode.Uri.file(context.extensionPath || require('path').join(__dirname, '..')),
      store, controller, getConfig, relPath: relPathOf,
      activeUri: () => (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.toString() : null),
      actions: {
        scanActive, scanSelected: () => scanSelected(), scanWorkspace, fixFiles, fixIssue,
        remediationModel: () => providers.resolveRemediationModel(getConfig()),
        async open(uriString, line) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
          const pos = new vscode.Position(Math.max(0, line - 1), 0);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
        }
      }
    });
    try { panel.register(context); } catch (e) { console.error('AccessGen: could not register the panel:', e && e.message ? e.message : e); }

    async function exportReport() {
      const folders = vscode.workspace.workspaceFolders;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folders && folders.length ? vscode.Uri.joinPath(folders[0].uri, 'accessgen-report.md') : undefined,
        filters: { Markdown: ['md'] }, title: 'AccessGen: export accessibility report'
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(buildReport({ store, relPath: relPathOf }), 'utf8'));
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    const activeFileForFix = () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? editor.document.uri.toString() : null;
    };
    context.subscriptions.push(
      vscode.commands.registerCommand('accessgen.scanFile', () => scanActive()),
      vscode.commands.registerCommand('accessgen.scanFiles', (uri, uris) => scanSelected(Array.isArray(uris) && uris.length ? uris : uri ? [uri] : undefined)),
      vscode.commands.registerCommand('accessgen.scanWorkspace', () => scanWorkspace()),
      vscode.commands.registerCommand('accessgen.fixFileWithAI', async () => {
        const uri = activeFileForFix();
        if (!uri) return;
        if (!store.getFile(uri)) await scanActive();
        await fixFiles([uri]);
      }),
      vscode.commands.registerCommand('accessgen.fixAllWithAI', () => fixFiles(null)),
      vscode.commands.registerCommand('accessgen.acceptAllVerifiedFixes', () => controller.acceptAllVerified()),
      vscode.commands.registerCommand('accessgen.exportReport', () => exportReport())
    );

    let lastAiMode = getConfig().aiReviewMode;

    function runAnalysis(editor) {
      if (!editor) return;
      if (!enabled) {
        clearHighlights(editor);
        clearDiagnostics(editor.document);
        inlineDiff.dropAll(editor.document);
        updateStatusBar(statusBarItem, false, 0);
        writeDebugLine('analysis skipped (disabled)');
        return;
      }

      const document = editor.document;
      const lang = document.languageId;
      const filePath = document.uri && document.uri.fsPath ? document.uri.fsPath : '(unknown)';
      console.log('AccessGen: analyze request for', lang, 'len=', document.getText().length);
      writeDebugLine('analyze request for lang=' + lang + ' len=' + document.getText().length + ' file=' + filePath);
      if (!['html', 'javascriptreact', 'typescriptreact', 'css'].includes(lang)) {
        return;
      }

      const sourceLen = document.getText().length;
      if (sourceLen > 500 * 1024) {
        clearHighlights(editor);
        clearDiagnostics(document);
        updateStatusBar(statusBarItem, true, 0);
        vscode.window.setStatusBarMessage('AccessGen — File too large to analyze', 3000);
        return;
      }

      const currentConfig = getConfig();
      const configProxy = {
        ...currentConfig,
        isRuleDisabled,
        isTrustedComponent
      };

      const sourceAtScan = document.getText(); // the text these violations describe

      analyzeDocument(document, configProxy).then(violations => {
        if (editor !== vscode.window.activeTextEditor) return;

        console.log('AccessGen: violations found =', violations.length);
        const ruleIds = Array.isArray(violations) ? violations.map(v => v.ruleId) : [];
        const unique = [...new Set(ruleIds)];
        writeDebugLine('violations found=' + violations.length + ' uniqueRules=' + unique.slice(0, 10).join(','));
        try {
          applyHighlights(editor, violations);
        } catch (e) {
          console.error('AccessGen: applyHighlights error:', e && e.stack ? e.stack : e);
        }
        try {
          updateDiagnostics(document, violations);
        } catch (e) {
          console.error('AccessGen: updateDiagnostics error:', e && e.stack ? e.stack : e);
        }
        lastIssueCount = violations.length;
        updateStatusBar(statusBarItem, enabled, violations.length);
        try { recordScan(document.uri, lang, sourceAtScan, violations); } catch (e) { console.error('AccessGen: issue store error:', e && e.message ? e.message : e); }

        // Suggested fixes: skipped entirely in 'manual' mode (the default), where nothing is suggested
        // and any leftover suggestion is cleared. Runs after diagnostics are published, on the document
        // just analysed, and only while no debounced rescan is pending (the scan itself already waited
        // for debounceMs of quiet). It renders inline diffs; it never edits the document.
        if (currentConfig.remediationMode === 'hybrid' || currentConfig.remediationMode === 'auto') {
          autoFixer.run({
            document, languageId: lang, violations, sourceAtScan,
            mode: currentConfig.remediationMode,
            canApplyNow: () => !debounceTimer && editor === vscode.window.activeTextEditor,
            report: autoFixReport
          }).catch((e) => {
            console.error('AccessGen: auto-fix error:', e && e.message ? e.message : e);
          });
        } else {
          inlineDiff.dropAll(document);
        }

        // Proactive AI fixes: remediationMode 'auto' only, and never while AI features are off. Scheduled on
        // the AI debounce, not run inline; it cannot reject back into the scan.
        // Strategy 'batch' (the default) sends every new or changed issue of the file in one request; 'per-issue' keeps
        // the older one-request-per-issue path.
        if (currentConfig.remediationMode === 'auto' && currentConfig.aiReviewMode !== 'off') {
          if (currentConfig.aiRemediationStrategy === 'per-issue') scheduleAiFix({ document, sourceCode: sourceAtScan, lang, violations, filePath });
          else scheduleBatchFix({ document, sourceCode: sourceAtScan, lang, violations, filePath });
        }

        // AI review: skipped entirely unless mode is 'auto'. Never runs inline; it is scheduled
        // on its own longer debounce and cannot reject back into the scan.
        if (currentConfig.aiReviewMode === 'auto') {
          scheduleAutoReview({ sourceCode: sourceAtScan, lang, violations, filePath });
        }
      }).catch(err => {
        console.error('AccessGen: Analysis error:', err && err.stack ? err.stack : err && err.message ? err.message : err);
        writeDebugLine('analysis error: ' + (err && err.message ? err.message : String(err)));
      });
    }

    function debouncedAnalysis(editor) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      const delay = getConfig().debounceMs || 800;
      debounceTimer = setTimeout(() => {
        debounceTimer = null; // "a rescan is pending" must be false once it has fired (auto-fix checks it)
        runAnalysis(editor);
      }, delay);
    }

    const toggleCmd = vscode.commands.registerCommand('accessgen.toggle', () => {
      enabled = !enabled;
      const scope = getConfig().stateScope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      vscode.workspace.getConfiguration('accessgen').update('enabled', enabled, scope);

      if (!enabled) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          clearHighlights(editor);
          clearDiagnostics(editor.document);
          inlineDiff.dropAll(editor.document);
        }
        updateStatusBar(statusBarItem, false, 0);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          runAnalysis(editor);
        }
      }
      showToggleNotification(enabled);
    });

    const enableCmd = vscode.commands.registerCommand('accessgen.enable', () => {
      enabled = true;
      const scope = getConfig().stateScope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      vscode.workspace.getConfiguration('accessgen').update('enabled', enabled, scope);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        runAnalysis(editor);
      }
      updateStatusBar(statusBarItem, true, lastIssueCount);
      showToggleNotification(true);
    });

    const disableCmd = vscode.commands.registerCommand('accessgen.disable', () => {
      enabled = false;
      const scope = getConfig().stateScope === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      vscode.workspace.getConfiguration('accessgen').update('enabled', enabled, scope);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        clearHighlights(editor);
        clearDiagnostics(editor.document);
        inlineDiff.dropAll(editor.document);
      }
      updateStatusBar(statusBarItem, false, 0);
      showToggleNotification(false);
    });

    const statusCmd = vscode.commands.registerCommand('accessgen.showStatus', () => {
      const state = enabled ? 'Enabled' : 'Disabled';
      vscode.window.showInformationMessage(
        `AccessGen is ${state}. ${lastIssueCount} issue(s) in this file.`
      );
    });

    const reviewCmd = vscode.commands.registerCommand('accessgen.reviewWithAI', async () => {
      const mode = getConfig().aiReviewMode;
      if (mode === 'off') {
        vscode.window.showInformationMessage(
          "AccessGen: AI review is off. Set accessgen.aiReviewMode to 'manual' or 'auto' to use it."
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const document = editor.document;
      if (!['html', 'javascriptreact', 'typescriptreact'].includes(document.languageId)) {
        vscode.window.showInformationMessage('AccessGen: AI review supports HTML, JSX and TSX files.');
        return;
      }
      try {
        const configProxy = { ...getConfig(), isRuleDisabled, isTrustedComponent, secrets: context.secrets };
        const violations = await analyzeDocument(document, configProxy);
        const outcome = await aiReview.runManualReview({
          sourceCode: document.getText(), languageId: document.languageId, violations,
          config: configProxy, filePath: document.uri && document.uri.fsPath ? document.uri.fsPath : '(unknown)',
          confirmFirstSend
        }, (line) => getAiChannel().appendLine(line));
        if (outcome.status === 'declined') return; // nothing was sent; the user has already been told
        if (outcome.status === 'no-key') {
          notifyNoApiKey(outcome.provider, true);
          return;
        }
        getAiChannel().show(true);
        vscode.window.showInformationMessage(
          `AccessGen AI review: ${outcome.judged} judged, ${outcome.cached} unchanged, ${outcome.failed} failed.`
        );
      } catch (e) {
        console.error('AccessGen: AI review error:', e && e.message ? e.message : e);
      }
    });

    // Stores the key in VS Code SecretStorage under a provider-scoped name. The key is never
    // logged, written to settings, or shown back.
    const setKeyCmd = vscode.commands.registerCommand('accessgen.setAiApiKey', async () => {
      const provider = getConfig().aiProvider;
      maybeShowAiDisclosure(); // shown alongside the prompt; never blocks it
      const entered = await vscode.window.showInputBox({
        title: `AccessGen: ${provider} API key`,
        prompt: `Enter your ${provider} API key. It is kept in VS Code's secret storage, not in settings or the repo.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value && value.trim() ? undefined : 'The key cannot be empty.')
      });
      if (entered === undefined) return; // cancelled
      const key = entered.trim();
      if (!key) return;
      try {
        await context.secrets.store(secretKeyFor(provider), key);
        warnedNoKey.delete(provider);
        vscode.window.showInformationMessage(`AccessGen: API key saved for ${provider}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`AccessGen: could not save the ${provider} API key.`);
      }
    });

    // Removes stored API keys from SecretStorage. Nothing about the key is ever shown.
    const clearKeyCmd = vscode.commands.registerCommand('accessgen.clearAiApiKey', async () => {
      const names = Object.keys(PROVIDERS);
      const picked = await vscode.window.showQuickPick([
        ...names.map(n => ({ label: PROVIDER_LABELS[n] || n, description: 'Remove the stored ' + (PROVIDER_LABELS[n] || n) + ' API key', value: n })),
        { label: 'All providers', description: 'Remove every stored AI API key', value: 'all' }
      ], { title: 'AccessGen: Clear AI API Key', placeHolder: 'Which stored API key should be removed?' });
      if (!picked) return; // cancelled
      const targets = picked.value === 'all' ? names : [picked.value];
      try {
        for (const name of targets) {
          await context.secrets.delete(secretKeyFor(name));
          warnedNoKey.delete(name); // if AI review is used again, tell the user the key is missing
        }
        vscode.window.showInformationMessage(
          'AccessGen: cleared the stored API key for ' + (picked.value === 'all' ? 'all providers' : picked.value) + '.'
        );
      } catch (e) {
        vscode.window.showErrorMessage('AccessGen: could not clear the stored API key.');
      }
    });

    const onEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
      try { panel.refresh(); } catch (e) { /* the panel follows the active page */ }
      if (editor && enabled) {
        inlineDiff.show(editor.document); // this editor may have lost its decorations while it was not shown
        runAnalysis(editor);
      } else if (editor && !enabled) {
        updateStatusBar(statusBarItem, false, 0);
      }
    });

    const onDocChange = vscode.workspace.onDidChangeTextDocument((event) => {
      if (!enabled) return;
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        debouncedAnalysis(editor);
      }
    });

    const onConfigChange = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('accessgen')) {
        reloadConfig();
        const previousMode = lastAiMode;
        lastAiMode = getConfig().aiReviewMode;
        if (lastAiMode !== 'auto') cancelPendingAiReviews(); // a queued review must not fire after switching away
        cancelPendingAiFixes(); // re-armed by the rescan below if the new settings still allow it
        if (previousMode === 'off' && lastAiMode !== 'off') maybeShowAiDisclosure();
        enabled = vscode.workspace.getConfiguration('accessgen').get('enabled', true);
        const editor = vscode.window.activeTextEditor;
        if (enabled && editor) {
          runAnalysis(editor);
        } else if (!enabled && editor) {
          clearHighlights(editor);
          clearDiagnostics(editor.document);
          inlineDiff.dropAll(editor.document);
          updateStatusBar(statusBarItem, false, 0);
        }
      }
    });

    registerHoverProvider(context);
    registerCodeActions(context, aiFixServices);

    context.subscriptions.push(
      toggleCmd, enableCmd, disableCmd, statusCmd, reviewCmd, setKeyCmd, clearKeyCmd,
      onEditorChange, onDocChange, onConfigChange,
      statusBarItem
    );

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && enabled) {
      runAnalysis(activeEditor);
    }
  } catch (e) {
    console.error('AccessGen: activate() crashed:', e && e.stack ? e.stack : e);
    // Do not rethrow: keep the Extension Host running.
  }
}

function deactivate() {
  cancelPendingAiReviews();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  disposeDiagnostics();
  disposeDecorations();
  if (inlineDiffRef) {
    inlineDiffRef.dispose();
    inlineDiffRef = null;
  }
  if (aiChannel) {
    aiChannel.dispose();
    aiChannel = null;
  }
  if (autoFixChannel) {
    autoFixChannel.dispose();
    autoFixChannel = null;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = null;
  }
}

module.exports = { activate, deactivate };
