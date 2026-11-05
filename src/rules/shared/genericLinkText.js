// Shared by anchor-no-text (HTML) and jsx-anchor-no-content (JSX) so both rules
// agree on what counts as non-descriptive link text.

const GENERIC_LINK_PHRASES = ['click here', 'here', 'link', 'read more', 'more', 'learn more'];

// Lowercase, collapse whitespace, drop leading/trailing punctuation and symbols
// ("Click here!" / "More..." / "More…" / " click here " -> "click here" / "more").
function normalizeLinkText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

function isGenericLinkText(text) {
  return GENERIC_LINK_PHRASES.includes(normalizeLinkText(text));
}

// The visible text is itself a bare URL: http(s):// scheme or a www. host, no spaces.
// (Deliberately not a bare "starts with http": "HTTP caching guide" is descriptive.)
function isUrlLinkText(text) {
  const t = String(text == null ? '' : text).trim();
  return /^https?:\/\/\S+$/i.test(t) || /^www\.\S+$/i.test(t);
}

module.exports = { GENERIC_LINK_PHRASES, normalizeLinkText, isGenericLinkText, isUrlLinkText };
