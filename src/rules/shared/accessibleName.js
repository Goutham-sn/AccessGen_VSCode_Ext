// Accessible-name resolution for parse5 (HTML) elements.
//
// getAccessibleName(node, root, options?) -> { name, source }
//   options.content === false skips the content step, for elements whose children are
//   never their name (form, iframe, select/input/textarea).
//   source: 'aria-labelledby' | 'aria-label' | 'content' | 'title' | null
//   name:   '' when the element has no accessible name.
//
// Order follows the accname algorithm: aria-labelledby, aria-label, content, title.
// Each step is skipped (not an error) when absent, empty, or whitespace-only:
//   - aria-label="" / "  "                      -> absent
//   - aria-labelledby with no resolvable id      -> absent (dangling refs ignored)
//   - aria-labelledby resolving to empty text    -> absent
// title is kept as the last-resort fallback because several rules already rely on it.
// Content ignores aria-hidden="true" / hidden subtrees; <img> contributes its alt and
// <svg><title> contributes through ordinary text. Vague names ("link") are still names;
// callers decide whether a name is acceptable (see genericLinkText.js).

const idMaps = new WeakMap();

function attr(node, name) {
  const a = (node.attrs || []).find(x => x.name === name);
  return a ? a.value : undefined;
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function childrenOf(node) {
  return [...(node.childNodes || []), ...((node.content && node.content.childNodes) || [])];
}

function buildIdMap(root) {
  const map = new Map();
  (function visit(n) {
    const id = n.attrs && attr(n, 'id');
    if (id && !map.has(id)) map.set(id, n);
    childrenOf(n).forEach(visit);
  })(root);
  return map;
}

function getIdMap(root) {
  if (!idMaps.has(root)) idMaps.set(root, buildIdMap(root));
  return idMaps.get(root);
}

function isHidden(node) {
  if (!node.attrs) return false;
  return attr(node, 'aria-hidden') === 'true' || attr(node, 'hidden') !== undefined;
}

function contentText(node, includeHidden) {
  let out = '';
  for (const child of childrenOf(node)) {
    if (child.nodeName === '#text') out += child.value || '';
    else if (child.tagName) {
      if (isHidden(child) && !includeHidden) continue;
      if (child.tagName === 'img') out += ' ' + clean(attr(child, 'alt')) + ' ';
      else out += ' ' + contentText(child, includeHidden) + ' ';
    }
  }
  return clean(out);
}

function getAccessibleName(node, root, options) {
  if (!node || !node.attrs) return { name: '', source: null };
  const useContent = !options || options.content !== false;

  const labelledby = attr(node, 'aria-labelledby');
  if (labelledby && labelledby.trim() && root) {
    const ids = getIdMap(root);
    const text = clean(
      labelledby.split(/\s+/).filter(Boolean)
        .map(id => ids.get(id))
        .filter(Boolean)
        // A referenced element contributes even if it is itself hidden.
        .map(ref => contentText(ref, true) || clean(attr(ref, 'aria-label')))
        .join(' ')
    );
    if (text) return { name: text, source: 'aria-labelledby' };
  }

  const label = clean(attr(node, 'aria-label'));
  if (label) return { name: label, source: 'aria-label' };

  if (useContent) {
    if (node.tagName === 'img') {
      const alt = clean(attr(node, 'alt'));
      if (alt) return { name: alt, source: 'content' };
    }
    const text = contentText(node, false);
    if (text) return { name: text, source: 'content' };
  }

  const title = clean(attr(node, 'title'));
  if (title) return { name: title, source: 'title' };

  return { name: '', source: null };
}

module.exports = { getAccessibleName };
