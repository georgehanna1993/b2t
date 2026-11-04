// Run: node test/run.js
// Builds synthetic basslines with KNOWN notes, runs the analyzer, and scores it.
const A = require('../analysis.js');
const SR = 44100;

function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const rand = rng(7);
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

// events: {t, dur, midi, slideTo?, legatoTo?, legatoAt?, slap?, mute?}
function render(events, total, clean) {
  const n = Math.ceil(total * SR), out = new Float32Array(n);
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, k) => {
    const next = events[k + 1], end = Math.min(e.t + e.dur, next ? next.t + 0.008 : 1e9, total);
    const i0 = Math.floor(e.t * SR), i1 = Math.min(n, Math.floor(end * SR));
    if (e.mute) {
      let lp = 0;
      for (let i = i0; i < Math.min(n, i0 + Math.floor(0.07 * SR)); i++) {
        const t = (i - i0) / SR; lp += 0.08 * ((rand() * 2 - 1) - lp);
        out[i] += lp * 1.6 * Math.exp(-t * 55);
      }
      return;
    }
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      let f = hz(e.midi) * (e.stress ? Math.pow(2, 0.3 / 12) * (1 + 0.009 * Math.sin(2 * Math.PI * 5 * t)) : 1);
      if (e.slideTo != null) { const a = e.slideStart || 0.1, b = a + (e.slideLen || 0.2); const u = Math.min(1, Math.max(0, (t - a) / (b - a))); f = hz(e.midi + (e.slideTo - e.midi) * u); }
      if (e.legatoTo != null && t >= e.legatoAt) f = hz(e.legatoTo);
      if (e.slideInFrom != null) { const u = Math.min(1, t / (e.slideInLen || 0.12)); f = hz(e.midi - e.slideInFrom * (1 - u * u * (3 - 2 * u))); }
      if (e.outDrop != null && t > e.outAt) { const u = Math.min(1, (t - e.outAt) / (e.outLen || 0.3)); f = hz(e.midi - e.outDrop * u * u * (3 - 2 * u)); }
      if (e.vib) f *= Math.pow(2, (e.vib.depth * Math.sin(2 * Math.PI * e.vib.rate * t) * (t > 0.12 ? 1 : 0)) / 12);
      phase += 2 * Math.PI * f / SR;
      const att = e.attLen ? Math.pow(10, -(e.attDb || 80) * (1 - Math.min(1, t / e.attLen)) / 20) : Math.min(1, t / 0.004), rel = Math.min(1, (end - e.t - t) / 0.01);
      const fade = e.outDrop != null && t > e.outAt ? Math.pow(Math.max(0, 1 - (t - e.outAt) / (e.outLen * 1.15)), 1.5) : 1;
      const env = att * Math.max(0, rel) * Math.exp(-t * 2.6) * fade;
      let v = e.stress ? Math.sin(phase) * 0.18 + Math.sin(2 * phase) * 0.6 + Math.sin(3 * phase) * 0.35 + Math.sin(4 * phase) * 0.15 : Math.sin(phase) * 0.55 + Math.sin(2 * phase) * 0.28 + Math.sin(3 * phase) * 0.14 + Math.sin(4 * phase) * 0.06;
      if (e.slap) { const th = Math.exp(-t * 180); v += (rand() * 2 - 1) * 0.9 * th + Math.sin(7 * phase) * 0.5 * th + Math.sin(11 * phase) * 0.4 * th; }
      out[i] += v * env * 0.7;
    }
  });
  const hum = events.some(e => e.stress);
  if (!clean) for (let i = 0; i < n; i++) out[i] += (rand() * 2 - 1) * 0.0015 + (hum ? 0.02 * Math.sin(2 * Math.PI * 50 * i / SR) + (rand() * 2 - 1) * 0.01 : 0);
  return out;
}

const cases = [];

