// In-memory "have we already listed this candidate?" memory, so an auto-mode rescan of an
// unchanged file doesn't re-list (and later, re-send) candidates that haven't changed.
// Not persisted: it resets when the extension host restarts.
//
// Identity is structural, not positional. A candidate's slot is file + ruleId + structural
// path (tag + index among same-tag siblings, from candidateSelector), and its hash covers
// ruleId + resolved content + file + path. So:
//   - inserting/removing lines (blank lines, comments, unrelated code) changes nothing;
//   - editing the content of the element is a change (same slot, new hash);
//   - moving the element in the tree, or inserting an earlier same-tag sibling that shifts
//     its index, is a structural change and counts as new once.

const crypto = require('crypto');

// salt (optional) folds extra identity into the hash. The AI review uses "provider/model", so
// changing provider or model makes stored verdicts stale instead of showing the old model's answer.
function hashOf(c, filePath, salt) {
  return crypto.createHash('sha1')
    .update([c.ruleId, c.content, filePath, c.path, salt || ''].join('\u0000'))
    .digest('hex');
}

function createChangeTracker() {
  const seen = new Map();    // slot -> hash   (candidates that have been listed)
  const reviewed = new Map(); // slot -> { hash, result }   (candidates with a successful AI judgment)
  const dispositions = new Map(); // identity -> 'applied' | 'rejected'   (what the developer decided about a fix)
  const prefix = (filePath) => filePath + '\u0001';
  const slotOf = (c, filePath) => `${prefix(filePath)}${c.ruleId}\u0001${c.path}`;

  return {
    // --- AI review memory -------------------------------------------------------------
    // A candidate is "reviewed" only once a judgment SUCCEEDED for its current content, so a
    // failed call (rate limit, network, bad response) is retried on the next review instead of
    // being skipped forever.

    // The candidates that still need a judgment: no stored result, or the content/path changed
    // since it. Also forgets stored results for this file whose candidate has disappeared.
    pending(filePath, candidates, salt) {
      const out = [];
      const current = new Set();
      for (const c of candidates) {
        const slot = slotOf(c, filePath);
        current.add(slot);
        const r = reviewed.get(slot);
        if (!r || r.hash !== hashOf(c, filePath, salt)) out.push(c);
      }
      const p = prefix(filePath);
      for (const slot of [...reviewed.keys()]) {
        if (slot.startsWith(p) && !current.has(slot)) reviewed.delete(slot);
      }
      return out;
    },
    recordResult(filePath, candidate, result, salt) {
      reviewed.set(slotOf(candidate, filePath), { hash: hashOf(candidate, filePath, salt), result });
    },
    // The stored result for this exact content (and salt), or undefined.
    getResult(filePath, candidate, salt) {
      const r = reviewed.get(slotOf(candidate, filePath));
      return r && r.hash === hashOf(candidate, filePath, salt) ? r.result : undefined;
    },
    // Identity of this exact candidate content (slot + hash), for de-duplicating in-flight calls.
    identity(filePath, candidate, salt) {
      return slotOf(candidate, filePath) + '\u0002' + hashOf(candidate, filePath, salt);
    },
    reviewedSize() { return reviewed.size; },

    // --- fix dispositions (inline-diff review) ------------------------------------------
    // What the developer decided about the suggested fix for one exact violation (an identity()
    // string: slot + content hash). 'applied' = accepted; 'rejected' = dismissed. A rejected
    // identity is never suggested again; editing the violating content yields a NEW identity
    // (same slot, new hash), which is a fresh suggestion. In memory only, like everything here.
    setDisposition(id, disposition) {
      if (disposition !== 'applied' && disposition !== 'rejected') throw new Error('changeTracker: unknown disposition ' + disposition);
      dispositions.set(id, disposition);
    },
    dispositionOf(id) { return dispositions.get(id); },

    // --- listing memory (no results) --------------------------------------------------
    // Returns only candidates that are new or changed since the last call for this file,
    // records them, and forgets any slot for this file that is no longer a candidate
    // (fixed, removed, or no longer qualifying).
    filterUnchanged(filePath, candidates) {
      const fresh = [];
      const current = new Set();
      for (const c of candidates) {
        if (typeof c.path !== 'string' || !c.path) {
          throw new Error('changeTracker: candidate has no structural path');
        }
        const slot = slotOf(c, filePath);
        const hash = hashOf(c, filePath);
        current.add(slot);
        if (seen.get(slot) !== hash) fresh.push(c);
        seen.set(slot, hash);
      }
      const p = prefix(filePath);
      for (const slot of [...seen.keys()]) {
        if (slot.startsWith(p) && !current.has(slot)) seen.delete(slot);
      }
      return fresh;
    },
    clearFile(filePath) {
      const p = prefix(filePath);
      for (const slot of [...seen.keys()]) if (slot.startsWith(p)) seen.delete(slot);
      for (const slot of [...reviewed.keys()]) if (slot.startsWith(p)) reviewed.delete(slot);
      for (const id of [...dispositions.keys()]) if (id.startsWith(p)) dispositions.delete(id);
    },
    size() { return seen.size; }
  };
}

module.exports = { createChangeTracker };
