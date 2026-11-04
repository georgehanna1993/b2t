// node test/all.js -> runs every test suite
const { spawnSync } = require('child_process');
let bad = 0;
for (const t of ['run.js', 'realistic.js', 'fingering_test.js', 'rhythm_test.js', 'samplerate_test.js', 'stem_artifacts_test.js']) {
  const r = spawnSync('node', [__dirname + '/' + t, '11'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n');
  console.log(`\n== ${t} ==\n` + (t === 'run.js' ? out.filter(l => /TOTAL|:/.test(l) && !/^ /.test(l)).join('\n') : out.slice(-1)[0] || r.stderr));
  if (r.status) bad++;
}
process.exit(bad ? 1 : 0);
