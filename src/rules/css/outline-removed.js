const { walkCSS, parseCSS } = require('../../parsers/cssParser');
const { parseColor, getLuminance, getContrastRatio } = require('../shared/colorMath');

function getLoc(node) {
  if (!node.source || !node.source.start) return null;
  const start = node.source.start;
  const end = node.source.end || start;
  return {
    startLine: start.line - 1,
    endLine: end.line - 1,
    startChar: start.column - 1,
    endChar: end.column
  };
}


// ---- box-shadow visibility -------------------------------------------------
// Split on a separator while ignoring anything inside parentheses.
function splitTopLevel(str, sepRe) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sepRe.test(ch)) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

const LENGTH_RE = /^[+-]?(\d*\.\d+|\d+\.?)([a-z%]*)$/;

// true  = color is fully transparent (alpha 0); false = not transparent;
// null  = cannot tell (var(), currentColor, calc...) -> caller gives benefit of the doubt.
function isTransparentColor(token) {
  const t = token.trim().toLowerCase();
  if (t === 'transparent') return true;
  if (t.includes('var(') || t.includes('env(') || t === 'currentcolor') return null;
  let m = t.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);
  if (m) {
    const hex = m[1];
    const alpha = hex.length === 4 ? hex[3] + hex[3] : hex.slice(6, 8);
    return parseInt(alpha, 16) === 0;
  }
  m = t.match(/^(?:rgb|hsl)a?\((.*)\)$/);
  if (m) {
    const inner = m[1].trim();
    let alpha = null;
    if (inner.includes('/')) alpha = inner.split('/')[1].trim();
    else if (inner.includes(',')) {
      const comps = inner.split(',').map(c => c.trim());
      if (comps.length === 4) alpha = comps[3];
    }
    if (alpha === null) return false;
    const n = alpha.endsWith('%') ? parseFloat(alpha) : parseFloat(alpha) * 100;
    return Number.isNaN(n) ? null : n === 0;
  }
  return false;
}

