// Tests for the AI-review selection layer (no AI call exists yet).
// Node-only, stubbed `vscode`. Run: node test/ai-candidate-selector.test.js
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? {} : origLoad.call(this, req, ...rest);
};

const { analyzeDocument } = require('../src/analyzer');
const { selectCandidates } = require('../src/judgment/candidateSelector');
const { createChangeTracker } = require('../src/judgment/changeTracker');
const aiReview = require('../src/judgment/aiReview');
const { parseHTML } = require('../src/parsers/htmlParser');

let failed = 0, total = 0;
function check(label, got, expected) {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`}`);
}

const cfg = (extra) => ({
  complianceLevel: 'AA', isRuleDisabled: () => false, isTrustedComponent: () => false, ...extra
});

async function candidatesFor(languageId, sourceCode, config = cfg(), violationsOverride) {
  const violations = violationsOverride || await analyzeDocument({ getText: () => sourceCode, languageId }, config);
  return { violations, candidates: aiReview.collectCandidates({ sourceCode, languageId, violations, config }) };
}
const contents = cs => cs.map(c => c.content);

(async () => {
  // ---------------------------------------------------------------- HTML fixture
  console.log('\nHTML: qualifying vs non-qualifying');
  const html = [
    '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>',
    '<img src="a.jpg" alt="photo.jpg">',                      // Q  alt exists, plausibly a filename
    '<img src="b.jpg">',                                      // -  no alt: structural miss
    '<img src="c.jpg" alt="">',                               // -  decorative
    '<img src="d.jpg" alt="   ">',                            // -  whitespace alt
    '<img src="e.jpg" role="presentation" alt="ignored">',    // -  presentational
    '<img src="f.jpg" alt="Team at the 2024 retreat">',       // -  5 words, descriptive: pre-filtered (was Q before the pre-filter)
    '<a href="/r">Annual report</a>',                         // Q
    '<a href="/x">Click here</a>',                            // -  known generic phrase (violation)
    '<a href="/y"></a>',                                      // -  empty (violation)
    '<a href="/z">https://example.com/page</a>',              // -  raw URL (violation)
    '<a href="/p" aria-label="Pricing details"></a>',         // Q  name from aria-label
    '<a href="/q">Read more</a>',                             // -  generic
    '<h1>Welcome</h1>',                                       // Q
    '<h2></h2>',                                              // -  empty heading (violation)
    '<div role="heading" aria-level="2">Section</div>',       // Q
    '<h3 title="From title only"></h3>',                      // -  violation (title is not heading content)
    '</body></html>'
  ].join('\n');
  const h = await candidatesFor('html', html);
  check('qualifying contents, in document order',
    contents(h.candidates), ['photo.jpg', 'Annual report', 'Pricing details', 'Welcome', 'Section']);
  check('ruleIds are the HTML structural rules',
    h.candidates.map(c => c.ruleId),
    ['img-alt-missing', 'anchor-no-text', 'anchor-no-text', 'heading-empty', 'heading-empty']);
  check('kinds', h.candidates.map(c => c.kind),
    ['image-alt', 'link-text', 'link-text', 'heading-text', 'heading-text']);
  check('WCAG criteria come from the structural rules',
    [...new Set(h.candidates.map(c => c.wcag))],
    ['WCAG 2.1 - 1.1.1 (Level A)', 'WCAG 2.1 - 2.4.4 (Level A)', 'WCAG 2.1 - 2.4.6 (Level AA)']);
  check('content source recorded', h.candidates.map(c => c.source), ['alt', 'content', 'aria-label', 'content', 'content']);
  check('img alt="photo.jpg" qualifies', h.candidates[0].content === 'photo.jpg' && h.candidates[0].ruleId === 'img-alt-missing', true);
  check('img with no alt is NOT a candidate (structural miss)', contents(h.candidates).includes('b.jpg'), false);
  check('no-alt img is already a violation of img-alt-missing',
    h.violations.some(v => v.ruleId === 'img-alt-missing' && v.startLine === 2), true);
  check('location is 0-based start-tag position matching violations',
    h.candidates[0].location, { startLine: 1, endLine: 1, startChar: 0, endChar: 33 });
  check('candidates never overlap a violation of their own rule',
    h.candidates.some(c => h.violations.some(v => v.ruleId === c.ruleId && v.startLine === c.location.startLine && v.startChar === c.location.startChar)), false);

  console.log('\nHTML: exclusion comes from the violations list');
  const t = '<h1 title="Welcome"></h1>';
  const withViolations = await candidatesFor('html', t);
  check('real violations: heading with title only is excluded', withViolations.candidates.length, 0);
  const noViolations = await candidatesFor('html', t, cfg(), []);
  check('same element with violations omitted would be selected (proves the exclusion)', contents(noViolations.candidates), ['Welcome']);

  console.log('\nHTML: config gating');
  const disabled = await candidatesFor('html', html, cfg({ isRuleDisabled: id => id === 'img-alt-missing' }));
  check('disabling img-alt-missing removes image candidates',
    disabled.candidates.filter(c => c.kind === 'image-alt').length, 0);
  check('...but keeps link and heading candidates', disabled.candidates.length, 4);
  const levelA = await candidatesFor('html', html, cfg({ complianceLevel: 'A' }));
  check('complianceLevel A drops heading candidates (2.4.6 is AA)', levelA.candidates.filter(c => c.kind === 'heading-text').length, 0);
  check('...and keeps A-level kinds (1 image + 2 links)', levelA.candidates.length, 3);

  // ---------------------------------------------------------------- JSX fixture
  console.log('\nJSX: qualifying vs non-qualifying');
  const jsx = [
    'const a = (<>',
    '<img src="a" alt="photo.jpg"/>',                  // Q
    '<img src="b"/>',                                  // -  no alt
    '<img src="c" alt=""/>',                           // -  decorative
    '<img src="d" alt={alt}/>',                        // -  dynamic alt: nothing to judge
    '<img src="e" alt={"Team photo"}/>',               // Q  static in an expression container
    '<img src="f" role="presentation" alt="x"/>',      // -
    '<a href="x">Annual report</a>',                   // Q
    '<a href="x">Click here</a>',                      // -  generic
    '<a href="x">{label}</a>',                         // -  dynamic
    '<a href="x"><span>Pricing</span></a>',            // Q  nested static text
    '<a href="x"></a>',                                // -  empty
    '<h1>Welcome</h1>',                                // Q
    '<h2>{title}</h2>',                                // -  dynamic
    '<h2></h2>',                                       // -  empty
    '<h3 aria-label="Details"></h3>',                  // Q  aria-label
    '</>);'
  ].join('\n');
  const j = await candidatesFor('javascriptreact', jsx);
  check('qualifying contents', contents(j.candidates), ['photo.jpg', 'Team photo', 'Annual report', 'Pricing', 'Welcome', 'Details']);
  check('ruleIds are the JSX structural rules', [...new Set(j.candidates.map(c => c.ruleId))],
    ['jsx-img-alt-missing', 'jsx-anchor-no-content', 'jsx-heading-empty']);
  check('JSX img with no alt is NOT a candidate and is a violation',
    j.violations.some(v => v.ruleId === 'jsx-img-alt-missing') && !contents(j.candidates).includes('b'), true);
  check('tsx uses the same path', contents((await candidatesFor('typescriptreact', jsx)).candidates).length, 6);
  const trusted = await candidatesFor('javascriptreact', 'const a = <img alt="photo.jpg"/>;', cfg({ isTrustedComponent: n => n === 'img' }));
  check('trusted component skipped', trusted.candidates.length, 0);

  console.log('\nNon-applicable inputs');
  check('css has no candidates', selectCandidates({ violations: [], ast: {}, languageId: 'css' }), []);
  check('null ast is safe', selectCandidates({ violations: [], ast: null, languageId: 'html' }), []);
  check('empty html', contents((await candidatesFor('html', '')).candidates), []);
  check('selector does not need the config argument', selectCandidates({ violations: [], ast: parseHTML('<h1>Hi</h1>'), languageId: 'html' }).length, 1);

  // ---------------------------------------------------------------- pre-filter
  console.log('\nPre-filter: link text');
  const linkOf = async (text) => contents((await candidatesFor('html', `<a href="/x">${text}</a>`)).candidates);
  check('"Home" (1 word) stays a candidate', await linkOf('Home'), ['Home']);
  check('"Contact us" (2 words) stays', await linkOf('Contact us'), ['Contact us']);
  check('"About our team" (3 words) is skipped', await linkOf('About our team'), []);
  check('"See the full annual report" is skipped', await linkOf('See the full annual report'), []);
  check('3 words but under the character floor stays (a b c)', await linkOf('a b c'), ['a b c']);
  check('"Click here to read the report" is vague -> stays', await linkOf('Click here to read the report'), ['Click here to read the report']);
  check('"Read more about WCAG" is vague -> stays', await linkOf('Read more about WCAG'), ['Read more about WCAG']);
  check('"Learn more about our services" stays', await linkOf('Learn more about our services'), ['Learn more about our services']);
  check('"Tap here for details" stays', await linkOf('Tap here for details'), ['Tap here for details']);
  check('"here is the signup form" stays', await linkOf('here is the signup form'), ['here is the signup form']);
  check('"See this page for pricing" stays', await linkOf('See this page for pricing'), ['See this page for pricing']);
  check('"Link to our pricing page" stays', await linkOf('Link to our pricing page'), ['Link to our pricing page']);
  check('"more info and details" stays', await linkOf('more info and details'), ['more info and details']);
  check('exact generic phrase is a violation, never a candidate', await linkOf('Click here'), []);
  check('multi-word descriptive in JSX is skipped', contents((await candidatesFor('javascriptreact', 'const a = <a href="x">About our team</a>;')).candidates), []);
  check('short link in JSX stays', contents((await candidatesFor('javascriptreact', 'const a = <a href="x">Home</a>;')).candidates), ['Home']);
  check('vague long link in JSX stays', contents((await candidatesFor('javascriptreact', 'const a = <a href="x">Read more about WCAG</a>;')).candidates), ['Read more about WCAG']);

  console.log('\nPre-filter: alt text');
  const altOf = async (alt, src = 'x.jpg') => contents((await candidatesFor('html', `<img src="${src}" alt="${alt}">`)).candidates);
  check('"image" (1 word) stays', await altOf('image'), ['image']);
  check('"photo" stays', await altOf('photo'), ['photo']);
  check('"icon" stays', await altOf('icon'), ['icon']);
  check('"Team photo" (2 words) stays', await altOf('Team photo'), ['Team photo']);
  check('"A group of people" (4 words) is skipped', await altOf('A group of people'), []);
  check('3 words stays (boundary)', await altOf('Smiling team members'), ['Smiling team members']);
  check('4 words is skipped (boundary)', await altOf('Smiling team members outdoors'), []);
  check('"Our team gathered for a group photo" is skipped', await altOf('Our team gathered for a group photo', 'team.jpg'), []);
  check('long alt that is a filename stays', await altOf('IMG_1234.jpg taken at the annual meetup'), ['IMG_1234.jpg taken at the annual meetup']);
  check('long alt containing .png stays', await altOf('screenshot of the dashboard final.png'), ['screenshot of the dashboard final.png']);
  check('long alt reusing a numbered file-name stem stays', await altOf('IMG 1234 from the company picnic', 'photos/IMG_1234.jpg'), ['IMG 1234 from the company picnic']);
  check('long alt reusing a multi-word file-name stem stays', await altOf('team retreat 2024 at the lake house', 'img/team-retreat-2024.jpg'), ['team retreat 2024 at the lake house']);
  check('stem match ignores query string and case', await altOf('Team Photo 2024 on the lake dock', 'a/b/Team_Photo_2024.JPG?v=3'), ['Team Photo 2024 on the lake dock']);
  check('a plain one-word stem ("team.jpg") is NOT treated as reuse', await altOf('Our team gathered for a group photo at the annual meetup', 'team.jpg'), []);
  check('a plain one-word stem ("logo.png") is NOT treated as reuse', await altOf('The company logo in blue on a white background', 'logo.png'), []);
  check('stem shorter than the minimum is ignored', await altOf('a b c d e f g', 'a.jpg'), []);
  check('JSX: descriptive alt skipped', contents((await candidatesFor('javascriptreact', 'const a = <img src="t.jpg" alt="Our team gathered for a group photo"/>;')).candidates), []);
  check('JSX: short alt stays', contents((await candidatesFor('javascriptreact', 'const a = <img src="t.jpg" alt="photo"/>;')).candidates), ['photo']);
  check('JSX: filename reuse stays', contents((await candidatesFor('javascriptreact', 'const a = <img src="img/IMG_0042.jpg" alt="IMG 0042 from the company picnic"/>;')).candidates), ['IMG 0042 from the company picnic']);

  console.log('\nPre-filter: heading text');
  const headOf = async (text) => contents((await candidatesFor('html', `<h2>${text}</h2>`)).candidates);
  check('"Welcome" (1 word) stays', await headOf('Welcome'), ['Welcome']);
  check('"Overview" stays', await headOf('Overview'), ['Overview']);
  check('"Contact Form" (2 words) is skipped', await headOf('Contact Form'), []);
  check('"Our latest news and updates" is skipped', await headOf('Our latest news and updates'), []);
  check('JSX: 1 word stays, 2 words skipped', [
    contents((await candidatesFor('javascriptreact', 'const a = <h1>Welcome</h1>;')).candidates),
    contents((await candidatesFor('javascriptreact', 'const a = <h1>Welcome Section</h1>;')).candidates)
  ], [['Welcome'], []]);

  console.log('\nPre-filter: thresholds are named, exported constants');
  const th = require('../src/judgment/candidateSelector').thresholds;
  check('link thresholds', [th.LINK_MIN_WORDS_TO_SKIP, th.LINK_MIN_CHARS_TO_SKIP], [3, 10]);
  check('alt thresholds', [th.ALT_MIN_WORDS_TO_SKIP, th.ALT_MIN_STEM_LENGTH, th.ALT_STEM_MUST_LOOK_LIKE_FILENAME], [4, 3, true]);
  check('heading threshold', th.HEADING_MIN_WORDS_TO_SKIP, 2);
  check('vague patterns are regexes', th.LINK_VAGUE_PATTERNS.every(r => r instanceof RegExp), true);

  // ---------------------------------------------------------------- structural paths
  console.log('\nStructural paths');
  const pathsOf = async (lang, src) => (await candidatesFor(lang, src)).candidates.map(c => c.path);
  const doc = '<html><body><div><a href="/1">One</a><p>x</p><a href="/2">Two</a></div><div><a href="/3">Three</a></div></body></html>';
  check('HTML: tag + index among same-tag siblings', await pathsOf('html', doc),
    ['html[0]>body[0]>div[0]>a[0]', 'html[0]>body[0]>div[0]>a[1]', 'html[0]>body[0]>div[1]>a[0]']);
  check('HTML: whitespace/blank lines do not change paths', await pathsOf('html', doc.replace(/></g, '>\n\n  <')),
    await pathsOf('html', doc));
  check('HTML: a different-tag sibling does not shift the index', await pathsOf('html', '<html><body><p>x</p><a href="/1">One</a></body></html>'),
    ['html[0]>body[0]>a[0]']);
  const jsxDoc = 'const A = () => <div><a href="/1">One</a><p>x</p><a href="/2">Two</a></div>;\nconst B = () => <ul><li><a href="/3">Three</a></li></ul>;';
  check('JSX: paths over JSX ancestors, indexed per parent', await pathsOf('javascriptreact', jsxDoc),
    ['div[0]>a[0]', 'div[0]>a[1]', 'ul[0]>li[0]>a[0]']);
  check('JSX: blank lines / reformatting do not change paths', await pathsOf('javascriptreact', '\n\n' + jsxDoc.replace(/;\n/, ';\n\n\n')),
    await pathsOf('javascriptreact', jsxDoc));
  check('JSX: fragments are transparent', await pathsOf('javascriptreact', 'const a = <><a href="x">One</a><a href="y">Two</a></>;'),
    ['a[0]', 'a[1]']);
  check('every candidate has a path', (await candidatesFor('html', html)).candidates.every(c => typeof c.path === 'string' && c.path.length > 0), true);

  // ---------------------------------------------------------------- change tracker
  console.log('\nchangeTracker');
  const mk = (ruleId, content, pathStr, line = 0) => ({ ruleId, content, path: pathStr, location: { startLine: line, startChar: 0 } });
  const tr = createChangeTracker();
  const A = mk('img-alt-missing', 'photo.jpg', 'html[0]>body[0]>img[0]', 3), B = mk('anchor-no-text', 'Annual report', 'html[0]>body[0]>a[0]', 5);
  check('first scan lists everything', tr.filterUnchanged('f.html', [A, B]).length, 2);
  check('identical rescan lists nothing', tr.filterUnchanged('f.html', [A, B]).length, 0);
  check('changed content is listed again, only that one',
    tr.filterUnchanged('f.html', [{ ...A, content: 'Team photo' }, B]).map(c => c.content), ['Team photo']);
  check('...and is then unchanged', tr.filterUnchanged('f.html', [{ ...A, content: 'Team photo' }, B]).length, 0);
  check('line numbers are NOT part of identity: same paths on shifted lines are unchanged',
    tr.filterUnchanged('f.html', [{ ...A, content: 'Team photo', location: { startLine: 40, startChar: 9 } }, { ...B, location: { startLine: 41, startChar: 9 } }]).length, 0);
  check('moved in the tree (new path) counts as new', tr.filterUnchanged('f.html', [{ ...A, content: 'Team photo', path: 'html[0]>body[0]>div[0]>img[0]' }, B]).length, 1);
  check('entries exist for both', tr.size(), 2);
  tr.filterUnchanged('f.html', [B]);
  check('entry cleared when its candidate disappears', tr.size(), 1);
  check('a re-added candidate is listed again',
    tr.filterUnchanged('f.html', [A, B]).map(c => c.ruleId), ['img-alt-missing']);
  tr.filterUnchanged('f.html', []);
  check('all entries cleared when the file has no candidates', tr.size(), 0);
  check('two candidates on one line (different paths) do not collide',
    (() => { const t2 = createChangeTracker(); const l = [mk('anchor-no-text', 'One', 'a[0]', 1), mk('anchor-no-text', 'Two', 'a[1]', 1)]; t2.filterUnchanged('g', l); return t2.filterUnchanged('g', l).length; })(), 0);
  check('files are independent', (() => {
    const t3 = createChangeTracker();
    t3.filterUnchanged('a.html', [A]);
    return [t3.filterUnchanged('b.html', [A]).length, t3.filterUnchanged('a.html', [A]).length];
  })(), [1, 0]);
  check('same content+path, different rule -> distinct', (() => {
    const t4 = createChangeTracker();
    t4.filterUnchanged('f', [mk('anchor-no-text', 'X', 'a[0]')]);
    return t4.filterUnchanged('f', [mk('heading-empty', 'X', 'a[0]')]).length;
  })(), 1);
  check('a candidate with no path is rejected loudly', (() => { try { createChangeTracker().filterUnchanged('f', [{ ruleId: 'r', content: 'c', location: { startLine: 1, startChar: 0 } }]); return 'no error'; } catch (e) { return 'threw'; } })(), 'threw');

  console.log('\nREGRESSION: unrelated line shifts do not re-list candidates');
  const shiftSrc = [
    '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>',
    '<h1>Welcome</h1>',
    '<a href="/r">Annual report</a>',
    '<img src="a.jpg" alt="photo.jpg">',
    '</body></html>'
  ].join('\n');
  const regTracker = createChangeTracker();
  const scan = async (src, filePath) => {
    const v = await analyzeDocument({ getText: () => src, languageId: 'html' }, cfg());
    const all = aiReview.collectCandidates({ sourceCode: src, languageId: 'html', violations: v, config: cfg() });
    return { fresh: regTracker.filterUnchanged(filePath, all), all };
  };
  const s1 = await scan(shiftSrc, 'C:/shift.html');
  check('baseline scan lists all candidates', s1.fresh.length, 3);
  const withBlank = shiftSrc.replace('<h1>Welcome</h1>', '\n<h1>Welcome</h1>'); // blank line ABOVE the heading and everything below
  const s2 = await scan(withBlank, 'C:/shift.html');
  check('blank line inserted above existing candidates: NOT re-listed as new', s2.fresh.length, 0);
  check('...every candidate really did move down a line', s2.all.map(c => c.location.startLine), s1.all.map(c => c.location.startLine + 1));
  const s3 = await scan(withBlank.replace('<body>', '<body>\n<!-- comment -->\n\n'), 'C:/shift.html');
  check('comment + blank lines added at the top: still nothing re-listed', s3.fresh.length, 0);
  const s4 = await scan(withBlank.replace('Annual report', 'Yearly report'), 'C:/shift.html');
  check('a real content edit after the shift is still detected', contents(s4.fresh), ['Yearly report']);
  const s5 = await scan(withBlank.replace('Annual report', 'Yearly report').replace('</body>', '<a href="/new">Brand new</a></body>'), 'C:/shift.html');
  check('a genuinely new element is listed, and only it', contents(s5.fresh), ['Brand new']);
  const jsxShift = 'const a = <div><h1>Welcome</h1><a href="x">Annual report</a></div>;';
  const jscan = async (src) => {
    const v = await analyzeDocument({ getText: () => src, languageId: 'javascriptreact' }, cfg());
    const all = aiReview.collectCandidates({ sourceCode: src, languageId: 'javascriptreact', violations: v, config: cfg() });
    return { fresh: regTracker.filterUnchanged('C:/shift.jsx', all), all };
  };
  check('JSX baseline lists 2', (await jscan(jsxShift)).fresh.length, 2);
  check('JSX: blank lines and a new unrelated statement above: nothing re-listed',
    (await jscan('\n\nconst x = 1;\n\n' + jsxShift)).fresh.length, 0);

  // (The review orchestration - batching, caching, failures - is covered in test/ai-judgment.test.js.)

  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
