const vscode = require('vscode');
const { getRuleById } = require('./analyzer');
const { getFixableViolation } = require('./diagnostics');
const { effectiveFixer } = require('./judgment/genericFix');

// Builds the WorkspaceEdit for one violation's fix. This is the single place a fix becomes an
// edit: the quick-fix provider below and the inline-diff suggestions (remediation/autoFix.js) both use it.
//
// `edit` is optional: pass an existing WorkspaceEdit to add this fix to it (auto-apply batches
// several fixes into one edit). Returns { edit, newText, range } or null when the
// rule has no fix, the fix throws, or it declines (stale/mismatched source).
function buildFixEdit(document, violation, rule, edit) {
  rule = rule || getRuleById(violation.ruleId);
  if (!rule || typeof rule.fix !== 'function') return null;
  // AI-suggested fixes are async and gated: they only ever go through resolveCodeAction below, never here
  // (and never through the inline-diff suggestions, which build their edits with this function).
  if (rule.fixTier === 'ai-suggested') return null;

  let result;
  try {
    result = rule.fix(violation, document.getText());
  } catch (e) {
    console.error(`AccessGen: fix() for ${violation.ruleId} threw:`, e && e.message);
    return null;
  }
  if (!result || typeof result.newText !== 'string') return null;

  const target = edit || new vscode.WorkspaceEdit();
  target.replace(
    document.uri,
    new vscode.Range(
      violation.startLine, violation.startChar,
      violation.endLine, violation.endChar
    ),
    result.newText
  );
  return {
    edit: target, newText: result.newText,
    range: { startLine: violation.startLine, startChar: violation.startChar, endLine: violation.endLine, endChar: violation.endChar }
  };
}

// The WorkspaceEdit for an AI-suggested fix (res = an ok result of aiFixer.resolve). The single place that
// turns one into an edit. needsConfirmation: true makes VS Code show its refactor preview first (the quick
// fix path); the inline-diff path passes false because the inline diff IS the review (Accept applies it).
// The description puts the model's confidence and reasoning next to the change.
function buildAiFixEdit(document, res, rule, { needsConfirmation } = {}) {
  const r = res.range;
  const edit = new vscode.WorkspaceEdit();
  const meta = {
    needsConfirmation: needsConfirmation !== false,
    label: 'AI-suggested ' + (rule.aiFixLabel || 'text'),
    description: 'confidence ' + res.suggestion.confidence.toFixed(2) + ': ' + res.suggestion.reasoning
  };
  edit.replace(document.uri, new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar), res.newText, meta);
  // meta is returned so the edit can be rebuilt at a shifted range (inlineDiff) with the same label and description.
  return { edit, newText: res.newText, meta, range: { startLine: r.startLine, startChar: r.startChar, endLine: r.endLine, endChar: r.endChar } };
}

// ai (optional) enables the AI-suggested quick fixes:
//   ai.enabled()                               -> boolean; false hides them (AI features are off)
//   ai.resolve({ rule, violation, document })  -> Promise<{ status, newText, range, suggestion, ... }>
//                                                 never rejects; shows its own messages for every non-ok status
// Without it (older callers, tests) only the deterministic fixes are offered, exactly as before.
function registerCodeActions(context, ai) {
  // Actions handed out by provideCodeActions that are waiting to be resolved, with what resolving needs.
  const pendingAi = new WeakMap();

  const provider = vscode.languages.registerCodeActionsProvider(
    [
      { language: 'html' },
      { language: 'css' },
      { language: 'javascriptreact' },
      { language: 'typescriptreact' }
    ],
    {
      provideCodeActions(document, range, codeContext) {
        const actions = [];
        const uriString = document.uri.toString();

        for (const diagnostic of codeContext.diagnostics) {
          if (diagnostic.source !== 'AccessGen') continue;

          const ruleId = typeof diagnostic.code === 'object' && diagnostic.code !== null
            ? diagnostic.code.value
            : diagnostic.code;
          // The rule's own fix() when it has one (outline-removed, the alt-text / link-text AI fixes); otherwise the
          // generic AI fixer. Exactly one of them, never both.
          const rule = effectiveFixer(getRuleById(ruleId));
          if (!rule) continue;

          const violation = getFixableViolation(uriString, ruleId, diagnostic.range);
          if (!violation) continue;

          if (rule.fixTier === 'ai-suggested') {
            // A lightweight action with NO edit: building the Quick Fix menu costs nothing and sends
            // nothing. The provider is only called, and the edit only attached, in resolveCodeAction,
            // when the developer selects this specific action. Titled so it cannot be mistaken for a
            // deterministic fix.
            if (!ai || !ai.enabled()) continue;
            const aiAction = new vscode.CodeAction(
              `AccessGen (AI): Suggest ${rule.aiFixLabel || 'text'}`,
              vscode.CodeActionKind.QuickFix
            );
            aiAction.diagnostics = [diagnostic];
            pendingAi.set(aiAction, { document, violation, rule });
            actions.push(aiAction);
            continue;
          }

          const built = buildFixEdit(document, violation, rule);
          if (!built) continue;

          const action = new vscode.CodeAction(
            `AccessGen: Fix ${ruleId} (review inserted values)`,
            vscode.CodeActionKind.QuickFix
          );
          action.edit = built.edit;
          action.diagnostics = [diagnostic];
          actions.push(action);
        }

        return actions;
      },

      // Called by VS Code when the developer selects an action that has no edit yet.
      async resolveCodeAction(action) {
        const state = pendingAi.get(action);
        if (!state || !ai) return action;
        try {
          const res = await ai.resolve({ rule: state.rule, violation: state.violation, document: state.document });
          if (res && res.status === 'ok') {
            // needsConfirmation: VS Code shows its refactor preview (a diff) and applies nothing until the
            // developer accepts it.
            action.edit = buildAiFixEdit(state.document, res, state.rule, { needsConfirmation: true }).edit;
          }
          // Every other status was already reported to the developer by ai.resolve (one line); the action
          // is returned without an edit, so selecting it does nothing rather than applying something broken.
        } catch (e) {
          // ai.resolve does not reject; this is the last line of defence: resolveCodeAction must never throw.
          console.error('AccessGen: AI quick fix failed:', e && e.message ? e.message : e);
        }
        return action;
      }
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  context.subscriptions.push(provider);
}

module.exports = { registerCodeActions, buildFixEdit, buildAiFixEdit };
