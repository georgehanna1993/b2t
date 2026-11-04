// Run: node test/samplerate_test.js
// REGRESSION: the same bassline must give the same notes whatever rate the browser decodes at.
// Chrome decodes to the audio device's rate (often 48 kHz on Windows), not the file's 44.1 kHz. Shorter analysis
// blocks spread a soft attack over more blocks, the 2-block energy rise fell just under onsetDb, and the open E
// in "Play That Funky Music" (E2 -> E1 -> A1 at ~2.76 s) vanished: A1 swallowed it. Here every note re-attacks while
// the previous one is still ringing, with a soft ~40 ms attack, which is what those notes look like in the real stem.
// The default (ATT_DB=7, ATT_LEN=0.04) fails on the old 2-block onset rise. Sweeping ATT_DB 6-14 x ATT_LEN 20-50 ms:
// old code fully right on both rates in 23/42 shapes, new code in 34/42 (weak/very fast attacks are still missed).
const A = require('../analysis.js');
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const ATT_DB = +process.env.ATT_DB || 7, ATT_LEN = +process.env.ATT_LEN || 0.04;

function render(ev, total, SR) {
  const out = new Float32Array(Math.ceil(total * SR));
  ev.forEach((e, k) => {
    const next = ev[k + 1], end = Math.min(e.t + e.dur, next ? next.t + 0.03 : total);
    let ph = 0;
    for (let i = Math.floor(e.t * SR); i < Math.min(out.length, Math.floor(end * SR)); i++) {
      const t = i / SR - e.t; ph += 2 * Math.PI * hz(e.midi) / SR;
      const att = Math.pow(10, -ATT_DB * (1 - Math.min(1, t / ATT_LEN)) / 20);
      const rel = Math.min(1, (end - e.t - t) / 0.03);
      const v = Math.sin(ph) * 0.55 + Math.sin(2 * ph) * 0.28 + Math.sin(3 * ph) * 0.14 + Math.sin(4 * ph) * 0.06;
      out[i] += v * 0.6 * att * Math.max(0, rel) * Math.exp(-t * 3);
    }
  });
  return out;
}

// the PTFM riff: E1 . D2 E2 E1 A1 B1 D2 E2, repeated, at ~109 bpm 16ths (0.1375 s)
const u = 0.1375, riff = [[0, 28, 5], [6, 38, 2], [8, 40, 3], [11, 28, 1], [12, 33, 1], [13, 35, 1], [14, 38, 1], [15, 40, 1]];
const ev = [];
for (let r = 0; r < 4; r++) riff.forEach(([p, m, l]) => ev.push({ t: 0.3 + (r * 16 + p) * u + (p % 3) * 0.002, midi: m, dur: l * u + 0.02 }));
const total = ev[ev.length - 1].t + 0.8;

let fail = 0, pass = 0;
(async () => {
  const seen = {};
  for (const SR of [44100, 48000]) {
    const notes = (await A.analyze([render(ev, total, SR)], SR)).notes, used = new Set(), miss = [];
    ev.forEach(e => {
      const i = notes.findIndex((n, j) => !used.has(j) && Math.abs(n.time - e.t) < 0.06 && n.midi === e.midi);
      if (i < 0) miss.push(`${e.t.toFixed(2)}:${e.midi}`); else used.add(i);
    });
    const extra = notes.length - used.size, ok = !miss.length && !extra;
    console.log(`${SR} Hz: found ${ev.length - miss.length}/${ev.length}, extra ${extra}${miss.length ? ' | MISSING ' + miss.join(' ') : ''}`);
    seen[SR] = notes.map(n => n.midi).join(',');
    ok ? pass++ : fail++;
  }
  if (seen[44100] === seen[48000]) pass++; else { fail++; console.log('44.1 kHz and 48 kHz disagree'); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
