// Run: node test/realistic.js [seed]
// A harder test that imitates a bass STEM separated from a song:
// synth-bass timbre, reverb, sidechain pumping, kick + hi-hat bleed, slight detune, long glides.
const A = require('../analysis.js');
const SR = 44100, seed0 = +process.argv[2] || 11;
let seed = seed0; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

function buildLine() {
  // [midi, durationBeats, opts]  @ 0.25 s per 16th
  const sixteenth = 0.25 / 2, ev = []; let t = 0.4;
  const pat = [
    [40, 2], [40, 1], [43, 1], [45, 4, { slideTo: 50, sl: 0.2 }], [47, 2], [45, 1], [43, 1],
    [38, 2], [38, 1], [38, 1], [45, 5, { slideTo: 40, sl: 0.3 }], [40, 1],
    [43, 2], [43, 1], [55, 1], [52, 2], [50, 2],
    [40, 1], [40, 1], [47, 2], [45, 4, { slideTo: 52, sl: 0.25 }], [48, 2],
    [36, 3], [36, 1], [43, 2], [41, 2], [40, 6, { slideTo: 33, sl: 0.35 }],
    [38, 2], [38, 2], [45, 2], [43, 1], [41, 1], [40, 2], [40, 2]
  ];
  pat.forEach(([m, beats, o]) => { ev.push({ t, dur: beats * sixteenth * 0.9, midi: m, ...(o || {}) }); t += beats * sixteenth; });
  return { ev, total: t + 1.2 };
}

function render(ev, total) {
  const n = Math.ceil(total * SR), dry = new Float32Array(n);
  ev.forEach((e, k) => {
    const nx = ev[k + 1], end = Math.min(e.t + e.dur, nx ? nx.t + 0.01 : 1e9, total);
    const i0 = Math.floor(e.t * SR), i1 = Math.min(n, Math.floor(end * SR));
    let ph = 0, lp = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      let f = hz(e.midi) * Math.pow(2, 0.2 / 12) * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t));
      if (e.slideTo != null) { const a = 0.08, u = Math.min(1, Math.max(0, (t - a) / e.sl)); f = hz(e.midi + (e.slideTo - e.midi) * (u * u * (3 - 2 * u))) * Math.pow(2, 0.2 / 12); }
      ph += 2 * Math.PI * f / SR;
      const att = Math.min(1, t / 0.006), rel = Math.max(0, Math.min(1, (end - e.t - t) / 0.03)), env = att * rel * (0.55 + 0.45 * Math.exp(-t * 3));
      // synth saw-ish tone, low-passed by a closing filter (brightness decays)
      let v = 0; const nh = 10; for (let h = 1; h <= nh; h++) v += Math.sin(h * ph) / h * Math.exp(-(h - 1) * (0.25 + t * 2.2));
      dry[i] += v * env * 0.6;
    }
  });
  // sidechain pumping: bass ducks on every kick (every 0.5 s)
  for (let i = 0; i < n; i++) { const tb = (i / SR) % 0.5; dry[i] *= 1 - 0.7 * Math.exp(-tb * 18); }
  // reverb: two feedback combs
  const out = new Float32Array(n), c1 = Math.floor(0.0297 * SR), c2 = Math.floor(0.0371 * SR);
  for (let i = 0; i < n; i++) out[i] = dry[i] + (i >= c1 ? 0.32 * out[i - c1] : 0) * 0.5 + (i >= c2 ? 0.28 * out[i - c2] : 0) * 0.5;
  // bleed: kick thumps (pitched ~55 Hz falling) every 0.5 s, hi-hat noise every 0.25 s, pad chord at -26 dB
  for (let t = 0.4; t < total; t += 0.5) { const i0 = Math.floor(t * SR); for (let i = i0; i < Math.min(n, i0 + 0.18 * SR); i++) { const u = (i - i0) / SR; out[i] += 0.22 * Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-u * 35)) * u) * Math.exp(-u * 18); } }
  for (let t = 0.525; t < total; t += 0.25) { const i0 = Math.floor(t * SR); let p = 0; for (let i = i0; i < Math.min(n, i0 + 0.05 * SR); i++) { const u = (i - i0) / SR, w = rand() * 2 - 1; out[i] += 0.07 * (w - p) * Math.exp(-u * 80); p = w; } }
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] += 0.04 * (Math.sin(2 * Math.PI * 196 * t) + Math.sin(2 * Math.PI * 247 * t) + Math.sin(2 * Math.PI * 294 * t)) + (rand() * 2 - 1) * 0.002; }
  return out;
}

const { ev, total } = buildLine();
const audio = render(ev, total);
if (process.env.OUT_WAV) { // write the synthetic stem so it can be tried in the browser
  const fs = require('fs'), b = Buffer.alloc(44 + audio.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + audio.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(audio.length * 2, 40);
  let mx = 0; for (const v of audio) mx = Math.max(mx, Math.abs(v));
  for (let i = 0; i < audio.length; i++) b.writeInt16LE(Math.round(audio[i] / mx * 0.9 * 32767), 44 + i * 2);
  fs.writeFileSync(process.env.OUT_WAV, b);
}
const t0 = Date.now();
A.analyze([audio], SR).then(res => {
  const notes = res.notes, used = new Set(), detail = [];
  let hit = 0, pitchOK = 0, slideGT = 0, slideOK = 0, spuriousLegato = 0;
  ev.forEach(g => {
    let bi = -1, bd = 1e9;
    notes.forEach((n, i) => { const dd = Math.abs(n.time - g.t); if (!used.has(i) && dd < bd) { bd = dd; bi = i; } });
    const n = bi >= 0 && bd <= 0.07 ? notes[bi] : null;
    if (g.slideTo != null) slideGT++;
    if (!n) { detail.push(`MISS  @${g.t.toFixed(2)} midi ${g.midi}${g.slideTo ? '->' + g.slideTo : ''}`); return; }
    used.add(bi); hit++;
    if (n.midi === g.midi) pitchOK++; else detail.push(`PITCH @${g.t.toFixed(2)} got ${n.midi} want ${g.midi}`);
    if (g.slideTo != null) { if (n.slideTo === g.slideTo) slideOK++; else detail.push(`SLIDE @${g.t.toFixed(2)} got ${n.slideTo ?? 'none'} want ${g.slideTo}`); }
  });
  const extra = notes.filter((n, i) => !used.has(i));
  extra.forEach(n => { if (n.technique === 'legato') spuriousLegato++; detail.push(`EXTRA @${n.time.toFixed(2)} midi ${n.midi}${n.mute ? ' (mute)' : ''}${n.technique ? ' [' + n.technique + ']' : ''}`); });
  const tag = notes.filter(n => n.technique === 'legato').length;
  console.log(`seed ${seed0}: notes ${notes.length} (truth ${ev.length}) | found ${hit}/${ev.length} | pitch ${pitchOK}/${ev.length} | slides ${slideOK}/${slideGT} | extra ${extra.length} (legato-tagged ${tag}, spurious legato ${spuriousLegato}) | ${Date.now() - t0} ms`);
  detail.slice(0, 25).forEach(l => console.log('  ' + l));
});
