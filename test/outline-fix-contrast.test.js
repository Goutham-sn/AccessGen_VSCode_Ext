// Regression tests for the computed-contrast fix in outline-removed.js and the shared color math.
// Node-only (no vscode needed). Run: node test/outline-fix-contrast.test.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? {} : origLoad.call(this, req, ...rest);
};

const fs = require('fs');
const path = require('path');
const { parseCSS } = require('../src/parsers/cssParser');
const rule = require('../src/rules/css/outline-removed');
const cm = require('../src/rules/shared/colorMath');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}

// One rule block -> { violation, fix, text }. `decls` are the declarations inside .x:focus { ... }.
function run(decls, selector = '.x:focus') {
  const css = selector + ' {\n' + decls.map(d => '  ' + d + '\n').join('') + '}\n';
  const violations = rule.check(parseCSS(css), css, {});
  const v = violations[0];
  return { css, violations, v, fix: v ? rule.fix(v, css) : undefined };
}
const colorOf = (r) => (r.fix ? r.fix.newText.match(/#[0-9a-f]{6}/)[0] : null);
const fmt = (c) => 'outline: 2px solid ' + c + '; outline-offset: -2px;';
const ratioVs = (hex, bg) => { const a = cm.parseColor(hex), b = cm.parseColor(bg); return cm.getContrastRatio(cm.getLuminance(a.r, a.g, a.b), cm.getLuminance(b.r, b.g, b.b)); };

// ---------------------------------------------------------------- tier + shape
console.log('\ntier and output format');
check('outline-removed is tagged "safe" and still provides fix()', [rule.fixTier, typeof rule.fix], ['safe', 'function']);
check('output format is exactly: outline: 2px solid <#rrggbb>; outline-offset: -2px;', run(['background-color: #ffffff;', 'outline: none;']).fix, { newText: fmt('#000000') });

// ---------------------------------------------------------------- dark -> white, light -> black
console.log('\nliteral background, dark: picks a white outline');
for (const bg of ['#000000', '#1a1a2e', '#212529', 'rgb(33, 37, 41)', 'navy', 'black', '#000', '#333', '#0066cc', '#d32f2f', 'maroon']) {
  check('background ' + bg + ' -> #ffffff', colorOf(run(['background-color: ' + bg + ';', 'outline: none;'])), '#ffffff');
}
console.log('\nliteral background, light: picks a black outline');
for (const bg of ['#ffffff', '#f5f5f5', '#fff', '#fafafa', 'white', 'rgb(255, 255, 255)', '#ffeb3b', 'yellow', 'silver', '#e0e0e0', 'aqua']) {
  check('background ' + bg + ' -> #000000', colorOf(run(['background-color: ' + bg + ';', 'outline: none;'])), '#000000');
}
console.log('\nboth candidates clear 3:1: the more visible one wins');
check('#777777 (black 4.69:1 vs white 4.48:1) -> black', colorOf(run(['background-color: #777777;', 'outline: none;'])), '#000000');
check('#757575 (white 4.60:1 vs black 4.57:1) -> white', colorOf(run(['background-color: #757575;', 'outline: none;'])), '#ffffff');

// ---------------------------------------------------------------- the guarantee, swept
console.log('\nthe 3:1 guarantee holds across the whole range');
let sweepBad = [], sweepN = 0;
const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255];
for (const r of steps) for (const g of steps) for (const b of steps) {
  const bg = 'rgb(' + r + ', ' + g + ', ' + b + ')';
  const res = run(['background-color: ' + bg + ';', 'outline: none;']);
  const c = colorOf(res);
  sweepN++;
  if (!c) { sweepBad.push(bg + ' -> no fix'); continue; }
  const chosen = ratioVs(c, bg), other = ratioVs(c === '#000000' ? '#ffffff' : '#000000', bg);
  if (chosen < 3 || chosen < other) sweepBad.push(bg + ' -> ' + c + ' ' + chosen.toFixed(2));
}
check('every one of ' + sweepN + ' sampled backgrounds gets a fix', sweepBad.filter(x => /no fix/.test(x)).length, 0);
check('...whose outline has >= 3:1 against the background and is the better of black/white', sweepBad.filter(x => !/no fix/.test(x)), []);
check('the weakest possible case (best of black/white) is still above 3:1', (() => {
  let worst = Infinity;
  for (let v = 0; v <= 255; v++) { const bg = 'rgb(' + v + ', ' + v + ', ' + v + ')'; worst = Math.min(worst, Math.max(ratioVs('#000000', bg), ratioVs('#ffffff', bg))); }
  return worst >= 4.5;
})(), true);

// ---------------------------------------------------------------- which declaration counts
console.log('\nwhich background-color is used');
check('the last background-color in the block wins', colorOf(run(['background-color: #ffffff;', 'background-color: #000000;', 'outline: none;'])), '#ffffff');
check('...wherever it sits relative to outline', colorOf(run(['outline: none;', 'background-color: #000000;'])), '#ffffff');
check('!important beats a later normal declaration', colorOf(run(['background-color: #000000 !important;', 'background-color: #ffffff;', 'outline: none;'])), '#ffffff');
check('a later !important beats an earlier one', colorOf(run(['background-color: #000000 !important;', 'background-color: #ffffff !important;', 'outline: none;'])), '#000000');
check('property name is case-insensitive', colorOf(run(['BACKGROUND-COLOR: #000;', 'outline: none;'])), '#ffffff');
check('a background-color in ANOTHER rule does not count (same block only)', (() => {
  const css = 'button { background-color: #000; }\nbutton:focus {\n  outline: none;\n}\n';
  const v = rule.check(parseCSS(css), css, {})[0];
  return rule.fix(v, css);
})(), null);
check('a background-color in a media block counts only for its own block', (() => {
  const inside = '@media (min-width: 1px) {\n  .x:focus {\n    background-color: #000;\n    outline: none;\n  }\n}\n';
  const outside = '.x:focus {\n  background-color: #000;\n}\n@media (min-width: 1px) {\n  .x:focus {\n    outline: none;\n  }\n}\n';
  const f = (css) => { const v = rule.check(parseCSS(css), css, {})[0]; return rule.fix(v, css); };
  return [f(inside), f(outside)];
})(), [{ newText: fmt('#ffffff') }, null]);
check('the other outline trigger (outline-width: 0) gets the same computed fix', (() => {
  const r = run(['background-color: #000;', 'outline-width: 0;']);
  return [r.violations.length, r.fix && r.fix.newText];
})(), [1, fmt('#ffffff')]);
check('outline: 0 as well', colorOf(run(['background-color: #fff;', 'outline: 0;'])), '#000000');

// ---------------------------------------------------------------- no fix
console.log('\nno background-color in the block: no fix is offered');
const noBg = run(['outline: none;']);
check('violation is still reported', noBg.violations.length, 1);
check('fix() returns null', noBg.fix, null);
check('other declarations (color, margin, border-color) do not stand in for a background', run(['color: #fff;', 'margin: 0;', 'border-color: #000;', 'outline: none;']).fix, null);

console.log('\nnon-literal / unevaluable background: no fix is offered');
for (const bg of ['var(--bg)', 'currentColor', 'currentcolor', 'transparent', 'inherit', 'initial', 'lightgray', 'rebeccapurple', 'hsl(0, 0%, 0%)', 'rgba(0, 0, 0, 0.5)', 'rgb(0 0 0)', '#00000080', '#abcd', 'linear-gradient(#000, #fff)', 'url(x.png)', 'rgb(999, 0, 0)', 'calc(1)', '']) {
  check('background-color: ' + (bg || '(empty)') + ' -> null', run(['background-color: ' + bg + ';', 'outline: none;']).fix, null);
}
check('the background shorthand is not evaluated (even a literal)', run(['background: #000;', 'outline: none;']).fix, null);
// (changed with the inset ring: a shorthand in the block can carry an image painted over the color,
// or reset the color, so the ring's surface is no longer known -> no fix, in either order)
check('a background shorthand anywhere in the block means no fix, before the color...', run(['background: url(x.png);', 'background-color: #000;', 'outline: none;']).fix, null);
check('...or after it (it would reset the color)', run(['background-color: #000;', 'background: transparent;', 'outline: none;']).fix, null);

console.log('\nthe hover explains why there is no fix');
const note = (r) => (r.v ? r.v.message.fix : '');
check('no background-color', [/No automatic fix is offered/.test(note(noBg)), /not statically determinable/.test(note(noBg)), /this rule has no background-color/.test(note(noBg))], [true, true, true]);
const viaVar = run(['background-color: var(--bg);', 'outline: none;']);
check('var(): names the value', [/not statically determinable/.test(note(viaVar)), note(viaVar).includes('var(--bg)')], [true, true]);
check('currentColor: names the value', note(run(['background-color: currentColor;', 'outline: none;'])).includes('currentColor'), true);
check('shorthand: says the shorthand is not evaluated', /background shorthand, which can carry an image or reset the color, so it is not evaluated/.test(note(run(['background: #000;', 'outline: none;']))), true);
check('the note states the 3:1 requirement', /at least 3:1 contrast/.test(note(noBg)), true);
check('every message still says what was wrong', noBg.v.message.what, 'Focus outline is removed with no visible replacement.');
const withFix = run(['background-color: #1a1a2e;', 'outline: none;']);
check('when a fix exists the hover shows the computed color, its ratio and the background', [/outline: 2px solid #ffffff; outline-offset: -2px;/.test(note(withFix)), /17\.06:1/.test(note(withFix)), note(withFix).includes('#1a1a2e')], [true, true, true]);
check('...and no longer suggests the old fixed #0066cc', note(withFix).includes('0066cc'), false);
check('...and carries no "no automatic fix" note', /No automatic fix/.test(note(withFix)), false);
const table = [['#fff'], ['#000'], ['var(--x)'], ['currentColor'], ['lightgray'], ['transparent'], [undefined], ['rgb(10, 20, 30)'], ['hsl(10, 10%, 10%)']];
check('"a fix is offered" and "no note" always agree', table.map(([bg]) => { const r = run(bg === undefined ? ['outline: none;'] : ['background-color: ' + bg + ';', 'outline: none;']); return (r.fix !== null) === !/No automatic fix/.test(note(r)); }), table.map(() => true));

// ---------------------------------------------------------------- the ring is inset
console.log('\nthe generated ring is always inset (negative outline-offset)');
const parseFix = (text) => { const m = text.match(/^outline: (\d+(?:\.\d+)?)px solid (#[0-9a-f]{6}); outline-offset: (-?\d+(?:\.\d+)?)px;$/); return m && { width: parseFloat(m[1]), color: m[2], offset: parseFloat(m[3]) }; };
let insetBad = [], insetN = 0;
for (const r of steps) for (const g of steps) for (const b of [0, 128, 255]) {
  const res = run(['background-color: rgb(' + r + ', ' + g + ', ' + b + ');', 'outline: none;']);
  const p = res.fix && parseFix(res.fix.newText);
  insetN++;
  // The ring covers [offset, offset + width] measured outward from the border edge: it must end at or
  // inside that edge, so nothing is painted beyond the element.
  if (!p || p.offset >= 0 || p.offset + p.width > 0) insetBad.push(res.fix && res.fix.newText);
}
check('every fix across ' + insetN + ' backgrounds has a negative offset and ends at or inside the border edge', insetBad, []);
check('the offset is exactly minus the ring width: the ring fills the outer band of the border box', (() => { const p = parseFix(run(['background-color: #000;', 'outline: none;']).fix.newText); return [p.width, p.offset, p.offset + p.width]; })(), [2, -2, 0]);
check('never zero or positive for either removal pattern', ['outline: none;', 'outline: 0;', 'outline-width: 0;'].map(d => parseFix(run(['background-color: #fff;', d]).fix.newText).offset < 0), [true, true, true]);
check('the old outset form is gone', /outline-offset: (2|\+2|0)px/.test(run(['background-color: #fff;', 'outline: none;']).fix.newText), false);

console.log('\nthe computed contrast does not depend on anything behind the element');
const baseFix = run(['background-color: #1a1a2e;', 'outline: none;']).fix.newText;
const around = (before, after) => { const css = before + '.x:focus {\n  background-color: #1a1a2e;\n  outline: none;\n}\n' + after; const v = rule.check(parseCSS(css), css, {}).find(x => x.ruleId === 'outline-removed'); return rule.fix(v, css).newText; };
check('a white page behind it: same fix', around('body { background-color: #ffffff; }\n', ''), baseFix);
check('a black page behind it: same fix', around('body { background-color: #000000; }\n.x { background-color: #000000; }\n', ''), baseFix);
check('a mid-grey parent: same fix', around('.card { background-color: #777777; }\n', '.card .x { color: red; }\n'), baseFix);
check('a gradient behind it: same fix', around('body { background-image: linear-gradient(red, blue); }\n', ''), baseFix);
check('a base rule for the same element with a DIFFERENT background: same fix (the focus block decides)', around('.x { background-color: #ffffff; }\n', ''), baseFix);
check('...and the fix is a pure function of the block\'s own background-color', (() => {
  const out = new Set(); for (const ctx of ['', 'body{background:#fff}\n', 'html{background:#000}\n', '.x{background-color:#fff}\n']) out.add(around(ctx, '')); return out.size;
})(), 1);

console.log('\nthe ring would be drawn over something else: no fix');
const nf = (decls) => run(['background-color: #000;', ...decls, 'outline: none;']).fix;
check('a background-image in the same block', nf(['background-image: url(x.png);']), null);
check('a gradient background-image', nf(['background-image: linear-gradient(red, blue);']), null);
check('background-image: none is fine', colorOf({ fix: nf(['background-image: none;']) }), '#ffffff');
check('a thick border (2px, solid)', nf(['border-width: 2px;', 'border-style: solid;']), null);
check('a thicker border (4px, solid)', nf(['border-width: 4px;', 'border-style: solid;']), null);
check('a per-side border that thick', nf(['border-top-width: 3px;', 'border-top-style: solid;']), null);
check('border-width: thick / medium (>= the ring)', [nf(['border-width: thick;', 'border-style: solid;']), nf(['border-width: medium;', 'border-style: solid;'])], [null, null]);
check('a border style with no width is "medium" (3px)', nf(['border-style: solid;']), null);
check('a width in a unit it cannot evaluate is treated as thick', [nf(['border-width: 0.25rem;', 'border-style: solid;']), nf(['border-width: var(--w);', 'border-style: solid;'])], [null, null]);
check('a bottom-only 2px border still counts', nf(['border-width: 0 0 2px;', 'border-style: solid;']), null);
check('a 1px border is thinner than the ring: still fixed', colorOf({ fix: nf(['border-width: 1px;', 'border-style: solid;']) }), '#ffffff');
check('thin is fine', colorOf({ fix: nf(['border-width: thin;', 'border-style: solid;']) }), '#ffffff');
check('a zero-width border is fine', colorOf({ fix: nf(['border-width: 0;', 'border-style: solid;']) }), '#ffffff');
check('a thick border width with no style draws no border: fine', colorOf({ fix: nf(['border-width: 5px;']) }), '#ffffff');
check('a thick border with style none/hidden draws no border: fine', [colorOf({ fix: nf(['border-width: 5px;', 'border-style: none;']) }), colorOf({ fix: nf(['border-width: 5px;', 'border-style: hidden;']) })], ['#ffffff', '#ffffff']);
check('an unrelated border-radius / border-color changes nothing', colorOf({ fix: nf(['border-radius: 4px;', 'border-color: red;']) }), '#ffffff');
const imgNote = run(['background-color: #000;', 'background-image: url(x.png);', 'outline: none;']);
const bdrNote = run(['background-color: #000;', 'border-width: 3px;', 'border-style: solid;', 'outline: none;']);
check('the hover explains the image case', [/No automatic fix is offered/.test(imgNote.v.message.fix), /background image \(url\(x\.png\)\)/.test(imgNote.v.message.fix), /painted over the background-color/.test(imgNote.v.message.fix)], [true, true, true]);
check('the hover explains the border case', [/No automatic fix is offered/.test(bdrNote.v.message.fix), /border at least as thick as the focus ring/.test(bdrNote.v.message.fix)], [true, true]);
check('"a fix exists" and "no note" still always agree with the new cases', [imgNote, bdrNote, run(['background-color: #000;', 'border-width: 1px;', 'border-style: solid;', 'outline: none;'])].map(r => (r.fix !== null) === !/No automatic fix/.test(r.v.message.fix)), [true, true, true]);

console.log('\nthe hover says the ring is now drawn inside');
const inset = run(['background-color: #1a1a2e;', 'outline: none;']);
check('mentions the negative offset, "just inside the element\'s edge", and that the page behind does not matter', [/negative outline-offset/.test(inset.v.message.fix), /just inside the element's edge/.test(inset.v.message.fix), /page behind does not matter/.test(inset.v.message.fix)], [true, true, true]);
check('shows the exact replacement, with the inset offset', inset.v.message.fix.includes('outline: 2px solid #ffffff; outline-offset: -2px;'), true);
check('the no-fix hover example also uses the inset form', /outline-offset: -2px; or use a box-shadow/.test(noBg.v.message.fix), true);

// ---------------------------------------------------------------- stale source + contract
console.log('\nfix() contract is otherwise unchanged');
const ok = run(['background-color: #000;', 'outline: none;']);
check('stale: the range no longer holds an outline declaration -> null', rule.fix(ok.v, ok.css.replace('outline: none;', 'margin: 0;      ')), null);
check('stale: the background was removed since the scan -> null (read from the CURRENT source)', rule.fix(ok.v, ok.css.replace('  background-color: #000;\n', '')), null);
check('stale: the background became non-literal since the scan -> null', rule.fix(ok.v, ok.css.replace('#000', 'var(--x)')), null);
check('the background changed since the scan -> the new one is used', rule.fix(ok.v, ok.css.replace('#000;', '#fff;')), { newText: fmt('#000000') });
check('multi-line violation -> null', rule.fix({ ...ok.v, endLine: ok.v.startLine + 1 }, ok.css), null);
check('line out of range -> null', rule.fix({ ...ok.v, startLine: 99, endLine: 99 }, ok.css), null);
check('unparseable CSS -> null, no throw', (() => { try { return rule.fix(ok.v, 'a { background-color: #000; outline: none;'); } catch (e) { return 'threw'; } })() !== 'threw', true);
check('a declaration that is not at the violation start -> null', rule.fix({ ...ok.v, startChar: ok.v.startChar + 1 }, ok.css), null);
check('detection is unchanged: same violations with or without a background', [run(['outline: none;']).violations.length, run(['background-color: #000;', 'outline: none;']).violations.length, run(['background-color: #000;', 'outline: none;', 'box-shadow: 0 0 0 2px red;']).violations.length], [1, 1, 0]);

// ---------------------------------------------------------------- shared color math
console.log('\nshared color math');
const contrastSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules', 'css', 'color-contrast-low.js'), 'utf8');
const outlineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules', 'css', 'outline-removed.js'), 'utf8');
check('color-contrast-low imports it instead of defining its own', [/require\('\.\.\/shared\/colorMath'\)/.test(contrastSrc), /function (hexToRgb|parseColor|getLuminance|getContrastRatio)/.test(contrastSrc)], [true, false]);
check('outline-removed imports the same module', [/require\('\.\.\/shared\/colorMath'\)/.test(outlineSrc), /function (hexToRgb|parseColor|getLuminance|getContrastRatio)/.test(outlineSrc)], [true, false]);
check('one implementation: the contrast rule\'s own results are unchanged', (() => {
  const contrast = require('../src/rules/css/color-contrast-low');
  const n = (css) => contrast.check(parseCSS(css), css, {}).length;
  return [n('a{color:#777;background-color:#fff}'), n('a{color:#767676;background-color:#fff}'), n('a{color:rgb(120,120,120);background-color:#fff}'), n('a{color:var(--c);background-color:#fff}')];
})(), [1, 0, 1, 0]);
check('known values: contrast of black on white is 21:1, white on white 1:1', [cm.getContrastRatio(cm.getLuminance(0, 0, 0), cm.getLuminance(255, 255, 255)).toFixed(2), cm.getContrastRatio(1, 1).toFixed(2)], ['21.00', '1.00']);
check('parseColor: hex3, hex6, rgb(), named; var() and unknown -> null', [cm.parseColor('#fff'), cm.parseColor('#102030'), cm.parseColor('rgb(1, 2, 3)'), cm.parseColor('navy'), cm.parseColor('var(--x)'), cm.parseColor('lightgray')],
  [{ r: 255, g: 255, b: 255 }, { r: 16, g: 32, b: 48 }, { r: 1, g: 2, b: 3 }, { r: 0, g: 0, b: 128 }, null, null]);

// ---------------------------------------------------------------- fixtures
console.log('\nfixtures');
const bare = fs.readFileSync(path.join(__dirname, '..', 'test-files', 'outline-fix.css'), 'utf8');
const bg = fs.readFileSync(path.join(__dirname, '..', 'test-files', 'outline-fix-bg.css'), 'utf8');
const vBare = rule.check(parseCSS(bare), bare, {})[0], vBg = rule.check(parseCSS(bg), bg, {})[0];
check('original outline-fix.css (no background): flagged, no fix', [!!vBare, rule.fix(vBare, bare)], [true, null]);
check('outline-fix-bg.css (#1a1a2e button): flagged, white outline', [!!vBg, rule.fix(vBg, bg)], [true, { newText: fmt('#ffffff') }]);
check('the new fixture differs from the original only by the background line', bg.replace(/\r?\n  background-color: #1a1a2e;/, '') === bare, true);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
