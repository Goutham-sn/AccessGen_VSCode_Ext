// What WCAG actually requires of link text, shared by anchor-no-text (HTML) and jsx-anchor-no-content (JSX).
//
//   no accessible name at all            -> fails 4.1.2 / 2.4.4 (Level A): critical
//   generic phrase ("click here", "more") and the sentence / list item / cell around the link does not explain it
//                                        -> fails 2.4.4 Link Purpose (In Context) (Level A): warning
//   generic phrase whose context explains it ("For pricing, click here.")
//                                        -> passes 2.4.4; fails only 2.4.9 Link Purpose (Link Only) (Level AAA)
//   a URL or domain as the text ("www.example.com")
//                                        -> passes: the text says exactly where the link goes
// An <a> without href (and without role="link") is not a link, so none of this applies to it.

const CONTEXT_BLOCKS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', 'figcaption', 'blockquote', 'caption', 'label', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// At least two real words: enough for a sentence to say what the link is about.
function explains(text) {
  return (String(text || '').match(/[\p{L}\p{N}]{2,}/gu) || []).length >= 2;
}

const MESSAGES = {
  empty: {
    what: 'This link has no text, so it has no accessible name.',
    why: 'Screen readers announce it as just "link" (or read the URL), so users cannot tell where it goes.',
    fix: "Add link text, or for an icon-only link add aria-label='Where the link goes' and hide the icon with aria-hidden='true'.",
    wcag: 'WCAG 2.1 - 2.4.4 (Level A)'
  },
  generic: {
    what: 'The link text is a generic phrase and nothing around it says where it goes.',
    why: 'Screen reader users who jump between links hear the same "click here" or "read more" with no clue to the destination.',
    fix: "Make the link text say where it goes, e.g. <a href='/pricing'>See pricing plans</a>.",
    wcag: 'WCAG 2.1 - 2.4.4 (Level A)'
  },
  genericAAA: {
    what: 'The link text is a generic phrase; only the sentence around it explains where it goes.',
    why: 'This meets Level A, but users who list all links on a page still hear "click here" out of context.',
    fix: "For Level AAA, make the link text meaningful on its own, e.g. <a href='/pricing'>See pricing plans</a>.",
    wcag: 'WCAG 2.1 - 2.4.9 (Level AAA)'
  }
};

// HTML: the text of the nearest sentence-like block around the link, without the link's own text.
function htmlLinkContext(node, textOf) {
  for (let p = node.parentNode; p && p.tagName; p = p.parentNode) {
    if (CONTEXT_BLOCKS.has(p.tagName)) return textOf(p, node);
  }
  // Directly in a container: the text right next to the link in the same parent.
  const kids = (node.parentNode && node.parentNode.childNodes) || [];
  const i = kids.indexOf(node);
  const near = (j) => (kids[j] && kids[j].nodeName === '#text' ? kids[j].value : '');
  return near(i - 1) + ' ' + near(i + 1);
}

// -> null | { severity, message }
function judgeLinkText(name, contextText, complianceLevel, isGeneric) {
  if (!name) return { severity: 'critical', message: MESSAGES.empty };
  if (!isGeneric(name)) return null;
  if (!explains(contextText)) return { severity: 'warning', message: MESSAGES.generic };
  if (complianceLevel === 'AAA') return { severity: 'advisory', message: MESSAGES.genericAAA };
  return null;
}

module.exports = { judgeLinkText, htmlLinkContext, explains, MESSAGES, CONTEXT_BLOCKS };
