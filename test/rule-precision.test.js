// Precision corpus: realistic snippets and exactly which rules must (and must not) report them, with severity.
// Every "clean" case is something a careful developer writes that WCAG accepts; every "flag" case is a real failure.
// Run: node test/rule-precision.test.js
const { analyzeDocument } = require('../src/analyzer');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}

const LANG = { html: 'html', jsx: 'javascriptreact', css: 'css' };
const run = async (lang, code, level) => analyzeDocument({ getText: () => code, languageId: LANG[lang] }, { complianceLevel: level || 'AA', isRuleDisabled: () => false, isTrustedComponent: () => false });
const page = (body) => '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>\n' + body + '\n</body></html>';
const jsx = (body) => 'export const C = () => (\n<div>\n' + body + '\n</div>\n);\n';

// [label, lang, code, expected [ruleId, severity] pairs (sorted), level?]
const CASES = [
  // ---------------------------------------------------------------- links
  ['URL as link text in a sentence (the reported false positive)', 'html', page('<p>Our platform is hosted at <a href="https://www.accessgenhq.com">www.accessgenhq.com</a>.</p>'), []],
  ['URL as link text on its own (the reported false positive)', 'html', page('<a class="ag-link" href="https://www.accessgenhq.com">www.accessgenhq.com</a>'), []],
  ['full https URL as link text', 'html', page('<p>Docs: <a href="https://example.com/docs">https://example.com/docs</a></p>'), []],
  ['generic text explained by its sentence: fine at AA', 'html', page('<p>For pricing details, <a href="/pricing">click here</a>.</p>'), []],
  ['...but reported at AAA (2.4.9)', 'html', page('<p>For pricing details, <a href="/pricing">click here</a>.</p>'), [['anchor-no-text', 'advisory']], 'AAA'],
  ['generic text with nothing around it', 'html', page('<a href="/pricing">Click here</a>'), [['anchor-no-text', 'warning']]],
  ['"Read more" in a card with no text in its block', 'html', page('<div class="card"><a href="/post/1">Read more</a></div>'), [['anchor-no-text', 'warning']]],
  ['empty link', 'html', page('<a href="/about"></a>'), [['anchor-no-text', 'critical']]],
  ['icon link with a labelled svg', 'html', page('<a href="https://x.com/acme"><svg aria-label="Acme on X"></svg></a>'), []],
  ['icon link with aria-label', 'html', page('<a href="/cart" aria-label="Cart"><i class="icon-cart" aria-hidden="true"></i></a>'), []],
  ['icon-only link with no name', 'html', page('<a href="/cart"><i class="icon-cart"></i></a>'), [['anchor-no-text', 'critical']]],
  ['<a> without href is not a link', 'html', page('<a name="top"></a><a id="anchor"></a>'), []],
  ['hidden link', 'html', page('<div hidden><a href="/x"></a></div><a href="/y" aria-hidden="true" tabindex="-1"></a>'), []],
  ['image link named by alt', 'html', page('<a href="/"><img src="logo.png" alt="Acme home"></a>'), []],
  ['JSX: domain as link text', 'jsx', jsx('<p>Visit <a href="https://acme.com">acme.com</a></p>'), []],
  ['JSX: generic text explained by its sentence', 'jsx', jsx('<p>To read the full report <a href="/r">click here</a>.</p>'), []],
  ['JSX: generic text next to dynamic text is not reported', 'jsx', jsx('<li>{post.title} <a href={post.url}>Read more</a></li>'), []],
  ['JSX: lone generic link', 'jsx', jsx('<a href="/r">Learn more</a>'), [['jsx-anchor-no-content', 'warning']]],
  ['JSX: empty link', 'jsx', jsx('<a href="/r"></a>'), [['jsx-anchor-no-content', 'critical']]],
  ['JSX: <a> without href, or with spread props', 'jsx', jsx('<a onClick={go}></a><a {...props}></a>'), [['jsx-onclick-no-keyboard', 'critical']]],

  // ---------------------------------------------------------------- buttons
  ['submit input without value gets the browser default name', 'html', page('<form aria-label="s"><input type="submit"><input type="reset"></form>'), []],
  ['input type=button without value has no name', 'html', page('<input type="button">'), [['button-empty', 'critical']]],
  ['icon button with labelled svg', 'html', page('<button><svg aria-label="Close dialog"></svg></button>'), []],
  ['icon button with svg title', 'html', page('<button><svg><title>Close</title></svg></button>'), []],
  ['empty button', 'html', page('<button></button>'), [['button-empty', 'critical']]],
  ['hidden empty button', 'html', page('<button hidden></button><div style="display: none"><button></button></div>'), []],

  // ---------------------------------------------------------------- form controls
  ['labelled input, wrapped and with for', 'html', page('<label>Name <input></label><label for="e">Email</label><input id="e" type="email">'), []],
  ['placeholder only: a weak name, not a missing one', 'html', page('<input type="search" placeholder="Search products">'), [['input-label-missing', 'warning']]],
  ['no name at all', 'html', page('<input type="text">'), [['input-label-missing', 'critical']]],
  ['hidden and non-text inputs need no label', 'html', page('<input type="hidden" name="t"><input type="submit" value="Go"><div hidden><input></div>'), []],
  ['select with a label', 'html', page('<label for="c">Country</label><select id="c"><option>UK</option></select>'), []],

  // ---------------------------------------------------------------- images
  ['decorative image hidden from AT needs no alt', 'html', page('<img src="x.png" aria-hidden="true"><img src="y.png" role="presentation">'), []],
  ['image without alt', 'html', page('<img src="team.jpg">'), [['img-alt-missing', 'critical']]],
  ['JSX: spread props may carry alt', 'jsx', jsx('<img src={src} {...rest} />'), []],
  ['JSX: aria-hidden image', 'jsx', jsx('<img src="x.png" aria-hidden="true" />'), []],

  // ---------------------------------------------------------------- headings
  ['heading skip is a best practice, not a failure', 'html', page('<h1>A</h1><h3>B</h3>'), [['heading-hierarchy-skip', 'advisory']]],
  ['heading with only an image that has alt is not empty', 'html', page('<h1><img src="logo.png" alt="Acme"></h1>'), []],
  ['heading with an empty span is empty', 'html', page('<h2><span></span></h2>'), [['heading-empty', 'critical']]],

  // ---------------------------------------------------------------- forms, tables, frames, ids
  ['a single unnamed form is fine', 'html', page('<form><label>Email <input type="email"></label><button>Subscribe</button></form>'), []],
  ['several unnamed forms: advise naming them', 'html', page('<form><label>Q <input></label></form><form><label>E <input></label></form>'), [['form-missing-landmark', 'advisory'], ['form-missing-landmark', 'advisory']]],
  ['simple data table with th: scope not required', 'html', page('<table><tr><th>Name</th><th>Age</th></tr><tr><td>A</td><td>1</td></tr></table>'), []],
  ['one-row or one-column table is layout, not data', 'html', page('<table><tr><td>A</td><td>B</td></tr></table><table><tr><td>A</td></tr><tr><td>B</td></tr></table>'), []],
  ['data table without any th', 'html', page('<table><tr><td>Name</td><td>Age</td></tr><tr><td>A</td><td>1</td></tr></table>'), [['table-missing-headers', 'warning']]],
  ['hidden iframe needs no title', 'html', page('<iframe src="/t" hidden></iframe><iframe src="/p" aria-hidden="true" tabindex="-1"></iframe>'), []],
  ['visible iframe without title', 'html', page('<iframe src="/map"></iframe>'), [['iframe-missing-title', 'critical']]],
  ['duplicate id that nothing references: advisory only', 'html', page('<div id="a">1</div><div id="a">2</div>'), [['duplicate-id', 'advisory']]],
  ['duplicate id a label points at: real failure', 'html', page('<label for="n">Name</label><input id="n"><input id="n" aria-label="Other">'), [['duplicate-id', 'critical']]],
  ['muted or hidden video needs no captions; audio needs a transcript instead', 'html', page('<video src="bg.mp4" muted autoplay></video><video src="v.mp4" aria-hidden="true"></video>'), []],
  ['video with sound and no captions', 'html', page('<video src="talk.mp4" controls></video>'), [['media-missing-captions', 'critical']]],
  ['autofocus is advice, not a failure', 'html', page('<input aria-label="Search" autofocus>'), [['autofocus-used', 'advisory']]],

  // ---------------------------------------------------------------- clickable non-buttons
  ['div delegating clicks to real buttons is not a fake button', 'html', page('<div onclick="handle(event)"><button>One</button><button>Two</button></div>'), []],
  ['clickable div', 'html', page('<div onclick="go()">Open</div>'), [['div-used-as-button', 'warning']]],
  ['JSX: custom components handle their own semantics', 'jsx', jsx('<Card onClick={open} onMouseOver={hover}>Hi</Card><MenuItem onClick={x} />'), []],
  ['JSX: clickable div is ONE issue, not two', 'jsx', jsx('<div onClick={open}>Open</div>'), [['jsx-onclick-no-keyboard', 'critical']]],
  ['JSX: keyboard handler but no role is the role issue only', 'jsx', jsx('<div onClick={open} onKeyDown={key} tabIndex={0}>Open</div>'), [['jsx-interactive-no-role', 'warning']]],
  ['JSX: native button and aria-hidden overlay', 'jsx', jsx('<button onClick={x}>Go</button><div aria-hidden="true" onClick={close} />'), []],

  // ---------------------------------------------------------------- CSS
  ['the recommended focus-visible pattern', 'css', 'button:focus:not(:focus-visible) { outline: none; }\nbutton:focus-visible { outline: 2px solid #005fcc; }\n', []],
  ['outline removed on :focus but restored by a :focus-visible rule', 'css', '.btn:focus { outline: none; }\n.btn:focus-visible { box-shadow: 0 0 0 3px #005fcc; }\n', []],
  ['Firefox inner focus border reset', 'css', 'button::-moz-focus-inner { outline: 0; border: 0; }\n', []],
  ['programmatic focus target', 'css', '[tabindex="-1"]:focus { outline: 0; }\n', []],
  ['outline removed on :focus with nothing instead', 'css', 'a:focus { outline: none; }\n', [['outline-removed', 'critical']]],
  ['styling :focus satisfies 2.4.7; :focus-visible is only advice', 'css', 'a:focus { outline: 3px solid #005fcc; }\n', [['focus-visible-missing', 'advisory']]],
  ['animation: none is not an animation', 'css', '.x { animation: none; }\n', [], 'AAA']
];

(async () => {
  console.log('\nprecision corpus');
  for (const [label, lang, code, expected, level] of CASES) {
    const found = (await run(lang, code, level)).map(v => [v.ruleId, v.severity]).sort();
    check(label, found, [...expected].sort());
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
