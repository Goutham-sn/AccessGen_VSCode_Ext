// Runs every test/*.test.js file in its own process and reports a combined result. Run: npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
const failures = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const tally = (out.match(/\d+\/\d+ passed.*$/m) || [''])[0];
  const failedLines = out.split('\n').filter(l => /^\s+FAIL\s/.test(l));
  const ok = r.status === 0 && !failedLines.length;
  console.log((ok ? 'ok    ' : 'FAIL  ') + f + (tally ? '  ' + tally : ''));
  if (!ok) { failures.push(f); failedLines.forEach(l => console.log('      ' + l.trim())); }
}
console.log('\n' + (files.length - failures.length) + '/' + files.length + ' test files passed');
process.exit(failures.length ? 1 : 0);
