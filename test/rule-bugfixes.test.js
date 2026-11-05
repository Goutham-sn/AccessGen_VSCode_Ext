// Regression tests for the five audit bug fixes. Node-only, stubbed `vscode`.
// Run: node test/rule-bugfixes.test.js   (exits non-zero on any failure)
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? {} : origLoad.call(this, req, ...rest);
};

const { parseHTML } = require('../src/parsers/htmlParser');
const { parseJSX } = require('../src/parsers/jsxParser');
const { parseCSS } = require('../src/parsers/cssParser');

let config = { isTrustedComponent: () => false };

function count(kind, ruleName, src) {
  const rule = require(`../src/rules/${kind}/${ruleName}`);
  const ast = kind === 'html' ? parseHTML(src) : kind === 'jsx' ? parseJSX(src) : parseCSS(src);
  return rule.check(ast, src, config).length;
}

let failed = 0, total = 0;
function section(title, kind, ruleName, cases, trusted = []) {
  config = { isTrustedComponent: n => trusted.includes(n) };
  console.log(`\n${title}`);
  for (const [label, src, expected] of cases) {
    total++;
    const got = count(kind, ruleName, src);
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (expected ${expected}, got ${got})`);
  }
}

const J = s => 'const a = ' + s + ';';

// ---- 1. jsx-aria-invalid-role -------------------------------------------
const roleCase = (r, exp) => [`role="${r}"`, J(`<div role="${r}"/>`), exp];
section('1. jsx-aria-invalid-role', 'jsx', 'jsx-aria-invalid-role', [
  // bug: valid roles that were flagged
  ...['generic', 'paragraph', 'code', 'meter', 'caption', 'blockquote', 'emphasis', 'strong',
    'time', 'mark', 'insertion', 'deletion', 'subscript', 'superscript',
    'doc-chapter', 'doc-toc', 'doc-endnote', 'graphics-document', 'graphics-symbol'].map(r => roleCase(r, 0)),
  // bug: multi-token fallback
  roleCase('button link', 0),
  roleCase('foo button', 0),
  roleCase('  button   link ', 0),
  // regression: genuine invalid roles are still flagged
  roleCase('buton', 1),
  roleCase('image', 1),
  roleCase('command', 1),           // abstract role
  roleCase('foo bar', 1),           // no valid token
  roleCase('doc-bogus', 1),
  roleCase('graphics-bogus', 1),
  roleCase('', 1),
  roleCase('   ', 1),
  // regression: previously valid roles still pass
  roleCase('button', 0),
  roleCase('navigation', 0),
  ['role={expr} still skipped', J('<div role={r}/>'), 0]
]);

// ---- 2. jsx-label-missing ------------------------------------------------
section('2. jsx-label-missing', 'jsx', 'jsx-label-missing', [
  // FP #1: wrapped in own label
  ['<label>Name <input/></label>', J('<label>Name <input/></label>'), 0],
  ['deeply nested in label', J('<label><span>Name</span><div><input type="text"/></div></label>'), 0],
  ['textarea in label', J('<label>Bio <textarea/></label>'), 0],
  ['select in label', J('<label>Pick <select/></label>'), 0],
  ['sibling label is NOT an ancestor', J('<div><label>Name</label><input/></div>'), 1],
  ['input after closed label', J('<div><label>Name <b/></label><input/></div>'), 1],
  ['wrapped in non-label (div)', J('<div><input/></div>'), 1],
  // FP #2: dynamic htmlFor/id pair
  ['htmlFor={id} + id={id}', J('<><label htmlFor={id}>x</label><input id={id}/></>'), 0],
  ['member expr props.id', J('<><label htmlFor={props.id}>x</label><input id={props.id}/></>'), 0],
  ['template literal', J('<><label htmlFor={`f-${n}`}>x</label><input id={`f-${n}`}/></>'), 0],
  ['whitespace differs', J('<><label htmlFor={ id }>x</label><input id={id}/></>'), 0],
  ['expression mismatch htmlFor={a} id={b}', J('<><label htmlFor={a}>x</label><input id={b}/></>'), 1],
  ['expr htmlFor vs literal id', J('<><label htmlFor={id}>x</label><input id="x"/></>'), 1],
  ['literal htmlFor vs expr id', J('<><label htmlFor="x">x</label><input id={id}/></>'), 1],
  ['id expr but no label at all', J('<input id={id}/>'), 1],
  // regression: original detections and passes
  ['bare input', J('<input type="text"/>'), 1],
  ['placeholder only', J('<input placeholder="x"/>'), 1],
  ['literal htmlFor mismatch', J('<><label htmlFor="b">x</label><input id="a"/></>'), 1],
  ['literal htmlFor match', J('<><label htmlFor="a">x</label><input id="a"/></>'), 0],
  ['aria-label', J('<input aria-label="Name"/>'), 0],
  ['aria-labelledby', J('<input aria-labelledby="n"/>'), 0],
  ['hidden exempt', J('<input type="hidden"/>'), 0],
  ['trusted component skipped', J('<Input/>'), 0]
], ['Input']);

// ---- 3. jsx-onclick-no-keyboard ------------------------------------------
section('3. jsx-onclick-no-keyboard', 'jsx', 'jsx-onclick-no-keyboard', [
  // bug: capitalized names treated as native
  // Components render their own element (usually an accessible one): only native DOM elements are checked.
  ['<A onClick> (a component)', J('<A onClick={f}/>'), 0],
  ['<Select onClick> (a component)', J('<Select onClick={f}/>'), 0],
  ['<Input onClick> (a component)', J('<Input onClick={f}/>'), 0],
  ['<Textarea onClick> (a component)', J('<Textarea onClick={f}/>'), 0],
  ['<Foo.A onClick> member expr (a component)', J('<Foo.A onClick={f}/>'), 0],
  ['<Card onClick> custom component', J('<Card onClick={f}/>'), 0],
  // trusted config still honoured
  ['<Button onClick> trusted', J('<Button onClick={f}/>'), 0],
  // regression: native lowercase still skipped
  ['<button onClick>', J('<button onClick={f}/>'), 0],
  ['<a onClick> without href is not focusable', J('<a onClick={f}/>'), 1],
  ['<a href onClick>', J('<a href="/x" onClick={f}/>'), 0],
  ['<input onClick>', J('<input onClick={f}/>'), 0],
  ['<select onClick>', J('<select onClick={f}/>'), 0],
  ['<textarea onClick>', J('<textarea onClick={f}/>'), 0],
  // regression: original detections
  ['<div onClick>', J('<div onClick={f}/>'), 1],
  ['<span onClick>', J('<span onClick={f}/>'), 1],
  ['<div onClick onKeyDown>', J('<div onClick={f} onKeyDown={g}/>'), 0],
  ['<div onClick onKeyUp>', J('<div onClick={f} onKeyUp={g}/>'), 0],
  ['<A onClick onKeyDown>', J('<A onClick={f} onKeyDown={g}/>'), 0],
  ['<div> without onClick', J('<div/>'), 0]
], ['Button']);

// ---- 4. outline-removed ---------------------------------------------------
const F = decls => `a:focus{${decls}}`;
section('4. outline-removed', 'css', 'outline-removed', [
  // bug: outline-color beside outline:none is meaningless
  ['outline:none + outline-color:red', F('outline:none;outline-color:red'), 1],
  ['outline:0 + outline-color:#f00', F('outline:0;outline-color:#f00'), 1],
  ['outline-width:0 + outline-color:red', F('outline-width:0;outline-color:red'), 1],
  ['outline-color before outline:none', F('outline-color:red;outline:none'), 1],
  // (expectation changed 0 -> 1 in the follow-up pass: outline-style stays none, nothing is drawn)
  ['outline:none + separate non-zero outline-width + color', F('outline:none;outline-width:2px;outline-color:red'), 1],
  // bug: invisible box-shadows
  ['box-shadow 0 0 0 0 red', F('outline:none;box-shadow:0 0 0 0 red'), 1],
  ['box-shadow 0 0 0 2px transparent', F('outline:none;box-shadow:0 0 0 2px transparent'), 1],
  ['box-shadow inset 0 0 0 0 blue', F('outline:none;box-shadow:inset 0 0 0 0 blue'), 1],
  ['box-shadow rgba alpha 0', F('outline:none;box-shadow:0 0 0 2px rgba(0,0,0,0)'), 1],
  ['box-shadow #rrggbbaa alpha 00', F('outline:none;box-shadow:0 0 0 2px #00000000'), 1],
  ['box-shadow hsla alpha 0', F('outline:none;box-shadow:0 0 0 2px hsla(0,0%,0%,0)'), 1],
  ['box-shadow rgb slash alpha 0', F('outline:none;box-shadow:0 0 0 2px rgb(0 0 0 / 0)'), 1],
  ['all layers invisible', F('outline:none;box-shadow:0 0 0 0 red, 0 0 0 0 blue'), 1],
  // visible box-shadows still compensate
  ['box-shadow spread 2px #005fcc', F('outline:none;box-shadow:0 0 0 2px #005fcc'), 0],
  ['box-shadow blur only', F('outline:none;box-shadow:0 0 4px red'), 0],
  ['box-shadow inset spread', F('outline:none;box-shadow:inset 0 0 0 2px red'), 0],
  ['one visible layer of two', F('outline:none;box-shadow:0 0 0 0 blue, 0 0 0 2px red'), 0],
  ['box-shadow with var() color (unresolvable -> benefit of doubt)', F('outline:none;box-shadow:0 0 0 3px var(--ring)'), 0],
  // regression: original detections and passes
  ['outline:none alone', F('outline:none'), 1],
  ['outline:0 alone', F('outline:0'), 1],
  ['outline:none + box-shadow:none', F('outline:none;box-shadow:none'), 1],
  ['outline:none + border:0', F('outline:none;border:0'), 1],
  ['outline:none + border:1px solid red', F('outline:none;border:1px solid red'), 0],
  ['no outline removal', F('outline:2px solid red'), 0],
  ['outline-color:transparent + outline:none', F('outline:none;outline-color:transparent'), 1],
  ['original fixture (button:focus-visible{outline:none})', 'a { color: blue; }\n\nbutton:focus-visible {\n  outline: none;\n}\n\n.keep { margin: 0; }\n', 1],

  // ---- follow-up A1: offset-only box-shadow layers are visible ----
  ['A1 box-shadow 0 2px 0 red (hard offset shadow)', F('outline:none;box-shadow:0 2px 0 red'), 0],
  ['A1 box-shadow 2px 0 0 0 red (x offset only)', F('outline:none;box-shadow:2px 0 0 0 red'), 0],
  ['A1 box-shadow inset 0 -2px 0 0 red', F('outline:none;box-shadow:inset 0 -2px 0 0 red'), 0],
  ['A1 offset but fully transparent color', F('outline:none;box-shadow:0 2px 0 transparent'), 1],
  ['A1 offset but alpha 0 color', F('outline:none;box-shadow:0 2px 0 0 rgba(0,0,0,0)'), 1],
  ['A1 all four lengths zero stays invisible', F('outline:none;box-shadow:0 0 0 0 red'), 1],
  ['A1 two-value zero shadow (0 0 red)', F('outline:none;box-shadow:0 0 red'), 1],
  ['A1 mixed layers: zero + offset-only', F('outline:none;box-shadow:0 0 0 0 blue, 0 2px 0 red'), 0],

  // ---- follow-up A2: outline-width needs a non-none outline-style, in source order ----
  ['A2 outline:none; outline-width:2px (no color)', F('outline:none;outline-width:2px'), 1],
  ['A2 outline:0; outline-width:2px; outline-color:red', F('outline:0;outline-width:2px;outline-color:red'), 1],
  ['A2 outline:none; outline-style:solid; outline-width:2px', F('outline:none;outline-style:solid;outline-width:2px'), 0],
  ['A2 outline:none; outline-width:2px; outline-style:solid (order irrelevant between sub-props)', F('outline:none;outline-width:2px;outline-style:solid'), 0],
  ['A2 outline-style:solid; outline-width:2px; THEN outline:none (shorthand resets)', F('outline-style:solid;outline-width:2px;outline:none'), 1],
  ['A2 outline:none; outline-style:solid; outline-width:2px; outline-style:none (last style wins)', F('outline:none;outline-style:solid;outline-width:2px;outline-style:none'), 1],
  ['A2 outline:none; outline-style:solid; outline-width:2px; outline-color:transparent', F('outline:none;outline-style:solid;outline-width:2px;outline-color:transparent'), 1],
  ['A2 outline:none; outline:2px solid red (later shorthand restores)', F('outline:none;outline:2px solid red'), 0],
  ['A2 outline:2px solid red; outline:none (later shorthand removes)', F('outline:2px solid red;outline:none'), 1],
  ['A2 outline shorthand with width+color but NO style resets style to none', F('outline:none;outline:2px red'), 1],
  ['A2 outline-width:0 trigger, later style+width restore', F('outline-width:0;outline-style:solid;outline-width:3px'), 0],
  ['A2 outline-width:0 trigger, nothing restores', F('outline-width:0;outline-style:solid'), 1],
  ['A2 outline-style:hidden counts as none', F('outline:none;outline-style:hidden;outline-width:2px'), 1],
  ['A2 outline-style:var(--s) unknown -> benefit of the doubt', F('outline:none;outline-style:var(--s);outline-width:2px'), 0]
]);

// ---- 5. table-missing-headers --------------------------------------------
const T = body => `<table>${body}</table>`;
section('5. table-missing-headers', 'html', 'table-missing-headers', [
  // FP: valid headers/id complex table
  ['th id + td headers', T('<tr><th id="a">A</th><th id="b">B</th></tr><tr><td headers="a">1</td><td headers="b">2</td></tr>'), 0],
  ['multi-id headers="a b"', T('<tr><th id="a">A</th><th id="b">B</th></tr><tr><td headers="a b">1</td></tr>'), 0],
  ['mixed: row header th + col th', T('<tr><th id="c">C</th></tr><tr><th id="r">R</th><td headers="r c">1</td></tr>'), 0],
  // headers path must be complete and resolvable
  ['headers points at missing id', T('<tr><th id="a">A</th></tr><tr><td headers="zzz">1</td></tr>'), 1],
  ['one id of several missing', T('<tr><th id="a">A</th></tr><tr><td headers="a zzz">1</td></tr>'), 1],
  ['one td lacks headers (a simple table: browsers associate the header)', T('<tr><th id="a">A</th></tr><tr><td headers="a">1</td><td>2</td></tr>'), 0],
  ['headers refs a td id, not a th id', T('<tr><th id="a">A</th></tr><tr><td id="x">1</td><td headers="x">2</td></tr>'), 1],
  ['th ids but no td at all (one row: no data relationships)', T('<tr><th id="a">A</th></tr>'), 0],
  // regression: scope path and original detections
  ['all th have scope', T('<tr><th scope="col">A</th></tr><tr><td>1</td></tr>'), 0],
  ['no th, one cell (layout, not data)', T('<tr><td>1</td></tr>'), 0],
  ['no th in a 2x2 data table', T('<tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr>'), 1],
  ['th without scope in a simple table (scope not required)', T('<tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>'), 0],
  ['row and column headers without scope', T('<tr><th>X</th><th>A</th></tr><tr><th>R</th><td>2</td></tr>'), 1],
  ['one th missing scope in a simple table', T('<tr><th scope="col">A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr>'), 0],
  ['role=presentation exempt', '<table role="presentation"><tr><td>1</td></tr></table>', 0]
]);

// ---- follow-up: jsx-heading-empty treats empty aria-label as absent --------
section('jsx-heading-empty aria-label consistency', 'jsx', 'jsx-heading-empty', [
  ['aria-label="" is absent', J('<h1 aria-label=""/>'), 1],
  ['aria-label="   " is absent', J('<h1 aria-label="   "/>'), 1],
  ['aria-label={""} is absent', J('<h1 aria-label={""}/>'), 1],
  ['aria-label="Title" still rescues', J('<h1 aria-label="Title"/>'), 0],
  ['dynamic aria-label={x} still assumed present', J('<h1 aria-label={x}/>'), 0],
  ['text content still rescues', J('<h1>Title</h1>'), 0],
  ['empty heading still flagged', J('<h1></h1>'), 1]
]);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
