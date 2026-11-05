// Picks the elements that are "structurally present but unverifiable": they PASSED the
// deterministic rule (so they produced no violation), but what they say cannot be judged
// by logic - alt text that may not describe the image, link text that may still be vague in
// context, heading text that may not be descriptive. These are the only inputs an AI
// review would ever see.
//
// Because a passing element has no violation, candidates cannot be found by filtering the
// violations list; the selector walks the parsed AST. The violations list is used the other
// way round: an element that the matching structural rule already flagged (missing alt,
// empty link, empty heading) is a structural miss, not a judgment case, and is excluded.
//
// A cheap pre-filter then drops content that is obviously fine, so only plausibly ambiguous
// text reaches a reviewer. Every threshold is a named constant below; tune them there.
//
// selectCandidates({ violations, ast, languageId, config }) -> Candidate[]
//   Candidate = { ruleId, kind, content, source, location, path, context, wcag, element }
//     ruleId   the structural rule the element passed (img-alt-missing, jsx-anchor-no-content, ...)
//     kind     'image-alt' | 'link-text' | 'heading-text'
//     content  the resolved name / text a reviewer would judge
//     source   where that content came from ('alt', 'aria-label', 'aria-labelledby', 'content', 'title')
//     location { startLine, endLine, startChar, endChar }, same convention as violations (display only)
//     path     structural identity, e.g. "html[0]>body[0]>a[2]": tag + index among same-tag siblings.
//              Stable when unrelated lines are inserted or removed; used by changeTracker.
//     context  the minimal extra information a reviewer is allowed to see, by kind:
//                image-alt    { figcaption?, nearestHeading? }
//                link-text    { href? }   (query string / credentials stripped, mailto/tel reduced to the scheme)
//                heading-text { level? }
//     wcag     the structural rule's criterion string
//
// CRITERIA is deliberately a small hardcoded starting set; add rows to expand it.

const { walkNode } = require('../parsers/htmlParser');
const { walkJSX } = require('../parsers/jsxParser');
const { getAccessibleName } = require('../rules/shared/accessibleName');
const { getJsxAccessibleName, findAttr, attrValue } = require('../rules/shared/jsxAccessibleName');
const { isGenericLinkText, isUrlLinkText } = require('../rules/shared/genericLinkText');
const { getRuleById, shouldRunAtLevel } = require('../analyzer');
// Per-element context helpers live in a shared module: the AI-suggested fixes use the same ones.
const {
  HEADING_TAGS, clipText, sanitizeHref, pick, htmlFigcaption, htmlPath, jsxTagName, buildJsxInfo
} = require('../rules/shared/elementContext');

// ---------------------------------------------------------------------------------------
// Pre-filter thresholds. "Skip" means the content is treated as clearly fine and is NOT
// returned as a candidate. Words are whitespace-separated tokens containing a letter/digit.
// ---------------------------------------------------------------------------------------

// Link text: skip when it has at least this many words AND at least this many characters
// AND matches none of the vague patterns. ("About our team" is skipped; "Contact us" and
// "Home" stay candidates because they are under the word floor.)
const LINK_MIN_WORDS_TO_SKIP = 3;
const LINK_MIN_CHARS_TO_SKIP = 10;
// Long link text that is still vague. The exact generic phrases and bare URLs are already
// structural failures (anchor-no-text); these catch longer variants that merely start or end
// that way, so they remain candidates despite their length.
const LINK_VAGUE_PATTERNS = [
  /\b(click|tap) (here|this)\b/i,   // "Click here to read the report"
  /^here\b/i,                       // "here is the form"
  /\b(this|that) (link|page)\b/i,   // "see this page"
  /^(read|learn|see|view) more\b/i, // "Read more about WCAG"
  /^more\b/i,                       // "more info"
  /^link\b/i                        // "link to our pricing"
];

// Alt text: skip when it has at least this many words (sentence-like) AND neither looks like
// a filename nor reuses the image's own file name. Alt text under the floor (1-3 words:
// "image", "photo", "icon", "Team photo") always stays a candidate.
const ALT_MIN_WORDS_TO_SKIP = 4;
const ALT_FILENAME_PATTERN = /\.(jpe?g|png|gif|svg|webp|bmp|avif|tiff?|ico|heic)\b/i;
// File-name reuse check: the src's stem ("IMG_1234", "team-photo-2024") appearing inside the
// alt text keeps it a candidate. A stem shorter than ALT_MIN_STEM_LENGTH is ignored, and so is a
// stem that is a single plain word ("team.jpg", "logo.png"): ordinary words appear in
// descriptive alt text all the time, so only stems that look like file names count (they
// contain a digit, or several words joined by -, _ or .).
const ALT_MIN_STEM_LENGTH = 3;
const ALT_STEM_MUST_LOOK_LIKE_FILENAME = true;