// 1. The demo groove: repeated notes + walking line (exactly what the old code merged)
{
  const m = [40, 40, 43, 45, 47, 45, 43, 40, 40, 40, 43, 45, 47, 50, 47, 45, 43, 43, 45, 47, 45, 43, 40, 38, 40, 40, 43, 45, 47, 45, 43, 40];
  cases.push({ name: 'repeated eighths (demo groove)', total: 16.5, ev: m.map((x, i) => ({ t: 0.3 + i * 0.5, dur: 0.46, midi: x })) });
}
// 2. 16th-note run at 120 bpm
{
  const m = [40, 40, 52, 40, 43, 43, 55, 43, 45, 45, 57, 45, 47, 45, 43, 40];
  cases.push({ name: '16ths @120bpm with octaves', total: 5, ev: m.map((x, i) => ({ t: 0.3 + i * 0.125, dur: 0.12, midi: x })) });
}
// 3. Slides
cases.push({
  name: 'slides up and down', total: 8, ev: [
    { t: 0.3, dur: 1.0, midi: 45, slideTo: 50, slideStart: 0.35, slideLen: 0.22 },
    { t: 1.8, dur: 1.0, midi: 55, slideTo: 48, slideStart: 0.3, slideLen: 0.3 },
    { t: 3.3, dur: 0.8, midi: 40 }, { t: 4.2, dur: 0.8, midi: 43 },
    { t: 5.2, dur: 1.2, midi: 38, slideTo: 45, slideStart: 0.4, slideLen: 0.25 }
  ]
});
// 4. Legato (hammer-on / pull-off): new pitch without a new attack
cases.push({
  name: 'hammer-ons / pull-offs', total: 6, ev: [
    { t: 0.3, dur: 0.9, midi: 45, legatoTo: 47, legatoAt: 0.25 },
    { t: 1.5, dur: 0.9, midi: 52, legatoTo: 50, legatoAt: 0.3 },
    { t: 2.7, dur: 0.6, midi: 40 }, { t: 3.4, dur: 0.6, midi: 43 }
  ]
});
// 5. Ghost notes (muted) between pitched notes
cases.push({
  name: 'muted ghost notes', total: 5, ev: [
    { t: 0.3, dur: 0.3, midi: 40 }, { t: 0.65, mute: true, dur: 0.07 }, { t: 0.85, dur: 0.3, midi: 40 },
    { t: 1.25, mute: true, dur: 0.07 }, { t: 1.45, dur: 0.3, midi: 43 }, { t: 1.85, mute: true, dur: 0.07 }, { t: 2.05, dur: 0.4, midi: 45 }
  ]
});
// 6. Slap vs finger
cases.push({
  name: 'slap vs fingerstyle', total: 5, ev: [
    { t: 0.3, dur: 0.4, midi: 40 }, { t: 0.9, dur: 0.4, midi: 40, slap: true }, { t: 1.5, dur: 0.4, midi: 47 },
    { t: 2.1, dur: 0.4, midi: 52, slap: true }, { t: 2.7, dur: 0.4, midi: 45 }, { t: 3.3, dur: 0.4, midi: 43, slap: true }
  ]
});

// 7. Stress: 30c sharp, weak fundamental, vibrato, 50 Hz hum + hiss, walking line with a slide
{
  const m = [28, 31, 33, 35, 36, 35, 33, 31, 28, 28, 40, 28, 33, 33, 45, 33];
  const ev = m.map((x, i) => ({ t: 0.3 + i * 0.28, dur: 0.26, midi: x, stress: true }));
  ev.push({ t: 5.2, dur: 1.2, midi: 33, slideTo: 38, slideStart: 0.4, slideLen: 0.25, stress: true });
  cases.push({ name: 'STRESS: sharp, weak fundamental, vibrato, hum', total: 7, ev });
}

