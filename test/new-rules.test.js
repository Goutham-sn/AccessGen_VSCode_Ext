// Tests for Part B: new rules, shared link-text list, accessible-name helper.
// Node-only, stubbed `vscode`. Run: node test/new-rules.test.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? {} : origLoad.call(this, req, ...rest);
};

const { parseHTML } = require('../src/parsers/htmlParser');
const { parseJSX } = require('../src/parsers/jsxParser');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`);
}
function ruleSection(title, kind, ruleName, cases) {
  console.log(`\n${title}`);
  const rule = require(`../src/rules/${kind}/${ruleName}`);
  for (const [label, src, expected] of cases) {
    const ast = kind === 'html' ? parseHTML(src) : parseJSX(src);
    check(label, rule.check(ast, src, {}).length, expected);
  }
}
const J = s => 'const a = ' + s + ';';

// ---- B1 jsx-tabindex-positive ---------------------------------------------
ruleSection('B1 jsx-tabindex-positive', 'jsx', 'jsx-tabindex-positive', [
  ['tabIndex="1"', J('<div tabIndex="1"/>'), 1],
  ['tabIndex={1}', J('<div tabIndex={1}/>'), 1],
  ['tabIndex={5}', J('<div tabIndex={5}/>'), 1],
  ['tabIndex={99999}', J('<div tabIndex={99999}/>'), 1],
  ['tabIndex={"3"}', J('<div tabIndex={"3"}/>'), 1],
  ['tabIndex=" 3 "', J('<div tabIndex=" 3 "/>'), 1],
  ['custom component <Foo tabIndex={2}>', J('<Foo tabIndex={2}/>'), 1],
  ['tabIndex={0}', J('<div tabIndex={0}/>'), 0],
  ['tabIndex="0"', J('<div tabIndex="0"/>'), 0],
  ['tabIndex={-1}', J('<div tabIndex={-1}/>'), 0],
  ['tabIndex="-1"', J('<div tabIndex="-1"/>'), 0],
  ['dynamic tabIndex={computed} skipped', J('<div tabIndex={computed}/>'), 0],
  ['dynamic tabIndex={a ? 1 : 0} skipped', J('<div tabIndex={a ? 1 : 0}/>'), 0],
  ['tabIndex="2px" (not an integer) skipped', J('<div tabIndex="2px"/>'), 0],
  ['tabIndex={1.5} skipped', J('<div tabIndex={1.5}/>'), 0],
  ['no tabIndex', J('<div/>'), 0],
  ['lowercase tabindex is not a React prop (not this rule)', J('<div tabindex="3"/>'), 0],
  ['two offenders', J('<><a tabIndex={1}/><b tabIndex={2}/></>'), 2]
]);

// ---- B2 jsx-autofocus-used --------------------------------------------------
ruleSection('B2 jsx-autofocus-used', 'jsx', 'jsx-autofocus-used', [
  ['bare autoFocus', J('<input autoFocus/>'), 1],
  ['autoFocus={true}', J('<input autoFocus={true}/>'), 1],
  ['on a div', J('<div autoFocus/>'), 1],
  ['on custom component', J('<TextField autoFocus/>'), 1],
  ['autoFocus={false} exempt', J('<input autoFocus={false}/>'), 0],
  ['<dialog autoFocus> exempt', J('<dialog autoFocus/>'), 0],
  ['<dialog autoFocus={true}> exempt', J('<dialog autoFocus={true}/>'), 0],
  ['input inside <dialog> is NOT exempt (only the dialog element itself)', J('<dialog><input autoFocus/></dialog>'), 1],
  ['dynamic autoFocus={x} skipped', J('<input autoFocus={x}/>'), 0],
  ['no autoFocus', J('<input/>'), 0],
  ['lowercase autofocus is not a React prop (not this rule)', J('<input autofocus/>'), 0]
]);

// ---- B3 heading-empty (HTML) ---------------------------------------------------
ruleSection('B3 heading-empty', 'html', 'heading-empty', [
  ['<h1></h1>', '<h1></h1>', 1],
  ['<h2>   </h2> whitespace', '<h2>   \n  </h2>', 1],
  ['<h3>&nbsp;</h3> nbsp only', '<h3>&nbsp;</h3>', 1],
  ['<h4><!-- c --></h4> comment only', '<h4><!-- c --></h4>', 1],
  ['<h5></h5>', '<h5></h5>', 1],
  ['<h6></h6>', '<h6></h6>', 1],
  ['<div role="heading" aria-level="2"></div>', '<div role="heading" aria-level="2"></div>', 1],
  ['<div role="HEADING"></div> case-insensitive', '<div role="HEADING"></div>', 1],
  ['<span role=" heading "> whitespace in role', '<span role=" heading "> </span>', 1],
  ['h1 with role=heading counted once', '<h1 role="heading"></h1>', 1],
  ['<h1>Title</h1>', '<h1>Title</h1>', 0],
  ['<div role="heading">Title</div>', '<div role="heading">Title</div>', 0],
  ['<h1 aria-label="Title"></h1>', '<h1 aria-label="Title"></h1>', 0],
  ['<h1 aria-label=""></h1> empty label is not a name', '<h1 aria-label=""></h1>', 1],
  ['child element counts as content (mirrors jsx-heading-empty)', '<h1><span></span></h1>', 0],
  ['<h1><img alt=""></h1> child element (mirrors jsx)', '<h1><img src="a" alt=""></h1>', 0],
  ['nested text', '<h1><span>Title</span></h1>', 0],
  ['non-heading empty div', '<div></div>', 0],
  ['<p></p> not a heading', '<p></p>', 0],
  ['role=button empty not a heading', '<div role="button"></div>', 0]
]);

// ---- B4 shared generic link text -------------------------------------------------
console.log('\nB4 shared genericLinkText');
const g = require('../src/rules/shared/genericLinkText');
check('phrase list is the original six', g.GENERIC_LINK_PHRASES, ['click here', 'here', 'link', 'read more', 'more', 'learn more']);
for (const t of ['click here', 'Click here!', ' click here ', 'CLICK   HERE', 'More...', 'More…', 'read more »', '"Learn more"', 'Here.', '  Link  ', 'Read\nmore', '→ more', 'click here:']) {
  check(`generic: ${JSON.stringify(t)}`, g.isGenericLinkText(t), true);
}
for (const t of ['Click here to read the report', 'Read more about WCAG', 'Download', 'Our accessibility guide', '', '   ', 'here is the guide', 'more info']) {
  check(`not generic: ${JSON.stringify(t)}`, g.isGenericLinkText(t), false);
}
for (const t of ['https://example.com', 'http://example.com/a/b?c=1', ' HTTPS://EXAMPLE.COM ', 'www.example.com/path']) {
  check(`url: ${JSON.stringify(t)}`, g.isUrlLinkText(t), true);
}
for (const t of ['HTTP caching guide', 'httpd configuration', 'Visit https://example.com today', 'example.com', 'Read more', '']) {
  check(`not url: ${JSON.stringify(t)}`, g.isUrlLinkText(t), false);
}

ruleSection('B4 anchor-no-text (HTML) uses shared list', 'html', 'anchor-no-text', [
  // original detections (must survive)
  ['empty link', '<a href="x"></a>', 1],
  ['click here', '<a href="x">click here</a>', 1],
  ['read more', '<a href="x">Read more</a>', 1],
  ['here', '<a href="x">here</a>', 1],
  ['link', '<a href="x">link</a>', 1],
  ['learn more', '<a href="x">Learn more</a>', 1],
  ['more', '<a href="x">more</a>', 1],
  ['aria-label rescues', '<a href="x" aria-label="Annual report"></a>', 0],
  ['descriptive text ok', '<a href="x">Read the annual report</a>', 0],
  // new via normalization
  ['Click here!', '<a href="x">Click here!</a>', 1],
  ['More...', '<a href="x">More...</a>', 1],
  ['More…', '<a href="x">More…</a>', 1],
  ['" click here " padded', '<a href="x"> click here </a>', 1],
  ['multi-line', '<a href="x">\n  Read\n  more\n</a>', 1],
  // URL-as-text
  ['https URL text', '<a href="https://e.com">https://example.com/page</a>', 1],
  ['www URL text', '<a href="https://e.com">www.example.com</a>', 1],
  ['"HTTP caching guide" is descriptive', '<a href="x">HTTP caching guide</a>', 0],
  ['sentence containing URL', '<a href="x">Visit https://example.com today</a>', 0]
]);

ruleSection('B4 jsx-anchor-no-content (JSX) uses shared list', 'jsx', 'jsx-anchor-no-content', [
  // original detections (must survive)
  ['empty <a>', J('<a href="x"></a>'), 1],
  ['aria-label rescues', J('<a href="x" aria-label="Report"></a>'), 0],
  ['descriptive text', J('<a href="x">Read the annual report</a>'), 0],
  ['{children} dynamic skipped', J('<a href="x">{children}</a>'), 0],
  ['element child skipped', J('<a href="x"><span>Report</span></a>'), 0],
  ['mixed text + dynamic skipped', J('<a href="x">Read {title}</a>'), 0],
  // previously no phrase check at all
  ['click here', J('<a href="x">click here</a>'), 1],
  ['Click here!', J('<a href="x">Click here!</a>'), 1],
  ['More...', J('<a href="x">More...</a>'), 1],
  ['More…', J('<a href="x">More…</a>'), 1],
  [' click here ', J('<a href="x"> click here </a>'), 1],
  ['Read more', J('<a href="x">Read more</a>'), 1],
  ['{"click here"} string expression', J('<a href="x">{"click here"}</a>'), 1],
  ['{`read more`} static template', J('<a href="x">{`read more`}</a>'), 1],
  ['multi-line text', J('<a href="x">\n  Learn\n  more\n</a>'), 1],
  ['"Read more about WCAG" ok', J('<a href="x">Read more about WCAG</a>'), 0],
  // URL-as-text
  ['https URL text', J('<a href="x">https://example.com/page</a>'), 1],
  ['www URL text', J('<a href="x">www.example.com</a>'), 1],
  ['"HTTP caching guide" ok', J('<a href="x">HTTP caching guide</a>'), 0],
  // aria-label wins (vague aria-label is a separate, unchanged gap)
  ['generic text but aria-label present', J('<a href="x" aria-label="Annual report">click here</a>'), 0]
]);

// ---- B5 accessibleName helper ----------------------------------------------------
console.log('\nB5 shared accessibleName');
const { getAccessibleName } = require('../src/rules/shared/accessibleName');
function nameOf(html, selector) {
  const root = parseHTML(html);
  let found = null;
  (function walk(n) {
    if (found) return;
    if (n.tagName === selector) { found = n; return; }
    [...(n.childNodes || []), ...((n.content && n.content.childNodes) || [])].forEach(walk);
  })(root);
  return getAccessibleName(found, root);
}
// known-gap cases from the audit
check('empty aria-label, no content -> no name', nameOf('<button aria-label=""></button>', 'button'), { name: '', source: null });
check('whitespace aria-label, no content -> no name', nameOf('<button aria-label="   "></button>', 'button'), { name: '', source: null });
check('empty aria-label falls through to content', nameOf('<button aria-label="">Save</button>', 'button'), { name: 'Save', source: 'content' });
check('dangling aria-labelledby, no content -> no name', nameOf('<button aria-labelledby="nope"></button>', 'button'), { name: '', source: null });
check('dangling aria-labelledby falls through to aria-label', nameOf('<button aria-labelledby="nope" aria-label="Close"></button>', 'button'), { name: 'Close', source: 'aria-label' });
check('dangling aria-labelledby falls through to content', nameOf('<button aria-labelledby="nope">Save</button>', 'button'), { name: 'Save', source: 'content' });
check('aria-labelledby resolving to empty text -> absent', nameOf('<span id="l"></span><button aria-labelledby="l"></button>', 'button'), { name: '', source: null });
check('empty-resolved labelledby falls through to aria-label', nameOf('<span id="l"> </span><button aria-labelledby="l" aria-label="Go"></button>', 'button'), { name: 'Go', source: 'aria-label' });
check('aria-labelledby resolves one id', nameOf('<span id="l">Delete</span><button aria-labelledby="l"></button>', 'button'), { name: 'Delete', source: 'aria-labelledby' });
check('aria-labelledby resolves several ids in order, skipping dangling', nameOf('<b id="a">Delete</b><i id="b">item</i><button aria-labelledby="a zz b"></button>', 'button'), { name: 'Delete item', source: 'aria-labelledby' });
check('aria-labelledby beats aria-label and content', nameOf('<span id="l">Ref</span><button aria-labelledby="l" aria-label="Lbl">Txt</button>', 'button'), { name: 'Ref', source: 'aria-labelledby' });
check('aria-labelledby target may itself be hidden', nameOf('<span id="l" aria-hidden="true">Ref</span><button aria-labelledby="l"></button>', 'button'), { name: 'Ref', source: 'aria-labelledby' });
check('aria-label beats content', nameOf('<button aria-label="Lbl">Txt</button>', 'button'), { name: 'Lbl', source: 'aria-label' });
const vague = nameOf('<a href="x" aria-label="link">z</a>', 'a');
check('vague aria-label is returned as the name (caller judges it)', vague, { name: 'link', source: 'aria-label' });
check('...and composes with isGenericLinkText to flag it', g.isGenericLinkText(vague.name), true);
check('vague content "Click here!" composes too', g.isGenericLinkText(nameOf('<a href="x">Click here!</a>', 'a').name), true);
// content / title / misc
check('plain text content', nameOf('<button>  Submit   form </button>', 'button'), { name: 'Submit form', source: 'content' });
check('nested text content', nameOf('<button><span>Sub</span><b>mit</b></button>', 'button').name.replace(/\s/g, ''), 'Submit');
check('empty button -> no name', nameOf('<button></button>', 'button'), { name: '', source: null });
check('whitespace/nbsp button -> no name', nameOf('<button> &nbsp; </button>', 'button'), { name: '', source: null });
check('img alt inside content', nameOf('<button><img src="a" alt="Close"></button>', 'button'), { name: 'Close', source: 'content' });
check('img empty alt inside -> no name', nameOf('<button><img src="a" alt=""></button>', 'button'), { name: '', source: null });
check('svg <title> contributes', nameOf('<button><svg><title>Close</title></svg></button>', 'button'), { name: 'Close', source: 'content' });
check('aria-hidden text ignored (known gap closed in helper)', nameOf('<button><span aria-hidden="true">X</span></button>', 'button'), { name: '', source: null });
check('title is last-resort fallback', nameOf('<button title="Close"></button>', 'button'), { name: 'Close', source: 'title' });
check('content beats title', nameOf('<button title="T">Txt</button>', 'button'), { name: 'Txt', source: 'content' });
check('empty title -> no name', nameOf('<button title=" "></button>', 'button'), { name: '', source: null });
check('img node uses its own alt', nameOf('<img src="a" alt="Logo">', 'img'), { name: 'Logo', source: 'content' });
check('null node is safe', getAccessibleName(null, null), { name: '', source: null });
check('text node is safe', getAccessibleName({ nodeName: '#text' }, null), { name: '', source: null });

// ---- registration ------------------------------------------------------------------
console.log('\nanalyzer registration');
const { getRuleById } = require('../src/analyzer');
for (const id of ['jsx-tabindex-positive', 'jsx-autofocus-used', 'heading-empty']) {
  check(`${id} loads via analyzer`, !!getRuleById(id), true);
}
const rawAnalyzer = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'analyzer.js'), 'utf8');
check('jsx rules registered in jsxRuleFiles', /jsxRuleFiles[\s\S]*?'jsx-tabindex-positive'[\s\S]*?'jsx-autofocus-used'[\s\S]*?\];/.test(rawAnalyzer), true);
check('heading-empty registered in htmlRuleFiles', /htmlRuleFiles[\s\S]*?'heading-empty'[\s\S]*?\];/.test(rawAnalyzer), true);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
