// Scan scopes beyond the active editor: selected files and the whole workspace. Also the project facts and the
// local image reader that batch remediation uses.
//
// An open document is read from the editor (unsaved changes included); anything else from disk. Diagnostics are
// published for every scanned file through a lightweight document stand-in, so the Problems panel lists them all.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const LANG_BY_EXT = { '.html': 'html', '.htm': 'html', '.jsx': 'javascriptreact', '.tsx': 'typescriptreact', '.css': 'css' };
const FILE_GLOB = '**/*.{html,htm,jsx,tsx,css}';
const EXCLUDE_GLOB = '**/{node_modules,dist,build,out,.git,.next,.nuxt,coverage,vendor,.vscode-test}/**';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024); // Anthropic's 5 MB limit applies to the base64 form
const MAX_SVG_CHARS = 6000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function languageOf(uri) {
  return LANG_BY_EXT[path.extname(uri.fsPath || uri.path || '').toLowerCase()] || null;
}

function relPath(uri) {
  return vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
}

async function findCandidateFiles(token) {
  const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, MAX_FILES, token);
  return uris.filter(u => languageOf(u)).sort((a, b) => relPath(a).localeCompare(relPath(b)));
}

async function readSource(uri) {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open) return { text: open.getText(), document: open };
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_FILE_BYTES) return { text: null, tooLarge: true };
  return { text: Buffer.from(bytes).toString('utf8') };
}

// Enough of a TextDocument for analyzeDocument and updateDiagnostics.
function documentShim(uri, text, languageId) {
  const lines = text.split(/\r\n|\r|\n/);
  return { uri, languageId, getText: () => text, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] || '' }) };
}

// Multi-select file picker. -> uris | undefined (cancelled)
async function pickFiles() {
  const uris = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'AccessGen: finding files' },
    () => findCandidateFiles()
  );
  if (!uris.length) {
    vscode.window.showInformationMessage('AccessGen: no HTML, JSX, TSX or CSS files found in this workspace.');
    return undefined;
  }
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString();
  const items = uris.map(u => ({
    label: path.basename(u.fsPath),
    description: path.dirname(relPath(u)) === '.' ? '' : path.dirname(relPath(u)),
    detail: undefined,
    picked: u.toString() === active,
    uri: u
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    title: 'AccessGen: scan selected files',
    placeHolder: 'Type to filter, Space to select, Enter to scan (' + uris.length + ' files)'
  });
  return picked && picked.length ? picked.map(p => p.uri) : undefined;
}

// Scans the given files. onResult({ uri, source, languageId, violations, document }) per file.
// -> { scanned, skipped, cancelled }
async function scanUris(uris, { analyze, onResult, progress, token }) {
  const out = { scanned: 0, skipped: 0, cancelled: false };
  const step = uris.length ? 100 / uris.length : 100;
  for (let i = 0; i < uris.length; i++) {
    if (token && token.isCancellationRequested) { out.cancelled = true; break; }
    const uri = uris[i];
    const languageId = languageOf(uri);
    if (!languageId) { out.skipped++; continue; }
    if (progress) progress.report({ message: relPath(uri), increment: step });
    let read;
    try { read = await readSource(uri); } catch (e) { out.skipped++; continue; }
    if (!read.text && read.text !== '') { out.skipped++; continue; }
    const document = read.document || documentShim(uri, read.text, languageId);
    const violations = await analyze(document);
    out.scanned++;
    try { onResult({ uri, source: read.text, languageId, violations, document }); } catch (e) { console.error('AccessGen: scan result error:', e && e.message); }
    if (i % 25 === 24) await new Promise(r => setImmediate(r)); // keep the extension host responsive
  }
  return out;
}

// Facts about the project that make fixes fit it: which visually-hidden utility class exists, whether Tailwind is used.
async function collectProjectFacts() {
  const facts = { srOnlyClasses: [], tailwind: false };
  try {
    const tw = await vscode.workspace.findFiles('**/tailwind.config.{js,cjs,mjs,ts}', EXCLUDE_GLOB, 1);
    facts.tailwind = tw.length > 0;
    const css = await vscode.workspace.findFiles('**/*.{css,scss}', EXCLUDE_GLOB, 300);
    const found = new Set();
    for (const uri of css) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_FILE_BYTES) continue;
      const text = Buffer.from(bytes).toString('utf8');
      if (/@tailwind|@import\s+["']tailwindcss/.test(text)) facts.tailwind = true;
      for (const c of ['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screenreader-only', 'a11y-hidden']) {
        if (new RegExp('\\.' + c + '\\b').test(text)) found.add(c);
      }
    }
    if (facts.tailwind) found.add('sr-only');
    facts.srOnlyClasses = [...found];
  } catch (e) { /* facts are a bonus */ }
  return facts;
}

// For a source file, a reader that turns an <img src> into { mediaType, data } (base64) or { svgText }.
// Only local files inside a workspace folder: remote URLs, data: URIs and paths escaping the workspace are never read.
function assetReaderFor(filePath) {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const inWorkspace = (p) => folders.some(root => { const rel = path.relative(root, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  return (src) => {
    if (typeof src !== 'string') return null;
    const clean = src.trim().split(/[?#]/)[0];
    if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
    let decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch (e) { /* keep */ }
    const candidates = decoded.startsWith('/')
      ? folders.flatMap(root => [path.join(root, decoded), path.join(root, 'public', decoded), path.join(root, 'static', decoded)])
      : [path.resolve(path.dirname(filePath), decoded)];
    for (const file of candidates) {
      if (!inWorkspace(file)) continue;
      let stat;
      try { stat = fs.statSync(file); } catch (e) { continue; }
      if (!stat.isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      if (ext === '.svg' && stat.size <= 64 * 1024) {
        const svg = fs.readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s+/g, ' ');
        return { svgText: svg.length > MAX_SVG_CHARS ? svg.slice(0, MAX_SVG_CHARS) + '…' : svg };
      }
      if (IMAGE_TYPES[ext] && stat.size <= MAX_IMAGE_BYTES) {
        return { mediaType: IMAGE_TYPES[ext], data: fs.readFileSync(file).toString('base64') };
      }
    }
    return null;
  };
}

module.exports = { languageOf, relPath, findCandidateFiles, readSource, documentShim, pickFiles, scanUris, collectProjectFacts, assetReaderFor, LANG_BY_EXT };