// 8. slide-in, slide-out (fall-off) and vibrato
cases.push({
  name: 'slide-in / slide-out / vibrato', total: 9, ev: [
    { t: 0.3, dur: 0.9, midi: 45, slideInFrom: 5, slideInLen: 0.14 },
    { t: 1.5, dur: 1.0, midi: 50, outAt: 0.45, outDrop: 6, outLen: 0.35 },
    { t: 2.8, dur: 1.0, midi: 40, vib: { rate: 5.5, depth: 0.4 } },
    { t: 4.1, dur: 1.0, midi: 43 },
    { t: 5.4, dur: 0.9, midi: 47, slideInFrom: 4, slideInLen: 0.13 },
    { t: 6.6, dur: 1.0, midi: 52, outAt: 0.4, outDrop: 5, outLen: 0.3 },
    { t: 7.9, dur: 0.9, midi: 38, vib: { rate: 6.5, depth: 0.35 } }
  ]
});

// 9. REGRESSION: notes that start from DIGITAL SILENCE with a slow fade-in, the way a separated stem does,
//    at awkward sub-block offsets. The old onset gate judged loudness on the block holding the energy jump,
//    which is still quiet in such a note, so these notes were silently dropped (the missing D2 pickup in
//    "Play That Funky Music"). Tunable via ATT_LEN / ATT_DB to probe the gate's margin.
{
  const ATT_LEN = +process.env.ATT_LEN || 0.03, ATT_DB = +process.env.ATT_DB || 90;
  const ev = [], pat = [40, 38, 40, 43, 45, 43, 40, 38, 47, 45, 40, 38];
  pat.forEach((m, i) => ev.push({ t: 0.31 + i * 0.5231 + (i % 5) * 0.0037, dur: 0.28 + (i % 3) * 0.05, midi: m, attLen: ATT_LEN, attDb: ATT_DB }));
  cases.push({ name: 'REGRESSION notes from digital silence', total: 7.2, clean: true, ev });
}

let tot = { gt: 0, hit: 0, pitchOK: 0, extra: 0, slideGT: 0, slideOK: 0, legGT: 0, legOK: 0, slapGT: 0, slapOK: 0, slapFalse: 0, muteGT: 0, muteOK: 0 };

