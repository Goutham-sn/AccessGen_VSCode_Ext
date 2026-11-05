// One generic AI fixer for ANY rule that has no fix() of its own.
//
// effectiveFixer(rule) is the single place that decides which fixer a rule gets:
//   - a rule that exports fix()  -> the rule itself, untouched (outline-removed's deterministic fix, and the
//                                   specialised alt-text / link-text AI fixes). The generic fixer is NEVER added next to it.
//   - any other rule             -> a generic fixer: { id, language, fixTier: 'ai-suggested', aiFixLabel: 'fix', fix }.
//
// The generic fix() has the same contract as the specialised AI fixes (see aiFixer.js), so everything built for them
// applies unchanged: lazy quick fix, consent gates, cache + in-flight de-dupe, tracker identity, per-run cap,
// debounce, inline diff, Accept / Dismiss. Its tier is always 'ai-suggested': it is never applied without Accept.
//
// Nothing here trusts the model's reply to be good. Before a suggestion is offered it must (1) differ from the code
// it replaces, (2) leave the file parseable, and (3) actually reduce the number of violations of this rule when the
// rule's own check is run on the edited text. A guess that fails any of these is reported as "unavailable" and no
// edit is produced - the same as when there is nothing to go on.

const { analyzeDocument } = require('../analyzer');
const { buildGenericRequest, lineStarts, offsetOf } = require('../rules/shared/genericContext');
const { parseJSX } = require('../parsers/jsxParser');
const { parseCSS } = require('../parsers/cssParser');

const LANGUAGE_IDS = { html: 'html', jsx: 'javascriptreact', css: 'css' };
const cache = new WeakMap(); // rule -> generic fixer

function applyReplacement(source, violation, newText) {
  const starts = lineStarts(source);
  const s = offsetOf(starts, source, violation.startLine, violation.startChar);
  const e = offsetOf(starts, source, violation.endLine, violation.endChar);
  return source.slice(0, s) + newText + source.slice(e);
}

// Does the edited file still parse? (parse5 accepts anything; babel records recoverable errors; postcss throws.)
function parsesNoWorse(language, before, after) {
  if (language === 'css') return !!parseCSS(after);
  if (language === 'jsx') {
    const a = parseJSX(after);
    if (!a) return false;
    const b = parseJSX(before);
    return (a.errors ? a.errors.length : 0) <= (b && b.errors ? b.errors.length : 0);
  }
  return true;
}

async function countViolations(rule, language, source, config) {
  const doc = { getText: () => source, languageId: LANGUAGE_IDS[language] };
  const found = await analyzeDocument(doc, { complianceLevel: 'AA', isRuleDisabled: () => false, isTrustedComponent: () => false, ...(config || {}) });
  return found.filter(v => v.ruleId === rule.id).length;
}

function createGenericFixer(rule) {
  return {
    id: rule.id,
    language: rule.language,
    wcag: rule.wcag,
    generic: true,
    fixTier: 'ai-suggested',
    aiFixLabel: 'fix',      // quick fix title: "AccessGen (AI): Suggest fix"
    aiFixPhrase: 'a fix',   // "not enough context to suggest a fix for this element"
    async fix(violation, sourceCode, services) {
      const request = buildGenericRequest(violation, sourceCode, rule.language);
      if (request.tooLarge) return { unavailable: 'the flagged code is too large for an AI fix. Fix it by hand.' };

      // services.generate throws (and the caller reports "not enough context") on an empty or low-confidence reply.
      const suggestion = await services.generate({
        kind: 'generic-fix',
        content: request.flagged,
        path: 'generic',
        // Everything that shapes the answer is in the cache key, so a changed context asks again.
        context: { ruleId: rule.id, what: request.message.what, context: request.context },
        violation,
        sourceCode
      });

      const newText = suggestion.suggestedText;
      if (newText === request.flagged) return { unavailable: 'the AI suggestion is identical to the existing code, so there is nothing to apply.' };

      const edited = applyReplacement(sourceCode, violation, newText);
      if (!parsesNoWorse(rule.language, sourceCode, edited)) {
        return { unavailable: 'the AI suggestion would leave the file with a syntax error, so it was not offered.' };
      }
      const config = services.config;
      const before = await countViolations(rule, rule.language, sourceCode, config);
      const after = await countViolations(rule, rule.language, edited, config);
      if (!(after < before)) {
        return { unavailable: 'the AI suggestion would not resolve ' + rule.id + ', so it was not offered. This one needs a hand-written fix.' };
      }

      return {
        newText,
        range: { startLine: violation.startLine, startChar: violation.startChar, endLine: violation.endLine, endChar: violation.endChar },
        suggestion
      };
    }
  };
}

function effectiveFixer(rule) {
  if (!rule) return null;
  if (typeof rule.fix === 'function') return rule;
  let fixer = cache.get(rule);
  if (!fixer) { fixer = createGenericFixer(rule); cache.set(rule, fixer); }
  return fixer;
}

module.exports = { effectiveFixer, createGenericFixer, applyReplacement };
