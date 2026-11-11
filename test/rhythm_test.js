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
// swing feel (owner's songs: Isn't She Lovely, Stray Cat Strut were forced onto straight 16ths): swung 8ths = long-short pairs at
// 2/3 + 1/3 of a beat. An unmistakable swing switches to 12/8; straight 8ths and 16ths must not.
{ const beat = 60 / 110, sw = [], st = [];
  for (let b = 0; b < 64; b++) { sw.push({ time: b * beat, dur: 0.3, midi: 40 }, { time: b * beat + beat * 2 / 3, dur: 0.15, midi: 43 }); st.push({ time: b * beat, dur: 0.2, midi: 40 }, { time: b * beat + beat / 2, dur: 0.2, midi: 43 }); }
  const fs = R.feel ? R.feel(sw, 110) : null, ft = R.feel ? R.feel(st, 110) : null;
  ok(fs && fs.swing, 'swung 8ths read as swing: ' + (fs ? fs.ratio.toFixed(2) : 'no feel()'));
  ok(ft && !ft.swing && !ft.maybe, 'straight 8ths are not swing: ' + (ft ? ft.ratio.toFixed(2) : 'no feel()'));
  ok(R.shownBpm && R.shownBpm(165, '12/8') === 110 && R.shownBpm(110, '4/4') === 110, '12/8 shows the dotted-quarter tempo'); }
// long songs (owner's Arabic song Law Yeuaaidni El Hawa, 6:40 at a steady 141.86 bpm): the tempo must be fitted to ~0.01 bpm,
// or the grid drifts by a 16th before the end and a wrong tempo wins (was read as 133 / 115, every bar came out wrong)
{ let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const bpm = 141.86, beat = 60 / bpm, n = [];
  for (let b = 0; b < 4 * 230; b += 2) { // main note every 2 beats, an 8th pickup before it, sometimes an off-beat
    n.push({ time: 0.5 + b * beat - beat / 2 + rnd() * 0.012, dur: 0.12, midi: 38 }, { time: 0.5 + b * beat + rnd() * 0.012, dur: 0.6, midi: 38 });
    if (b % 8 === 4) n.push({ time: 0.5 + (b + 1) * beat + rnd() * 0.012, dur: 0.2, midi: 45 });
  }
  const est = R.estimate(n);
  ok(Math.abs(est.bpm - bpm) < 0.03, `6-minute song at 141.86 bpm estimated as ${est.bpm}`);
  const rb = R.build(n, { bpm: est.bpm, origin: est.origin, sig: '4/4' });
  const off = n.filter(x => Math.abs((x.time - rb.origin) / rb.p - Math.round((x.time - rb.origin) / rb.p)) * rb.p > 0.03).length;
  ok(off === 0, `${off} notes off the grid at the end of a long song`);
  // swung song of the same length: the precise fit must not turn its triplet 8ths into straight 16ths at 3/4 of the tempo
  const sb = 118.8, sbeat = 60 / sb, sw = [];
  for (let b = 0; b < 400; b++) { sw.push({ time: b * sbeat + rnd() * 0.01, dur: 0.3, midi: 40 }); if (b % 2) sw.push({ time: b * sbeat + sbeat / 3 + rnd() * 0.01, dur: 0.1, midi: 43 }); sw.push({ time: b * sbeat + sbeat * 2 / 3 + rnd() * 0.01, dur: 0.15, midi: 43 }); }
  const es = R.estimate(sw);
  ok(es.swing && Math.abs(es.bpm - sb) < 1, `long swung song: ${es.bpm} bpm, swing ${es.swing}`); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
