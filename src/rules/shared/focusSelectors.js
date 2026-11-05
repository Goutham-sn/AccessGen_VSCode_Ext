// Focus-style patterns that are correct, so the focus rules must not report them.
//   ::-moz-focus-inner and other pseudo-elements      not the focus ring of the element
//   :focus:not(:focus-visible)                         the recommended way to hide the ring for mouse users only
//   [tabindex="-1"]:focus                              programmatic focus targets (skip links, headings), never tabbed to
//   :focus with a matching :focus-visible rule that draws a visible indicator elsewhere in the file

const splitSelectors = (sel) => String(sel || '').split(',').map(s => s.trim()).filter(Boolean);

function exemptSelector(sel) {
  return /::/.test(sel) || /:not\(\s*:focus-visible\s*\)/.test(sel) || /\[tabindex\s*=\s*["']?-1["']?\]/.test(sel);
}

const baseOf = (sel) => sel.replace(/:focus-visible|:focus(?!-)/g, '').replace(/\s+/g, ' ').trim();

function drawsIndicator(rule) {
  let visible = false;
  rule.walkDecls((d) => {
    const p = d.prop.toLowerCase(), v = String(d.value || '').trim().toLowerCase();
    if ((p === 'outline' || p === 'outline-style') && v && !/^(none|0|0px)$/.test(v)) visible = true;
    if (p === 'box-shadow' && v && v !== 'none') visible = true;
    // A border counts; a background or text color does not: it may look the same when unfocused.
    if ((p === 'border' || p === 'border-color' || p === 'border-width') && v && !/^(none|0|0px)$/.test(v)) visible = true;
  });
  return visible;
}

// Base selector (":focus" removed) -> the :focus-visible rules that draw a visible indicator for it.
function restoredBases(root) {
  const out = new Map();
  root.walkRules((r) => {
    for (const sel of splitSelectors(r.selector)) {
      if (!/:focus-visible/.test(sel) || !drawsIndicator(r)) continue;
      const base = baseOf(sel);
      if (!out.has(base)) out.set(base, []);
      out.get(base).push(r);
    }
  });
  return out;
}

// Every selector of the rule is one of the correct patterns above, or a :focus rule whose indicator ANOTHER rule
// (a :focus-visible rule for the same element) draws. A rule never restores the outline it removes itself.
function allExempt(rule, restored) {
  const sels = splitSelectors(rule.selector);
  const restoredElsewhere = (sel) => /:focus/.test(sel) && (restored.get(baseOf(sel)) || []).some(r => r !== rule);
  return sels.length > 0 && sels.every(sel => exemptSelector(sel) || restoredElsewhere(sel));
}

module.exports = { splitSelectors, exemptSelector, baseOf, restoredBases, allExempt, drawsIndicator };
