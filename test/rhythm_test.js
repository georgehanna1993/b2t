// node test/rhythm_test.js -> tempo detection + quantization sanity checks
const R = require('../rhythm.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const mkNotes = (bpm, pat, bars, off) => { // pat: [[unitPos, lenUnits]] per 16-unit bar
  const p = 15 / bpm, out = [];
  for (let b = 0; b < bars; b++) pat.forEach(([u, len]) => out.push({ time: (off || 0.3) + (b * 16 + u) * p + (Math.random() - 0.5) * 0.02, dur: len * p * 0.9, midi: 40 }));
  return out;
};
const covers = rb => { // every bar's events must fill exactly one bar with no gaps or overlaps
  for (let b = 0; b < rb.bars; b++) {
    const evs = rb.events.filter(e => e.bar === b).sort((a, c) => a.u - c.u); let cur = b * rb.barU;
    for (const e of evs) { if (e.u !== cur) return `bar ${b + 1}: expected event at ${cur} got ${e.u}`; cur += e.len; }
    if (cur !== (b + 1) * rb.barU) return `bar ${b + 1} ends at ${cur - b * rb.barU} not ${rb.barU}`;
  }
  return null;
};

for (const bpm of [80, 96, 108, 120, 140]) {
  const n = mkNotes(bpm, [[0, 3], [3, 1], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]], 6);
  const est = R.estimate(n);
  ok(Math.abs(est.bpm - bpm) <= 2, `tempo ${bpm} estimated as ${est.bpm}`);
  const rb = R.build(n, { bpm: est.bpm, origin: est.origin, sig: '4/4' });
  ok(!covers(rb), `bpm ${bpm}: ${covers(rb)}`);
  // every note should land on its intended 16th
  const want = [0, 3, 4, 6, 8, 12, 14], got = n.slice(0, 7).map(x => x.q.pos);
  const shift = (got[0] - want[0] + 16) % 16;
  ok(got.every((g, i) => (g - shift + 16) % 16 === want[i]), `bpm ${bpm}: positions ${got} vs ${want}`);
}
// a note that rings across a barline is split and tied
{ const n = mkNotes(100, [[12, 8]], 2); const est = R.estimate(n);
  const rb = R.build(n, { bpm: 100, origin: n[0].time - 12 * 0.15, sig: '4/4' });
  ok(rb.events.some(e => e.kind === 'tie'), 'barline-crossing note should produce a tie');
  ok(!covers(rb), 'tie case: ' + covers(rb)); }
// other time signatures keep bars whole
for (const sig of ['3/4', '6/8', '12/8', '2/4']) { const n = mkNotes(100, [[0, 4], [4, 4], [8, 4]], 5); const rb = R.build(n, { bpm: 100, origin: n[0].time, sig }); ok(!covers(rb), sig + ': ' + covers(rb)); }
// first note before the given origin must not produce negative positions
{ const n = mkNotes(100, [[0, 4], [4, 4]], 3); const rb = R.build(n, { bpm: 100, origin: n[0].time + 0.5, sig: '4/4' }); ok(rb.events.every(e => e.u >= 0), 'no negative positions'); ok(!covers(rb), 'shifted origin: ' + covers(rb)); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
