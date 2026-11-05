// Regression tests for the accessible-name rewire. Node-only, stubbed `vscode`.
// Each case carries its expected count AFTER the rewire; cases tagged GAP are the audit
// gaps the rewire closes (they fail on the pre-rewire code), the rest are regressions.
// Run: node test/rewire.test.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? {} : origLoad.call(this, req, ...rest);
};

const { parseHTML } = require('../src/parsers/htmlParser');
const { parseJSX } = require('../src/parsers/jsxParser');

let failed = 0, total = 0, gapFailed = 0, gapTotal = 0;
function section(title, kind, ruleName, cases) {
  console.log(`\n${title}`);
  const rule = require(`../src/rules/${kind}/${ruleName}`);
  for (const [label, src, expected] of cases) {
    const ast = kind === 'html' ? parseHTML(src) : parseJSX(src);
    const got = rule.check(ast, src, { isTrustedComponent: n => n === 'Input' }).length;
    const ok = got === expected;
    const gap = label.startsWith('GAP');
    total++; if (gap) gapTotal++;
    if (!ok) { failed++; if (gap) gapFailed++; }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (expected ${expected}, got ${got})`);
  }
}
const J = s => 'const a = ' + s + ';';

// ============================ HTML ============================================
section('1. button-empty', 'html', 'button-empty', [
  ['GAP dangling aria-labelledby', '<button aria-labelledby="zz"></button>', 1],
  ['GAP aria-labelledby resolving to empty text', '<span id="l"></span><button aria-labelledby="l"></button>', 1],
  ['GAP aria-hidden text does not count as a name', '<button><span aria-hidden="true">X</span></button>', 1],
  ['GAP title-only button has a name (was a false positive)', '<button title="Close"></button>', 0],
  ['GAP <input type="button"> no value', '<input type="button">', 1],
  // Browsers name a submit input with no value "Submit": it has an accessible name.
  ['<input type="submit"> no value (browser default name)', '<input type="submit">', 0],
  ['<input type="button"> no value', '<input type="button">', 1],
  ['GAP <input type="button" value=""> empty value', '<input type="button" value="">', 1],
  ['GAP <div role="button"> empty', '<div role="button"></div>', 1],
  ['GAP <a role="button"> empty', '<a role="button" href="#"></a>', 1],
  ['GAP <span role=" Button "> empty (case/space)', '<span role=" Button "></span>', 1],
  ['<input type="button" value="Go">', '<input type="button" value="Go">', 0],
  ['<input type="submit" value="Send">', '<input type="submit" value="Send">', 0],
  ['<input type="button" aria-label="Go">', '<input type="button" aria-label="Go">', 0],
  ['<input type="button" title="Go">', '<input type="button" title="Go">', 0],
  ['<input type="text"> is not a button', '<input type="text">', 0],
  ['<input type="reset"> out of scope', '<input type="reset">', 0],
  ['<div role="button">Go</div>', '<div role="button">Go</div>', 0],
  ['<div role="button" aria-label="Go">', '<div role="button" aria-label="Go"></div>', 0],
  ['<div role="button" aria-labelledby> resolved', '<span id="l">Go</span><div role="button" aria-labelledby="l"></div>', 0],
  ['<div> with no role', '<div></div>', 0],
  ['<button role="button"> empty counted once', '<button role="button"></button>', 1],
  // regression: original detections
  ['empty', '<button></button>', 1],
  ['whitespace', '<button>  \n </button>', 1],
  ['nbsp', '<button>&nbsp;</button>', 1],
  ['svg only', '<button><svg></svg></button>', 1],
  ['i icon only', '<button><i class="fa"></i></button>', 1],
  ['aria-label=""', '<button aria-label=""></button>', 1],
  ['img alt=""', '<button><img src="a" alt=""></button>', 1],
  ['img alt=" "', '<button><img src="a" alt=" "></button>', 1],
  ['comment only', '<button><!-- x --></button>', 1],
  ['text', '<button>Submit</button>', 0],
  ['aria-label', '<button aria-label="Close"></button>', 0],
  ['img alt', '<button><img src="a" alt="Close"></button>', 0],
  ['svg <title>', '<button><svg><title>Close</title></svg></button>', 0],
  ['sr-only text', '<button><span class="sr-only">Close</span></button>', 0],
  ['aria-labelledby resolved', '<span id="l">Close</span><button aria-labelledby="l"></button>', 0]
]);

section('2. form-missing-landmark', 'html', 'form-missing-landmark', [
  ['GAP dangling aria-labelledby', '<form aria-label="Other form"></form><form aria-labelledby="zz"></form>', 1],
  ['GAP whitespace aria-labelledby', '<form aria-label="Other form"></form><form aria-labelledby="  "></form>', 1],
  ['GAP aria-labelledby resolving to empty text', '<form aria-label="Other form"></form><span id="l"> </span><form aria-labelledby="l"></form>', 1],
  ['content is not a form name', '<form aria-label="Other form"></form><form>Contact us</form>', 1],
  ['no name', '<form aria-label="Other form"></form><form></form>', 1],
  ['aria-label=""', '<form aria-label="Other form"></form><form aria-label=""></form>', 1],
  ['aria-labelledby=""', '<form aria-label="Other form"></form><form aria-labelledby=""></form>', 1],
  ['role=search, no name', '<form aria-label="Other form"></form><form role="search"></form>', 1],
  ['aria-label', '<form aria-label="Other form"></form><form aria-label="Contact"></form>', 0],
  ['aria-labelledby resolved', '<form aria-label="Other form"></form><h2 id="h">Contact</h2><form aria-labelledby="h"></form>', 0],
  ['title', '<form aria-label="Other form"></form><form title="Contact"></form>', 0]
]);

section('3. input-label-missing', 'html', 'input-label-missing', [
  ['GAP <textarea> with no label', '<textarea></textarea>', 1],
  ['GAP <textarea> placeholder only', '<textarea placeholder="Your message"></textarea>', 1],
  ['GAP empty <label for> does not label', '<label for="a"></label><input id="a">', 1],
  ['GAP whitespace-only <label for>', '<label for="a">  </label><input id="a">', 1],
  ['GAP empty wrapping label', '<label><input type="text"></label>', 1],
  ['GAP dangling aria-labelledby', '<input aria-labelledby="nope">', 1],
  ['GAP aria-labelledby resolving to empty text', '<span id="l"></span><input aria-labelledby="l">', 1],
  ['GAP title-only input has a name (was a false positive)', '<input title="Name">', 0],
  ['<textarea aria-label>', '<textarea aria-label="Message"></textarea>', 0],
  ['<textarea> with label for', '<label for="m">Message</label><textarea id="m"></textarea>', 0],
  ['<textarea> wrapped in label', '<label>Message <textarea></textarea></label>', 0],
  ['label containing only an img alt', '<label for="a"><img src="x" alt="Email"></label><input id="a">', 0],
  ['aria-label wins over an empty label', '<label for="a"></label><input id="a" aria-label="Email">', 0],
  // regression: original detections and passes
  ['bare input', '<input type="text">', 1],
  ['default type', '<input>', 1],
  ['placeholder only', '<input placeholder="Name">', 1],
  ['label for missing target', '<label for="zz">x</label><input id="a">', 1],
  ['aria-label whitespace', '<input aria-label="  ">', 1],
  ['aria-label', '<input aria-label="Name">', 0],
  ['aria-labelledby resolved', '<span id="l">Name</span><input aria-labelledby="l">', 0],
  ['label for + text', '<label for="a">Name</label><input id="a">', 0],
  ['wrapped label with text', '<label>Name <input></label>', 0],
  ['deeply wrapped', '<label><span>Name</span><div><input></div></label>', 0],
  ['hidden exempt', '<input type="hidden">', 0],
  ['HIDDEN exempt (case)', '<input type="HIDDEN">', 0],
  ['submit exempt', '<input type="submit">', 0],
  ['button exempt', '<input type="button">', 0],
  ['reset exempt', '<input type="reset">', 0],
  ['image exempt (unchanged)', '<input type="image">', 0]
]);

section('4. select-no-label', 'html', 'select-no-label', [
  ['GAP dangling aria-labelledby', '<select aria-labelledby="nope"></select>', 1],
  ['GAP empty <label for>', '<label for="s"></label><select id="s"></select>', 1],
  ['GAP empty wrapping label', '<label><select></select></label>', 1],
  ['GAP aria-labelledby resolving to empty text', '<span id="l"></span><select aria-labelledby="l"></select>', 1],
  ['GAP title-only select has a name (was a false positive)', '<select title="Country"></select>', 0],
  ['option text is not a name for the select', '<select><option>A</option></select>', 1],
  ['no name', '<select></select>', 1],
  ['aria-labelledby=""', '<select aria-labelledby=""></select>', 1],
  ['aria-label', '<select aria-label="Country"></select>', 0],
  ['label for', '<label for="s">Country</label><select id="s"></select>', 0],
  ['wrapped label with text', '<label>Country <select></select></label>', 0],
  ['aria-labelledby resolved', '<span id="l">Country</span><select aria-labelledby="l"></select>', 0]
]);

section('5. anchor-no-text', 'html', 'anchor-no-text', [
  ['GAP dangling aria-labelledby, empty link', '<a href="x" aria-labelledby="nope"></a>', 1],
  ['GAP aria-hidden-only content', '<a href="x"><span aria-hidden="true">x</span></a>', 1],
  ['GAP vague aria-label "link"', '<a href="x" aria-label="link">z</a>', 1],
  ['GAP vague aria-label "Click here!"', '<a href="x" aria-label="Click here!"></a>', 1],
  ['GAP aria-labelledby resolving to a generic phrase', '<span id="l">click here</span><a href="x" aria-labelledby="l"></a>', 1],
  ['GAP aria-labelledby resolving to empty text', '<span id="l"></span><a href="x" aria-labelledby="l"></a>', 1],
  ['aria-labelledby resolved, descriptive', '<span id="l">Annual report</span><a href="x" aria-labelledby="l"></a>', 0],
  ['aria-labelledby overrides generic visible text', '<span id="l">Annual report</span><a href="x" aria-labelledby="l">click here</a>', 0],
  ['aria-label overrides generic visible text', '<a href="x" aria-label="Annual report">click here</a>', 0],
  ['empty aria-label falls through to content', '<a href="x" aria-label="">Annual report</a>', 0],
  ['empty aria-label and empty content', '<a href="x" aria-label=""></a>', 1],
  ['dangling labelledby falls through to content', '<a href="x" aria-labelledby="nope">Annual report</a>', 0],
  ['title-only link keeps passing', '<a href="x" title="Annual report"></a>', 0],
  // regression: original detections (layered checks)
  ['empty', '<a href="x"></a>', 1],
  ['svg only', '<a href="x"><svg></svg></a>', 1],
  ['i icon only', '<a href="x"><i class="fa"></i></a>', 1],
  ['img alt=""', '<a href="x"><img alt="" src="a"></a>', 1],
  ['click here', '<a href="x">click here</a>', 1],
  ['Read more', '<a href="x">Read more</a>', 1],
  ['Click here!', '<a href="x">Click here!</a>', 1],
  // A URL as link text says where the link goes: it meets 2.4.4.
  ['URL text', '<a href="x">https://example.com/page</a>', 0],
  ['img alt non-empty', '<a href="x"><img alt="Home" src="a"></a>', 0],
  ['descriptive text', '<a href="x">Read the annual report</a>', 0],
  ['aria-label', '<a href="x" aria-label="Annual report"></a>', 0]
]);

section('6. iframe-missing-title', 'html', 'iframe-missing-title', [
  ['GAP aria-label names the frame (was a false positive)', '<iframe src="x" aria-label="Payment form"></iframe>', 0],
  ['GAP aria-labelledby resolved names the frame (was a false positive)', '<h2 id="h">Payment</h2><iframe src="x" aria-labelledby="h"></iframe>', 0],
  ['GAP dangling aria-labelledby', '<iframe src="x" aria-labelledby="nope"></iframe>', 1],
  ['GAP aria-labelledby resolving to empty text', '<span id="l"></span><iframe src="x" aria-labelledby="l"></iframe>', 1],
  ['fallback content is not a frame name', '<iframe src="x">Your browser does not support frames</iframe>', 1],
  ['no name', '<iframe src="x"></iframe>', 1],
  ['title=""', '<iframe src="x" title=""></iframe>', 1],
  ['title whitespace', '<iframe src="x" title="   "></iframe>', 1],
  ['aria-label=""', '<iframe src="x" aria-label=""></iframe>', 1],
  ['title', '<iframe src="x" title="Payment form"></iframe>', 0]
]);

// ============================ JSX ==============================================
section('7. jsx-label-missing', 'jsx', 'jsx-label-missing', [
  ['GAP aria-label=""', J('<input aria-label=""/>'), 1],
  ['GAP aria-label whitespace', J('<input aria-label="   "/>'), 1],
  ['GAP aria-labelledby=""', J('<input aria-labelledby=""/>'), 1],
  ['GAP aria-labelledby resolving to empty static text', J('<><span id="l"/><input aria-labelledby="l"/></>'), 1],
  ['GAP empty <label htmlFor>', J('<><label htmlFor="a"></label><input id="a"/></>'), 1],
  ['GAP whitespace <label htmlFor>', J('<><label htmlFor="a">   </label><input id="a"/></>'), 1],
  ['GAP label whose only child is {""}', J('<><label htmlFor="a">{""}</label><input id="a"/></>'), 1],
  ['GAP empty wrapping label', J('<label><input/></label>'), 1],
  ['GAP dynamic htmlFor/id pair but label is empty', J('<><label htmlFor={id}></label><input id={id}/></>'), 1],
  ['GAP title-only input has a name (was a false positive)', J('<input title="Name"/>'), 0],
  ['aria-label={x} dynamic assumed named', J('<input aria-label={x}/>'), 0],
  ['aria-labelledby resolved to text', J('<><span id="l">Name</span><input aria-labelledby="l"/></>'), 0],
  ['aria-labelledby resolved to dynamic children', J('<><span id="l">{t}</span><input aria-labelledby="l"/></>'), 0],
  ['aria-labelledby unresolvable in this file -> assumed named (target may be elsewhere)', J('<input aria-labelledby="n"/>'), 0],
  ['label with dynamic children', J('<><label htmlFor="a">{children}</label><input id="a"/></>'), 0],
  ['label with custom component child', J('<><label htmlFor="a"><Trans/></label><input id="a"/></>'), 0],
  ['wrapping label with text', J('<label>Name <input/></label>'), 0],
  ['label htmlFor + text', J('<><label htmlFor="a">Name</label><input id="a"/></>'), 0],
  ['dynamic htmlFor/id pair + text', J('<><label htmlFor={id}>Name</label><input id={id}/></>'), 0],
  // regression: original detections
  ['bare input', J('<input type="text"/>'), 1],
  ['textarea', J('<textarea/>'), 1],
  ['select', J('<select/>'), 1],
  ['placeholder only', J('<input placeholder="x"/>'), 1],
  ['label htmlFor mismatch', J('<><label htmlFor="b">x</label><input id="a"/></>'), 1],
  ['sibling label is not an ancestor', J('<div><label>Name</label><input/></div>'), 1],
  ['aria-label', J('<input aria-label="Name"/>'), 0],
  ['hidden exempt', J('<input type="hidden"/>'), 0],
  ['trusted component skipped', J('<Input/>'), 0]
]);

section('8. jsx-anchor-no-content', 'jsx', 'jsx-anchor-no-content', [
  ['GAP <i/> icon only', J('<a href="x"><i className="fa"/></a>'), 1],
  ['GAP <svg/> only', J('<a href="x"><svg/></a>'), 1],
  ['GAP <img alt=""/> only', J('<a href="x"><img alt=""/></a>'), 1],
  ['GAP <img/> no alt only', J('<a href="x"><img src="a"/></a>'), 1],
  ['GAP {""} only', J('<a href="x">{""}</a>'), 1],
  ['GAP {null} only', J('<a href="x">{null}</a>'), 1],
  ['GAP aria-hidden child only', J('<a href="x"><span aria-hidden="true">x</span></a>'), 1],
  ['GAP aria-label=""', J('<a href="x" aria-label=""/>'), 1],
  ['GAP aria-labelledby=""', J('<a href="x" aria-labelledby=""/>'), 1],
  ['GAP vague aria-label "link"', J('<a href="x" aria-label="link"/>'), 1],
  ['GAP aria-labelledby resolving to a generic phrase', J('<><span id="l">click here</span><a href="x" aria-labelledby="l"/></>'), 1],
  ['GAP aria-labelledby resolving to empty static text', J('<><span id="l"/><a href="x" aria-labelledby="l"/></>'), 1],
  ['GAP title-only link has a name (was a false positive)', J('<a href="x" title="Annual report"/>'), 0],
  ['<img alt="Home"/> only', J('<a href="x"><img alt="Home"/></a>'), 0],
  ['<img alt={t}/> dynamic alt', J('<a href="x"><img alt={t}/></a>'), 0],
  ['<svg><title>Home</title></svg>', J('<a href="x"><svg><title>Home</title></svg></a>'), 0],
  ['<i/> plus text', J('<a href="x"><i className="fa"/> Home</a>'), 0],
  ['custom <Icon/> child is opaque -> assumed named', J('<a href="x"><Icon/></a>'), 0],
  ['<span>Report</span> child', J('<a href="x"><span>Report</span></a>'), 0],
  ['aria-label={x} dynamic', J('<a href="x" aria-label={x}/>'), 0],
  ['aria-labelledby resolved, descriptive', J('<><span id="l">Annual report</span><a href="x" aria-labelledby="l"/></>'), 0],
  ['aria-labelledby unresolvable here -> assumed named', J('<a href="x" aria-labelledby="zz"/>'), 0],
  ['{children}', J('<a href="x">{children}</a>'), 0],
  ['mixed text + dynamic', J('<a href="x">Read {title}</a>'), 0],
  // regression: original detections
  ['empty', J('<a href="x"></a>'), 1],
  ['click here', J('<a href="x">click here</a>'), 1],
  ['Click here!', J('<a href="x">Click here!</a>'), 1],
  ['{"read more"}', J('<a href="x">{"read more"}</a>'), 1],
  ['URL text', J('<a href="x">https://example.com/page</a>'), 0],
  ['descriptive text', J('<a href="x">Read the annual report</a>'), 0],
  ['aria-label', J('<a href="x" aria-label="Report"/>'), 0],
  ['aria-label beats generic text', J('<a href="x" aria-label="Annual report">click here</a>'), 0]
]);

section('9. jsx-heading-empty (aria path only)', 'jsx', 'jsx-heading-empty', [
  ['GAP aria-labelledby resolved to text names the heading (was a false positive)', J('<><span id="t">Title</span><h1 aria-labelledby="t"/></>'), 0],
  ['GAP aria-labelledby resolving to empty static text', J('<><span id="t"/><h1 aria-labelledby="t"/></>'), 1],
  ['GAP aria-labelledby=""', J('<h1 aria-labelledby=""/>'), 1],
  ['GAP aria-labelledby unresolvable here -> assumed named (rule ignored aria-labelledby entirely)', J('<h1 aria-labelledby="zz"/>'), 0],
  ['aria-label=""', J('<h1 aria-label=""/>'), 1],
  ['aria-label="Title"', J('<h1 aria-label="Title"/>'), 0],
  ['aria-label={x} dynamic', J('<h1 aria-label={x}/>'), 0],
  // existing child-content logic is intentionally untouched, including the icon-only gap
  ['KEPT GAP <i/> icon only passes', J('<h1><i className="fa"/></h1>'), 0],
  ['KEPT GAP <svg/> only passes', J('<h1><svg/></h1>'), 0],
  ['KEPT GAP <img alt=""/> only passes', J('<h1><img alt=""/></h1>'), 0],
  ['KEPT GAP {""} only passes', J('<h1>{""}</h1>'), 0],
  ['title is NOT a heading name (unchanged)', J('<h1 title="x"/>'), 1],
  ['empty', J('<h1></h1>'), 1],
  ['self-closing', J('<h2/>'), 1],
  ['whitespace', J('<h1>   </h1>'), 1],
  ['text', J('<h1>Title</h1>'), 0],
  ['{children}', J('<h1>{children}</h1>'), 0]
]);

console.log(`\n${total - failed}/${total} passed` + (gapTotal ? `  (gap cases: ${gapTotal - gapFailed}/${gapTotal} passing)` : ''));
process.exit(failed ? 1 : 0);
