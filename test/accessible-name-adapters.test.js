// Unit tests for the JSX adapter, the HTML helper's `content` option and the form-label module.
// Run: node test/accessible-name-adapters.test.js
const { parseHTML } = require('../src/parsers/htmlParser');
const { parseJSX, walkJSX } = require('../src/parsers/jsxParser');
const { getAccessibleName } = require('../src/rules/shared/accessibleName');
const { getJsxAccessibleName } = require('../src/rules/shared/jsxAccessibleName');
const { getControlName } = require('../src/rules/shared/formLabel');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`);
}

// ---- HTML helper: content option ------------------------------------------------
console.log('\nHTML getAccessibleName options.content');
function htmlNode(html, tag) {
  const root = parseHTML(html);
  let found = null;
  (function walk(n) {
    if (found) return;
    if (n.tagName === tag) { found = n; return; }
    [...(n.childNodes || []), ...((n.content && n.content.childNodes) || [])].forEach(walk);
  })(root);
  return { root, node: found };
}
let h = htmlNode('<form>Contact us</form>', 'form');
check('default: content is a name', getAccessibleName(h.node, h.root), { name: 'Contact us', source: 'content' });
check('content:false skips content', getAccessibleName(h.node, h.root, { content: false }), { name: '', source: null });
h = htmlNode('<iframe title="T">fallback</iframe>', 'iframe');
check('content:false still honours title', getAccessibleName(h.node, h.root, { content: false }), { name: 'T', source: 'title' });
h = htmlNode('<select aria-label="Country"><option>A</option></select>', 'select');
check('content:false still honours aria-label', getAccessibleName(h.node, h.root, { content: false }), { name: 'Country', source: 'aria-label' });

// ---- formLabel.getControlName ---------------------------------------------------------
console.log('\nformLabel.getControlName');
function control(html, tag) {
  const { root, node } = htmlNode(html, tag);
  return getControlName(node, root);
}
check('label for', control('<label for="a">Email</label><input id="a">', 'input'), { name: 'Email', source: 'label' });
check('wrapping label', control('<label>Email <input></label>', 'input'), { name: 'Email', source: 'label' });
check('empty label for -> no name', control('<label for="a"></label><input id="a">', 'input'), { name: '', source: null });
check('empty wrapping label -> no name', control('<label><input></label>', 'input'), { name: '', source: null });
check('aria-label beats label', control('<label for="a">Email</label><input id="a" aria-label="Mail">', 'input'), { name: 'Mail', source: 'aria-label' });
check('first named label wins over an empty one', control('<label for="a"></label><label for="a">Email</label><input id="a">', 'input'), { name: 'Email', source: 'label' });
check('textarea works', control('<label for="m">Msg</label><textarea id="m"></textarea>', 'textarea'), { name: 'Msg', source: 'label' });
check('select content is not a name', control('<select><option>A</option></select>', 'select'), { name: '', source: null });
check('placeholder is not a name', control('<input placeholder="Name">', 'input'), { name: '', source: null });
check('label for another id does not apply', control('<label for="b">X</label><input id="a">', 'input'), { name: '', source: null });

// ---- JSX adapter ----------------------------------------------------------------------
console.log('\ngetJsxAccessibleName');
function jsx(src, tag, opts) {
  const ast = parseJSX('const a = ' + src + ';');
  let found = null;
  walkJSX(ast, n => { if (!found && n.type === 'JSXElement' && n.openingElement.name.name === tag) found = n; });
  return getJsxAccessibleName(found, ast, opts);
}
const N = (name, source, unknown = false) => ({ name, source, unknown });
check('aria-label static', jsx('<a aria-label="Home"/>', 'a'), N('Home', 'aria-label'));
check('aria-label="" absent', jsx('<a aria-label=""/>', 'a'), N('', null));
check('aria-label whitespace absent', jsx('<a aria-label="   "/>', 'a'), N('', null));
check('aria-label={"x"} static', jsx('<a aria-label={"x"}/>', 'a'), N('x', 'aria-label'));
check('aria-label={`x`} static template', jsx('<a aria-label={`x`}/>', 'a'), N('x', 'aria-label'));
check('aria-label={x} unknown', jsx('<a aria-label={x}/>', 'a'), N('', 'aria-label', true));
check('aria-label={`a${b}`} unknown', jsx('<a aria-label={`a${b}`}/>', 'a'), N('', 'aria-label', true));
check('aria-label={undefined} absent', jsx('<a aria-label={undefined}/>', 'a'), N('', null));
check('empty aria-label falls through to content', jsx('<a aria-label="">Go</a>', 'a'), N('Go', 'content'));
check('text content', jsx('<a>  Read   more </a>', 'a'), N('Read more', 'content'));
check('{"x"} string expression', jsx('<a>{"Go"}</a>', 'a'), N('Go', 'content'));
check('{""} / {null} / {false} render nothing', jsx('<a>{""}{null}{false}{undefined}</a>', 'a'), N('', null));
check('number child', jsx('<a>{3}</a>', 'a'), N('3', 'content'));
check('dynamic child -> unknown', jsx('<a>{children}</a>', 'a'), N('', 'content', true));
check('text + dynamic -> unknown', jsx('<a>Read {t}</a>', 'a'), N('', 'content', true));
check('custom component child -> unknown', jsx('<a><Icon/></a>', 'a'), N('', 'content', true));
check('member-expression child -> unknown', jsx('<a><Foo.Bar/></a>', 'a'), N('', 'content', true));
check('native empty child -> no name', jsx('<a><i className="fa"/></a>', 'a'), N('', null));
check('nested native text', jsx('<a><span>Go</span></a>', 'a'), N('Go', 'content'));
check('aria-hidden child skipped', jsx('<a><span aria-hidden="true">x</span></a>', 'a'), N('', null));
check('aria-hidden={true} is dynamic-looking but literal boolean: not treated as hidden', jsx('<a><span aria-hidden={true}>x</span></a>', 'a'), N('x', 'content'));
check('img alt', jsx('<a><img alt="Home"/></a>', 'a'), N('Home', 'content'));
check('img alt=""', jsx('<a><img alt=""/></a>', 'a'), N('', null));
check('img alt={x} unknown', jsx('<a><img alt={x}/></a>', 'a'), N('', 'content', true));
check('svg <title>', jsx('<a><svg><title>Home</title></svg></a>', 'a'), N('Home', 'content'));
check('fragment child', jsx('<a><>Go</></a>', 'a'), N('Go', 'content'));
check('dangerouslySetInnerHTML child -> unknown', jsx('<a><span dangerouslySetInnerHTML={{__html: h}}/></a>', 'a'), N('', 'content', true));
check('title fallback', jsx('<a title="Home"/>', 'a'), N('Home', 'title'));
check('content beats title', jsx('<a title="T">Go</a>', 'a'), N('Go', 'content'));
check('options.title:false', jsx('<a title="Home"/>', 'a', { title: false }), N('', null));
check('options.content:false', jsx('<a title="T">Go</a>', 'a', { content: false }), N('T', 'title'));
check('options.content:false + title:false (heading aria path)', jsx('<h1 title="T">Go</h1>', 'h1', { content: false, title: false }), N('', null));
check('JSXOpeningElement accepted', (() => {
  const ast = parseJSX('const a = <input aria-label="Name"/>;');
  let o = null; walkJSX(ast, n => { if (n.type === 'JSXOpeningElement') o = n; });
  return getJsxAccessibleName(o, ast, { content: false });
})(), N('Name', 'aria-label'));
check('null element is safe', getJsxAccessibleName(null, null), N('', null));
// aria-labelledby
check('labelledby resolved', jsx('<><span id="l">Delete</span><button aria-labelledby="l"/></>', 'button'), N('Delete', 'aria-labelledby'));
check('labelledby several ids joined', jsx('<><b id="a">Delete</b><i id="b">item</i><button aria-labelledby="a b"/></>', 'button'), N('Delete item', 'aria-labelledby'));
check('labelledby beats aria-label', jsx('<><span id="l">Ref</span><button aria-labelledby="l" aria-label="L"/></>', 'button'), N('Ref', 'aria-labelledby'));
check('labelledby target hidden still counts', jsx('<><span id="l" aria-hidden="true">Ref</span><button aria-labelledby="l"/></>', 'button'), N('Ref', 'aria-labelledby'));
check('labelledby resolved to empty falls through to aria-label', jsx('<><span id="l"/><button aria-labelledby="l" aria-label="Go"/></>', 'button'), N('Go', 'aria-label'));
check('labelledby resolved to empty, nothing else -> no name', jsx('<><span id="l"/><button aria-labelledby="l"/></>', 'button'), N('', null));
check('labelledby="" absent', jsx('<button aria-labelledby=""/>', 'button'), N('', null));
check('labelledby not in this file -> unknown (target may be in another component)', jsx('<button aria-labelledby="zz"/>', 'button'), N('', 'aria-labelledby', true));
check('labelledby={x} unknown', jsx('<button aria-labelledby={x}/>', 'button'), N('', 'aria-labelledby', true));
check('labelledby target with dynamic children -> unknown', jsx('<><span id="l">{t}</span><button aria-labelledby="l"/></>', 'button'), N('', 'aria-labelledby', true));
check('labelledby target uses its own aria-label', jsx('<><span id="l" aria-label="Ref"/><button aria-labelledby="l"/></>', 'button'), N('Ref', 'aria-labelledby'));
check('labelledby + dynamic ids in file stays unknown when empty', jsx('<><span id={x}/><button aria-labelledby="l"/></>', 'button'), N('', 'aria-labelledby', true));
check('labelledby falls through past a resolved-empty ref with content present', jsx('<><span id="l"/><button aria-labelledby="l">Go</button></>', 'button'), N('Go', 'content'));

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
