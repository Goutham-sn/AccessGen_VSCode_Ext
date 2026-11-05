// The AI disclosure: its wording, and the versioned record of who has acknowledged which wording.
//
// Stored in context.globalState (never in settings) under DISCLOSURE_KEY as
//   { dismissed: true, version: N }
// "Seen" means the stored version is at least AI_DISCLOSURE_VERSION. Anyone who acknowledged an older
// wording is therefore treated exactly like a first-time user: they see the dialog before the next real
// send (AI review OR an AI-suggested fix), and the informational notices appear again too.
//
// WHEN YOU CHANGE disclosureText() YOU MUST BUMP AI_DISCLOSURE_VERSION. Acknowledging a disclosure that
// no longer describes what is sent is not consent. test/disclosure-version.test.js pins the wording of
// each version to a fingerprint and fails if the text changes while the version stays the same.
//
// Version history
//   0  legacy: the flag used to be a plain boolean (`true`) written before versioning existed. Whatever
//      wording it was given for, it is read as version 0.
//   1  the original wording: flagged alt text, link text, link href and heading text. (Never stored as a
//      version: it predates the versioned record, so it survives only as legacy version 0.)
//   2  adds what an AI-suggested fix sends: the image file name and a short snippet of nearby text.
//   3  adds the generic AI fix, which works for any rule: it sends the flagged SOURCE CODE and the code around it
//      (the enclosing element or rule, or a few surrounding lines), plus the rule's own description of the problem.
//   4  adds batch remediation: the WHOLE FILE being fixed (or, for a large file, the code regions around its issues),
//      the file's base name, and the local image files an <img> displays (when accessgen.aiSendImages is on).

const DISCLOSURE_KEY = 'accessgen.aiDisclosureDismissed';
const AI_DISCLOSURE_VERSION = 4;

// What the stored value says, whatever shape it has. Never throws.
//   true                              -> { dismissed: true,  version: 0 }   (legacy boolean)
//   { dismissed: true, version: N }   -> { dismissed: true,  version: N }   (N a non-negative integer)
//   { dismissed: true }               -> { dismissed: true,  version: 0 }   (version missing or malformed)
//   anything else                     -> { dismissed: false, version: 0 }
function readDisclosure(value) {
  if (value === true) return { dismissed: true, version: 0 };
  if (value && typeof value === 'object' && !Array.isArray(value) && value.dismissed === true) {
    const v = value.version;
    return { dismissed: true, version: Number.isInteger(v) && v >= 0 ? v : 0 };
  }
  return { dismissed: false, version: 0 };
}

// true only if the user has acknowledged the CURRENT wording (or a later one: a downgrade does not re-ask).
function isDisclosureCurrent(value) {
  const r = readDisclosure(value);
  return r.dismissed && r.version >= AI_DISCLOSURE_VERSION;
}

// The record to store when the user acknowledges the current wording.
function disclosureRecord() {
  return { dismissed: true, version: AI_DISCLOSURE_VERSION };
}

// providerLabel: e.g. 'OpenAI' / 'Anthropic' (the provider currently selected).
function disclosureText(providerLabel) {
  return 'AccessGen AI review sends the flagged alt text, link text, link href and heading text, ' +
    'and for AI-suggested fixes also the image file name and a short snippet of nearby text ' +
    'or, for any other rule, the flagged source code with the code around it ' +
    '(the enclosing element, rule block or a few surrounding lines) and the description of the problem the rule reports ' +
    '(and nothing else from the file). ' +
    'Fixing a whole file with AI sends that file\'s source code (for a large file, the code around each issue), its file name, ' +
    'and the local image files its images display (unless accessgen.aiSendImages is off). ' +
    'All of this goes to a third-party AI provider, OpenAI or Anthropic ' +
    '(currently ' + providerLabel + '). Nothing is sent unless you enable AI features.';
}

module.exports = { DISCLOSURE_KEY, AI_DISCLOSURE_VERSION, readDisclosure, isDisclosureCurrent, disclosureRecord, disclosureText };