// One shadow layer: [inset] <x> <y> [blur] [spread] [color] (color may lead or trail).
// Invisible = color fully transparent, OR offset-x, offset-y, blur and spread are ALL zero.
// A zero-blur/zero-spread layer with a non-zero offset (0 2px 0 red) still paints a
// hard-edged shadow, so it counts as visible.
function isVisibleShadowLayer(layer) {
  const tokens = splitTopLevel(layer, /\s/).filter(t => t.toLowerCase() !== 'inset');
  const lengths = [];
  const rest = [];
  for (const t of tokens) (LENGTH_RE.test(t) ? lengths : rest).push(t);

  // Lengths we can't resolve statically (calc(), or a var() that may hide them):
  // assume the author's intent rather than risk a false positive.
  const lenUnknown = rest.some(t => /^(calc|min|max|clamp)\(/i.test(t)) ||
    (rest.some(t => /^var\(/i.test(t)) && lengths.length < 3);
  if (lenUnknown) return true;

  const allZero = [0, 1, 2, 3].every(i => lengths.length <= i || parseFloat(lengths[i]) === 0);
  if (allZero) return false;

  const colorToken = rest.find(t => !/^(calc|min|max|clamp)\(/i.test(t));
  if (colorToken === undefined) return true; // default color is currentColor
  return isTransparentColor(colorToken) !== true;
}

function isVisibleBoxShadow(value) {
  if (!value || value === 'none') return false;
  return splitTopLevel(value, /,/).some(isVisibleShadowLayer);
}

function isZeroLength(value) {
  const m = value.trim().match(LENGTH_RE);
  return !!m && parseFloat(value) === 0;
}


// ---- outline state, evaluated in source order ------------------------------
const OUTLINE_STYLES = new Set(['none', 'hidden', 'auto', 'dotted', 'dashed', 'solid',
  'double', 'groove', 'ridge', 'inset', 'outset']);
const NO_STYLE = new Set(['none', 'hidden']);

// Resolve what the block's outline finally looks like by applying outline,
// outline-style, outline-width and outline-color in declaration order. The `outline`
// shorthand resets every sub-property it omits (style -> none, width -> medium,
// color -> currentColor), so a later outline-width cannot revive an `outline: none`.
// null for style/width means "unknown" (var()/calc()) and is treated as visible.
function resolveOutline(rule) {
  const st = { style: 'none', width: 'medium', transparent: false };
  rule.each((decl) => {
    if (decl.type !== 'decl') return;
    const prop = decl.prop.toLowerCase();
    const value = (decl.value || '').trim().toLowerCase();
    if (prop === 'outline') {
      st.style = 'none'; st.width = 'medium'; st.transparent = false;
      for (const tok of splitTopLevel(value, /\s/)) {
        if (/^(var|calc|min|max|clamp|env)\(/.test(tok)) { st.style = null; st.width = null; }
        else if (OUTLINE_STYLES.has(tok)) st.style = tok;
        else if (LENGTH_RE.test(tok)) st.width = parseFloat(tok) === 0 ? 0 : tok;
        else if (tok === 'transparent') st.transparent = true;
      }
    } else if (prop === 'outline-style') {
      st.style = /(var|calc|env)\(/.test(value) ? null : value;
    } else if (prop === 'outline-width') {
      if (/(var|calc|min|max|clamp|env)\(/.test(value)) st.width = null;
      else st.width = LENGTH_RE.test(value) && parseFloat(value) === 0 ? 0 : value;
    } else if (prop === 'outline-color') {
      st.transparent = value === 'transparent';
    }
  });
  return st;
}

function outlineIsVisible(st) {
  if (st.transparent) return false;
  if (st.style !== null && NO_STYLE.has(st.style)) return false;
  if (st.width === 0) return false;
  return true;
}

// ---- choosing the replacement outline color ----------------------------------------------------
// The fix only exists when its color can be COMPUTED: the same rule block must contain a literal
// background-color, and the outline is the black or white that clears the contrast minimum against it.
// Otherwise there is no fix at all (fix() returns null) instead of a guess.
//
// 3:1 is the WCAG 1.4.11 non-text (UI component) minimum, not the 4.5:1 text threshold: this is a
// focus outline, not text.
//
// WHY THE RING IS INSET. An outline is painted outside its "outline edge", and outline-offset moves
// that edge relative to the element's border edge. With a ring of width W and offset -W, the ring
// covers exactly the outer W pixels INSIDE the border box and nothing beyond it. So the page behind
// the element is irrelevant, and the surface the ring is drawn over is the element's own box: its
// background-color (plus its border, if any, and the outer edge of its padding). An outset ring would
// instead sit on whatever is behind the element, which a stylesheet rule cannot see.
//
// That makes the 3:1 a real guarantee only while the element's own box really is that flat
// background-color, so the fix is withheld (null) when the SAME block shows otherwise: a background
// image/gradient or the background shorthand (paints over or resets the color), or a border at least
// as thick as the ring (the ring would be drawn over the border color). Rules elsewhere in the
// stylesheet that style the same element's border or background are invisible to this check.
const OUTLINE_MIN_CONTRAST = 3;
const OUTLINE_CANDIDATES = ['#000000', '#ffffff'];
const OUTLINE_WIDTH_PX = 2;
const OUTLINE_OFFSET_PX = -OUTLINE_WIDTH_PX; // inset by exactly the ring width: ring ends at the border edge

function outlineFixText(color) {
  return 'outline: ' + OUTLINE_WIDTH_PX + 'px solid ' + color + '; outline-offset: ' + OUTLINE_OFFSET_PX + 'px;';
}

// The background-color declaration that wins inside one rule block: the last one, except that an
// !important declaration beats a later normal one.
function effectiveBackground(ruleNode) {
  let chosen = null;
  ruleNode.each((decl) => {
    if (decl.type !== 'decl' || decl.prop.toLowerCase() !== 'background-color') return;
    if (!chosen || decl.important || !chosen.important) chosen = decl;
  });
  return chosen;
}

// Would a border declared in this block lie under the ring? The ring covers the outer OUTLINE_WIDTH_PX
// of the border box, so a visible border at least that thick means the ring is drawn over the border
// color. Only the longhands are inspected: a non-trivial `border` shorthand already counts as a
// compensating style, so such blocks never reach the fix. A border needs a style to exist at all
// (the initial style is none); a style with no width is the initial "medium" (3px); a width in a unit
// we cannot evaluate is treated as thick, because the safe answer is "no fix".
function hasBorderUnderRing(ruleNode) {
  let styled = false;
  let widthDeclared = false;
  let thick = false;
  ruleNode.each((decl) => {
    if (decl.type !== 'decl') return;
    const prop = decl.prop.toLowerCase();
    const value = decl.value.trim().toLowerCase();
    if (/^border(-(top|right|bottom|left))?-style$/.test(prop)) {
      if (value.split(/\s+/).some(t => t && t !== 'none' && t !== 'hidden')) styled = true;
    } else if (/^border(-(top|right|bottom|left))?-width$/.test(prop)) {
      widthDeclared = true;
      for (const t of value.split(/\s+/)) {
        if (t === 'thin' || t === '0') continue;
        const px = t.match(/^(\d*\.?\d+)px$/);
        if (px) { if (parseFloat(px[1]) >= OUTLINE_WIDTH_PX) thick = true; continue; }
        if (t === 'medium' || t === 'thick') { thick = true; continue; }
        if (/^0(\.0+)?[a-z%]*$/.test(t)) continue;
        thick = true; // em/rem/var()/calc()/...: cannot be evaluated
      }
    }
  });
  if (!styled) return false;
  return widthDeclared ? thick : true; // style without a width is "medium", which is thicker than the ring
}

// -> { ok: true, color, ratio, background }
//  | { ok: false, reason: 'no-background' | 'shorthand' | 'image' | 'border' | 'not-static' | 'no-contrast', value? }
function planOutlineColor(ruleNode) {
  if (!ruleNode || ruleNode.type !== 'rule') return { ok: false, reason: 'no-background' };
  const bg = effectiveBackground(ruleNode);

  // `background: #000` may well be a literal color, but the shorthand can carry images, gradients and
  // positions, and a shorthand after a background-color resets it, so it is never evaluated.
  let shorthand = false;
  let image = null;
  ruleNode.each((decl) => {
    if (decl.type !== 'decl') return;
    const prop = decl.prop.toLowerCase();
    if (prop === 'background') shorthand = true;
    if (prop === 'background-image' && !/^\s*none\s*$/i.test(decl.value)) image = decl.value.trim();
  });
  if (!bg) return { ok: false, reason: shorthand ? 'shorthand' : 'no-background' };
  if (shorthand) return { ok: false, reason: 'shorthand' };
  if (image !== null) return { ok: false, reason: 'image', value: image };
  if (hasBorderUnderRing(ruleNode)) return { ok: false, reason: 'border' };

  // var(), currentColor, transparent, hsl(), rgba(), gradients and unlisted named colors all parse
  // to null, as do out-of-range rgb() channels (parseColor itself does not range-check).
  const rgb = parseColor(bg.value);
  if (!rgb || ![rgb.r, rgb.g, rgb.b].every(n => n >= 0 && n <= 255)) {
    return { ok: false, reason: 'not-static', value: bg.value.trim() };
  }

  const bgLum = getLuminance(rgb.r, rgb.g, rgb.b);
  const passing = OUTLINE_CANDIDATES
    .map((hex) => { const c = parseColor(hex); return { hex, ratio: getContrastRatio(getLuminance(c.r, c.g, c.b), bgLum) }; })
    .filter(c => c.ratio >= OUTLINE_MIN_CONTRAST)
    .sort((a, b) => b.ratio - a.ratio); // if both clear it, the more visible one wins
  if (!passing.length) return { ok: false, reason: 'no-contrast' }; // cannot happen with black and white; defensive
  return { ok: true, color: passing[0].hex, ratio: Math.round(passing[0].ratio * 100) / 100, background: bg.value.trim() };
}

// Shown in the hover when no quick fix will be offered, so the missing fix is explained.
function noFixNote(plan) {
  let why;
  if (plan.reason === 'no-background') why = 'this rule has no background-color';
  else if (plan.reason === 'shorthand') why = 'it sets the background shorthand, which can carry an image or reset the color, so it is not evaluated; use background-color alone';
  else if (plan.reason === 'image') why = 'it also sets a background image (' + plan.value + '), which is painted over the background-color';
  else if (plan.reason === 'border') why = 'it sets a border at least as thick as the focus ring, so the ring would be drawn over the border color instead of the background-color';
  else if (plan.reason === 'not-static') why = 'its background-color (' + plan.value + ') is not a plain #hex, rgb() or basic named color';
  else why = 'neither black nor white clears the contrast minimum against it';
  return ' No automatic fix is offered: the background color is not statically determinable here (' + why +
    '), so a visible outline color cannot be chosen safely. Pick one with at least ' + OUTLINE_MIN_CONTRAST +
    ':1 contrast against the surface the outline is drawn on.';
}

module.exports = {
  id: 'outline-removed',
  language: 'css',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 2.4.7 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkCSS(ast, (node) => {
      if (node.type !== 'decl') return;

      const prop = node.prop;
      const value = node.value ? node.value.trim().toLowerCase() : '';

      const isOutlineRemoved =
        (prop === 'outline' && (value === 'none' || value === '0')) ||
        (prop === 'outline-width' && value === '0');

      if (!isOutlineRemoved) return;

      const parent = node.parent;
      if (!parent || parent.type !== 'rule') return;

      let hasCompensatingStyle = false;
      parent.walkDecls((decl) => {
        const dp = decl.prop.toLowerCase();
        const dv = decl.value ? decl.value.trim().toLowerCase() : '';

        if (dp === 'box-shadow' && isVisibleBoxShadow(dv)) {
          hasCompensatingStyle = true;
        }
        if (dp === 'border' && dv && dv !== 'none' && dv !== '0') {
          hasCompensatingStyle = true;
        }
      });

      // outline-color / outline-width / outline-style only matter through the outline
      // they finally produce. `outline: none; outline-width: 2px; outline-color: red`
      // still draws nothing because the style stays none. A later explicit style
      // (outline-style: solid, or a full `outline: 2px solid red`) restores it.
      if (outlineIsVisible(resolveOutline(parent))) hasCompensatingStyle = true;

      if (hasCompensatingStyle) return;

      const selector = parent.selector || '';
      const isFocusContext = selector.includes(':focus') || selector.includes(':focus-visible');
      const severity = isFocusContext ? 'critical' : 'critical';

      const loc = getLoc(node);
      if (!loc) return;

      const plan = planOutlineColor(parent);
      const fixText = plan.ok
        ? 'Never remove outline without providing an equally visible focus style. Replace with: ' + outlineFixText(plan.color) +
          ' (' + plan.color + ' has ' + plan.ratio + ':1 contrast against this rule\'s background-color ' + plan.background +
          '; the negative outline-offset draws the ring just inside the element\'s edge, over that background, instead of outside it, so the page behind does not matter), or use a box-shadow replacement that is visible on all backgrounds.'
        : "Never remove outline without providing an equally visible focus style. Replace with: outline: 2px solid #0066cc; outline-offset: -2px; or use a box-shadow replacement that is visible on all backgrounds." + noFixNote(plan);

      violations.push({
        ruleId: 'outline-removed',
        severity: severity,
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'Focus outline is removed with no visible replacement.',
          why: 'Keyboard users rely on the focus indicator to know which element is currently selected. Removing it makes the page completely unnavigable for keyboard and switch access users.',
          fix: fixText,
          wcag: 'WCAG 2.1 - 2.4.7 (Level AA)'
        }
      });
    });

    return violations;
  },

  // fixTier says whether this fix may ever run without a click (see remediationMode):
  //   'safe'   additive, no behaviour change - a straight value swap
  //   'medium' behaviour-adding; needs a human to choose between options
  // A fix() with no fixTier is NEVER auto-applied, in any mode: a fixer must be tiered explicitly.
  // This fix is 'safe' because it is computed, not guessed: it only exists when the rule block has a
  // literal background-color, and the outline color is black or white, whichever clears 3:1 against it
  // (see planOutlineColor, including its note on which surface that is measured against).
  fixTier: 'safe',

  // Optional contract: fix(violation, sourceCode) -> { newText } replacing the
  // violation's startLine/startChar..endLine/endChar range, or null if the
  // source no longer matches the violation (stale diagnostic).
  // Returns null (no fix offered) when the background color of the same rule block cannot be
  // determined statically; the hover on the violation explains why (see noFixNote).
  fix(violation, sourceCode) {
    if (violation.startLine !== violation.endLine) return null;
    const line = sourceCode.split(/\r\n|\r|\n/)[violation.startLine];
    if (line === undefined) return null;
    const current = line.slice(violation.startChar, violation.endChar);
    if (!/^outline(-width)?\s*:/i.test(current)) return null;

    // The color depends on the rule block's background, so find this declaration's rule in the
    // CURRENT source (the scan may be stale by the time a fix is requested).
    const ast = parseCSS(sourceCode);
    if (!ast) return null;
    let decl = null;
    ast.walkDecls((d) => {
      if (!decl && d.source && d.source.start && d.source.start.line - 1 === violation.startLine && d.source.start.column - 1 === violation.startChar) decl = d;
    });
    if (!decl || !decl.parent || decl.parent.type !== 'rule') return null;

    const plan = planOutlineColor(decl.parent);
    if (!plan.ok) return null;
    return { newText: outlineFixText(plan.color) };
  }
};