for (const c of cases) {
  const audio = render(c.ev, c.total, c.clean);
  const t0 = Date.now();
  A.analyze([audio], SR).then(res => {
    const notes = res.notes, used = new Set();
    // expand ground truth: legato produces a second note at legatoAt
    const gt = [];
    c.ev.forEach(e => {
      if (e.mute) { gt.push({ t: e.t, mute: true }); return; }
      gt.push({ t: e.t, midi: e.midi, slideTo: e.slideTo, slap: !!e.slap, slideIn: e.slideInFrom != null ? 'up' : null, slideOut: e.outDrop != null ? 'down' : null, vib: !!e.vib });
      if (e.legatoTo != null) gt.push({ t: e.t + e.legatoAt, midi: e.legatoTo, legato: true });
    });
    let s = { gt: gt.length, hit: 0, pitchOK: 0, slideGT: 0, slideOK: 0, legGT: 0, legOK: 0, slapGT: 0, slapOK: 0, slapFalse: 0, muteGT: 0, muteOK: 0 };
    const detail = [];
    gt.sort((a, b) => a.t - b.t).forEach(g => {
      let bi = -1, bd = 1e9;
      notes.forEach((n, i) => { const dd = Math.abs(n.time - g.t); if (!used.has(i) && dd < bd) { bd = dd; bi = i; } });
      const tolT = g.legato ? 0.12 : 0.06;
      const n = bi >= 0 && bd <= tolT ? notes[bi] : null;
      if (n) used.add(bi);
      if (g.mute) { s.muteGT++; if (n && n.mute) { s.muteOK++; s.hit++; } else detail.push(`  MISS mute @${g.t.toFixed(2)}`); return; }
      if (g.slideTo != null) s.slideGT++;
      if (g.legato) s.legGT++;
      if (g.slap) s.slapGT++;
      if (!n || n.mute) { detail.push(`  MISS note @${g.t.toFixed(2)} midi ${g.midi}`); return; }
      s.hit++;
      if (n.midi === g.midi) s.pitchOK++; else detail.push(`  WRONG PITCH @${g.t.toFixed(2)} got ${n.midi} want ${g.midi}`);
      if (g.slideTo != null) { if (n.slideTo === g.slideTo) s.slideOK++; else detail.push(`  SLIDE @${g.t.toFixed(2)} got ${n.slideTo} want ${g.slideTo}`); }
      if (g.slideIn) { s.siGT = (s.siGT || 0) + 1; if (n.slideIn === g.slideIn) s.siOK = (s.siOK || 0) + 1; else detail.push(`SLIDE-IN missed @${g.t.toFixed(2)} got ${n.slideIn}`); }
      else if (n.slideIn) detail.push(`FALSE SLIDE-IN @${g.t.toFixed(2)}`);
      if (g.slideOut) { s.soGT = (s.soGT || 0) + 1; if (n.slideOut === g.slideOut) s.soOK = (s.soOK || 0) + 1; else detail.push(`SLIDE-OUT missed @${g.t.toFixed(2)} got ${n.slideOut}`); }
      else if (n.slideOut) detail.push(`FALSE SLIDE-OUT @${g.t.toFixed(2)}`);
      if (g.vib) { s.vbGT = (s.vbGT || 0) + 1; if (n.vibrato) s.vbOK = (s.vbOK || 0) + 1; else detail.push(`VIBRATO missed @${g.t.toFixed(2)}`); }
      else if (n.vibrato) detail.push(`FALSE VIBRATO @${g.t.toFixed(2)}`);
      if (g.legato) { if (n.technique === 'legato') s.legOK++; else detail.push(`  LEGATO tag missing @${g.t.toFixed(2)} (${n.technique})`); }
      if (g.slap) { if (n.slap) s.slapOK++; else detail.push(`  SLAP missed @${g.t.toFixed(2)} bright=${n.feat && n.feat.bright.toFixed(2)}`); }
      else if (n.slap) { s.slapFalse++; detail.push(`  FALSE SLAP @${g.t.toFixed(2)} bright=${n.feat.bright.toFixed(2)}`); }
    });
    const extra = notes.filter((n, i) => !used.has(i));
    extra.forEach(n => detail.push(`  EXTRA note @${n.time.toFixed(2)} midi ${n.midi}${n.mute ? ' (mute)' : ''}`));
    console.log(`\n${c.name}: notes found ${notes.length}/${gt.length} | pitch ${s.pitchOK}/${s.gt - s.muteGT} | extra ${extra.length}` +
      (s.slideGT ? ` | slides ${s.slideOK}/${s.slideGT}` : '') + (s.legGT ? ` | legato ${s.legOK}/${s.legGT}` : '') +
      (s.slapGT ? ` | slaps ${s.slapOK}/${s.slapGT}, false ${s.slapFalse}` : '') + (s.muteGT ? ` | mutes ${s.muteOK}/${s.muteGT}` : '') + (s.siGT ? ` | slide-in ${s.siOK || 0}/${s.siGT}` : '') + (s.soGT ? ` | slide-out ${s.soOK || 0}/${s.soGT}` : '') + (s.vbGT ? ` | vibrato ${s.vbOK || 0}/${s.vbGT}` : '') + `  (${Date.now() - t0} ms)`);
    detail.slice(0, 12).forEach(l => console.log(l));
    for (const k in s) tot[k] += s[k]; tot.extra += extra.length;
    if (c === cases[cases.length - 1]) setTimeout(() => {
      console.log(`\nTOTAL: onset hit ${tot.hit}/${tot.gt}, pitch ${tot.pitchOK}/${tot.gt - tot.muteGT}, extra notes ${tot.extra}, slides ${tot.slideOK}/${tot.slideGT}, legato ${tot.legOK}/${tot.legGT}, slap ${tot.slapOK}/${tot.slapGT} (false ${tot.slapFalse}), mutes ${tot.muteOK}/${tot.muteGT}`);
    }, 50);
  }).catch(e => console.log(c.name, 'ERROR', e.message));
}
