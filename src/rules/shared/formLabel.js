// Accessible name of a form control (<input>, <select>, <textarea>) in an HTML tree.
//
// Sources, any of which is enough:
//   - the control's own aria-labelledby / aria-label / title (via getAccessibleName,
//     content skipped: a control's children are never its name)
//   - a <label for="id"> pointing at the control's id
//   - a <label> wrapping the control
// A label only counts if it has an accessible name of its own, so <label for="a"></label>
// and <label><input></label> no longer count as labelled.

const { getAccessibleName } = require('./accessibleName');

const caches = new WeakMap();

function childrenOf(node) {
  return [...(node.childNodes || []), ...((node.content && node.content.childNodes) || [])];
}

function index(root) {
  if (caches.has(root)) return caches.get(root);
  const parents = new Map();
  const labelsFor = new Map();
  (function visit(node, parent) {
    parents.set(node, parent);
    if (node.tagName === 'label') {
      const f = (node.attrs || []).find(a => a.name === 'for');
      if (f && f.value) {
        if (!labelsFor.has(f.value)) labelsFor.set(f.value, []);
        labelsFor.get(f.value).push(node);
      }
    }
    childrenOf(node).forEach(c => visit(c, node));
  })(root, null);
  const idx = { parents, labelsFor };
  caches.set(root, idx);
  return idx;
}

function getControlName(control, root) {
  const own = getAccessibleName(control, root, { content: false });
  if (own.name) return own;

  const { parents, labelsFor } = index(root);
  const labels = [];
  const idAttr = (control.attrs || []).find(a => a.name === 'id');
  if (idAttr && idAttr.value) labels.push(...(labelsFor.get(idAttr.value) || []));
  for (let p = parents.get(control); p; p = parents.get(p)) {
    if (p.tagName === 'label') labels.push(p);
  }

  for (const label of labels) {
    const n = getAccessibleName(label, root);
    if (n.name) return { name: n.name, source: 'label' };
  }
  return { name: '', source: null };
}

module.exports = { getControlName };