// Heading text: skip when it has at least this many words. Single-word headings stay
// candidates (more likely to be non-descriptive: "Welcome", "Overview", "Section").
const HEADING_MIN_WORDS_TO_SKIP = 2;

const CRITERIA = {
  'image-alt': { html: 'img-alt-missing', jsx: 'jsx-img-alt-missing' },
  'link-text': { html: 'anchor-no-text', jsx: 'jsx-anchor-no-content' },
  'heading-text': { html: 'heading-empty', jsx: 'jsx-heading-empty' }
};


function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

const normalizeStem = (s) => String(s).toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

// The image's file-name stem from its src ("/img/Team-Photo_2024.jpg?v=2" -> "team photo 2024").
function stemOfSrc(src) {
  if (!src) return '';
  const file = String(src).split(/[?#]/)[0].split('/').pop() || '';
  return normalizeStem(file.replace(/\.[a-z0-9]{2,5}$/i, ''));
}

// true when the content is obviously fine and should not reach a reviewer
function isClearlyFine(kind, content, ctx) {
  const words = wordCount(content);
  if (kind === 'link-text') {
    return words >= LINK_MIN_WORDS_TO_SKIP &&
      content.trim().length >= LINK_MIN_CHARS_TO_SKIP &&
      !LINK_VAGUE_PATTERNS.some(re => re.test(content.trim()));
  }
  if (kind === 'image-alt') {
    if (words < ALT_MIN_WORDS_TO_SKIP) return false;
    if (ALT_FILENAME_PATTERN.test(content)) return false;
    const stem = stemOfSrc(ctx && ctx.src);
    const stemUsable = stem.length >= ALT_MIN_STEM_LENGTH &&
      (!ALT_STEM_MUST_LOOK_LIKE_FILENAME || /\d/.test(stem) || stem.includes(' '));
    if (stemUsable && normalizeStem(content).includes(stem)) return false;
    return true;
  }
  if (kind === 'heading-text') return words >= HEADING_MIN_WORDS_TO_SKIP;
  return false;
}

function dialectOf(languageId) {
  if (languageId === 'html') return 'html';
  if (languageId === 'javascriptreact' || languageId === 'typescriptreact') return 'jsx';
  return null;
}

function htmlAttr(node, name) {
  return (node.attrs || []).find(a => a.name === name);
}

function htmlLoc(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  const tag = loc.startTag || loc;
  return {
    startLine: tag.startLine - 1,
    endLine: (tag.endLine || tag.startLine) - 1,
    startChar: tag.startCol - 1,
    endChar: (tag.endCol || tag.startCol + 10) - 1
  };
}

function jsxLoc(loc) {
  if (!loc) return null;
  return {
    startLine: loc.start.line - 1,
    endLine: loc.end.line - 1,
    startChar: loc.start.column,
    endChar: loc.end.column
  };
}

function headingLevelOf(tag, ariaLevel) {
  if (HEADING_TAGS.includes(tag)) return Number(tag[1]);
  const n = parseInt(ariaLevel, 10);
  return n >= 1 && n <= 6 ? n : undefined;
}

const locKey = (ruleId, loc) => `${ruleId}@${loc.startLine}:${loc.startChar}`;

function selectCandidates({ violations, ast, languageId, config }) {
  const dialect = dialectOf(languageId);
  if (!dialect || !ast) return [];
  config = config || {};

  const flagged = new Set((violations || []).map(v => locKey(v.ruleId, v)));
  const candidates = [];

  // A criterion is live only if its structural rule would run (enabled, level in scope).
  const live = {};
  for (const [kind, ids] of Object.entries(CRITERIA)) {
    const ruleId = ids[dialect];
    const rule = getRuleById(ruleId);
    live[kind] = !!rule &&
      !(config.isRuleDisabled && config.isRuleDisabled(ruleId)) &&
      shouldRunAtLevel(rule.wcag, config.complianceLevel || 'AA');
  }

  // ctx: { src } for image candidates (file-name reuse check); context: what a reviewer may see.
  function add(kind, loc, content, source, element, path, ctx, context) {
    if (!live[kind] || !loc || !content) return;
    const ruleId = CRITERIA[kind][dialect];
    if (flagged.has(locKey(ruleId, loc))) return; // structural miss, not a judgment case
    if (isClearlyFine(kind, content, ctx)) return; // cheap pre-filter: nothing ambiguous to judge
    candidates.push({ ruleId, kind, content, source, location: loc, path, context: context || {}, wcag: getRuleById(ruleId).wcag, element });
  }

  if (dialect === 'html') {
    let lastHeading; // nearest preceding heading text, in document order
    walkNode(ast, (node) => {
      if (!node.tagName) return;
      const tag = node.tagName;

      if (tag === 'img') {
        const role = htmlAttr(node, 'role');
        if (role && ['presentation', 'none'].includes(role.value.trim().toLowerCase())) return;
        const alt = htmlAttr(node, 'alt');
        if (!alt || !alt.value.trim()) return; // absent or empty alt is a structural matter
        const name = getAccessibleName(node, ast);
        const src = htmlAttr(node, 'src');
        add('image-alt', htmlLoc(node), name.name, name.source === 'content' ? 'alt' : name.source, 'img',
          htmlPath(node), { src: src && src.value },
          pick({ figcaption: htmlFigcaption(node, ast), nearestHeading: lastHeading }));
      } else if (tag === 'a') {
        const name = getAccessibleName(node, ast);
        if (isGenericLinkText(name.name) || isUrlLinkText(name.name)) return; // already a known failure
        const href = htmlAttr(node, 'href');
        add('link-text', htmlLoc(node), name.name, name.source, 'a', htmlPath(node), undefined,
          pick({ href: sanitizeHref(href && href.value) }));
      } else {
        const role = htmlAttr(node, 'role');
        const isHeading = HEADING_TAGS.includes(tag) ||
          (role && role.value.trim().toLowerCase() === 'heading');
        if (!isHeading) return;
        const name = getAccessibleName(node, ast);
        const ariaLevel = htmlAttr(node, 'aria-level');
        add('heading-text', htmlLoc(node), name.name, name.source, tag, htmlPath(node), undefined,
          pick({ level: headingLevelOf(tag, ariaLevel && ariaLevel.value) }));
        if (name.name) lastHeading = clipText(name.name);
      }
    });
    return candidates;
  }

  const info = buildJsxInfo(ast);
  walkJSX(ast, (node) => {
    if (node.type !== 'JSXElement' || !node.openingElement) return;
    const opening = node.openingElement;
    if (!opening.name || opening.name.type !== 'JSXIdentifier') return;
    const rawName = opening.name.name;
    const tag = rawName.toLowerCase();

    if (tag === 'img') {
      if (config.isTrustedComponent && config.isTrustedComponent(rawName)) return;
      const role = attrValue(findAttr(opening, 'role'));
      if (role.state === 'static' && ['presentation', 'none'].includes(role.text.trim().toLowerCase())) return;
      const alt = attrValue(findAttr(opening, 'alt'));
      if (alt.state !== 'static' || !alt.text.trim()) return; // dynamic alt has no string to judge
      const aria = getJsxAccessibleName(opening, ast, { content: false, title: false });
      if (aria.unknown) return;
      const src = attrValue(findAttr(opening, 'src'));
      add('image-alt', jsxLoc(opening.loc), aria.name || alt.text.trim(), aria.name ? aria.source : 'alt', rawName,
        info.get(node).path, { src: src.state === 'static' ? src.text : '' },
        pick({ figcaption: info.get(node).figcaption, nearestHeading: info.get(node).nearestHeading }));
    } else if (tag === 'a' && rawName === 'a') {
      const r = getJsxAccessibleName(node, ast);
      if (r.unknown) return;
      if (isGenericLinkText(r.name) || isUrlLinkText(r.name)) return;
      const href = attrValue(findAttr(opening, 'href'));
      add('link-text', jsxLoc(opening.loc || node.loc), r.name, r.source, 'a', info.get(node).path, undefined,
        pick({ href: href.state === 'static' ? sanitizeHref(href.text) : undefined }));
    } else if (HEADING_TAGS.includes(tag)) {
      const r = getJsxAccessibleName(node, ast, { title: false });
      if (r.unknown) return;
      add('heading-text', jsxLoc(opening.loc || node.loc), r.name, r.source, rawName, info.get(node).path, undefined,
        pick({ level: Number(tag[1]) }));
    }
  });
  return candidates;
}

module.exports = {
  selectCandidates, CRITERIA,
  thresholds: {
    LINK_MIN_WORDS_TO_SKIP, LINK_MIN_CHARS_TO_SKIP, LINK_VAGUE_PATTERNS,
    ALT_MIN_WORDS_TO_SKIP, ALT_FILENAME_PATTERN, ALT_MIN_STEM_LENGTH, ALT_STEM_MUST_LOOK_LIKE_FILENAME,
    HEADING_MIN_WORDS_TO_SKIP
  }
};
