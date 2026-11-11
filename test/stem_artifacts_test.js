// Run: node test/stem_artifacts_test.js
// REGRESSIONS from a real separated stem (Nov 2026), rebuilt synthetically:
//  1. octave tail: the fundamental dies before the 2nd harmonic, so the end of a B1 read as a separate 'B2'
//     (real frames; the energy test that then drops it is covered by run.js keeping real plucked octaves)
//  2. two-step attack: a soft click 50 ms before the real pluck became a phantom dead note 'x'
//  3. short loud hit with no settled pitch produced no note at all (should be a dead note). NOTE: this synthetic
//     case does NOT fail on the old code (could not reproduce the 1-voiced-frame condition); it is a guard only,
//     the fix was verified on the real stem (13.57 s).
//  6. same-note re-pluck while the string rings (dip, or only a high click): merged into one note (Come Together).
//     The 'click' case fails on the old code; the 'dip' case is a guard only (a synthetic dip deep enough to
//     measure like the real one already triggers the normal onset test).
//  5. ghost note over a ringing note (bump too small for the onset test) was missed (real stem 15.64 s / 16.26 s);
//     the string is muted afterwards (the real ghost fell 49 dB in 150 ms), which is what tells it from a re-pluck
//  7. fret-touch blip: the fretting finger lands on a ringing open E to mute it and briefly sounds F (no pluck, ~50-100 ms,
//     synthetic 100 ms blip fails on the old code; shorter synthetic ones were already dropped as too few frames;
//     right before the next E pluck). It was read as an F1 note (Another One Bites the Dust, 17 times).
//  8. one-semitone legato step measured 0.9-0.95 semitones edge-to-edge: notes merged (Ool Tani Keda 0:39)
//  9. same-note re-pluck visible only as a 2-5 frame pitch dropout + small rise: merged (Ool Tani Keda 0:51, 0:57).
//     Tested on the real frames (no synthetic reproduction: a synthetic gap deep enough also trips the onset test)
// 10. fast same-note re-plucks (gallops): found from short pitch-confidence dips + a small energy rise (The Trooper)
// 11. transition blips: a <= 90 ms piece with no pluck within 2 semitones of a neighbour is dropped (Billie Jean A#1 extras)
//  4. F#1 -> B1 hammer-on where the pitch sags just before the jump and the tracker drops out for a few
//     frames during it: the F#1 vanished into the B1
const A = require('../analysis.js');
const P = k => +(process.env[k] || 0);
const SR = 48000, hz = m => 440 * Math.pow(2, (m - 69) / 12);
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
const rand = rng(3);
const harm = [0.55, 0.28, 0.14, 0.06];
function tone(out, t0, dur, midiAt, opts) {
  opts = opts || {}; let ph = 0;
  const i0 = Math.floor(t0 * SR), i1 = Math.min(out.length, Math.floor((t0 + dur) * SR));
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR, f = hz(midiAt(t)); ph += 2 * Math.PI * f / SR;
    const att = Math.min(1, t / (opts.att || 0.004)), rel = Math.min(1, (t0 + dur - i / SR) / 0.01);
    let v = 0;
    harm.forEach((a, h) => { const decay = opts.fundDecay && h === 0 ? Math.exp(-t * opts.fundDecay) : 1; v += Math.sin((h + 1) * ph) * a * decay; });
    out[i] += v * 0.6 * att * rel * Math.exp(-t * 2.5) * (opts.gain || 1) * (opts.env ? opts.env(t) : 1);
  }
}
const cases = [];
{ // 2: soft click 50 ms before each pluck
  const out = new Float32Array(SR * 3), want = [];
  [0.3, 1.1, 1.9].forEach(t => {
    for (let i = Math.floor((t - 0.05) * SR); i < Math.floor((t - 0.035) * SR); i++) out[i] += (rand() * 2 - 1) * 0.25;
    tone(out, t, 0.4, () => 40); want.push([t, 40]);
  });
  cases.push({ name: 'two-step attack gives no phantom x', out, want });
}
{ // 3: notes with a short loud unpitched hit between them
  const out = new Float32Array(SR * 3), want = [];
  tone(out, 0.3, 0.4, () => 40); want.push([0.3, 40]);
  // muted pluck: a pitched burst that dies in ~25 ms over a noisy thump, like the real one (one voiced frame)
  let lp = 0; for (let i = Math.floor(1.0 * SR); i < Math.floor(1.07 * SR); i++) { const t = i / SR - 1.0; lp += 0.25 * ((rand() * 2 - 1) - lp); out[i] += lp * 1.2 * Math.exp(-t * 30) + Math.sin(2 * Math.PI * hz(40) * t) * 0.9 * Math.exp(-t * (P('MD') || 90)); }
  want.push([1.0, 'x']);
  tone(out, 1.6, 0.4, () => 40); want.push([1.6, 40]);
  cases.push({ name: 'short loud hit becomes a dead note', out, want });
}
{ // 5: ghost touch inside a ringing note: the energy dips and comes back ~6 dB with a click, same pitch -> 'x'.
  //    A gentle 3 dB swell (sidechain pumping) must NOT become a ghost.
  const out = new Float32Array(SR * 3), want = [];
  const ghostEnv = tg => s => { const u = s - tg; const dip = P('DIP') || 0.5, top = P('TOP') || 1.3; return u < -0.03 ? 1 : u < 0 ? 1 - (1 - dip) * (u + 0.03) / 0.03 : dip + (top - dip) * Math.min(1, u / 0.01) * Math.exp(-u * (P('GD') || 25)); };
  tone(out, 0.3, 0.6, () => 38, { env: ghostEnv(0.33) }); want.push([0.3, 38], [0.63, 'x']);
  for (let i = Math.floor(0.63 * SR); i < Math.floor(0.636 * SR); i++) out[i] += (rand() * 2 - 1) * 0.15;
  tone(out, 1.5, 0.6, () => 38, { env: s => 1 + 0.4 * Math.max(0, Math.sin(Math.PI * (s - 0.3) / 0.15)) * (s > 0.3 && s < 0.45 ? 1 : 0) }); want.push([1.5, 38]);
  cases.push({ name: 'ghost touch inside a ringing note is an x, a 3 dB swell is not', out, want });
}
{ // 6/7: the same note re-plucked as legato eighths (Come Together keyboard solo / outro): the string keeps ringing,
  //    so there is no normal onset. Version A: a short dip (measures ~4 dB in the analyzer, like the real one) as the finger meets the string. Version B: almost
  //    no dip, only the pluck click above 1.5 kHz. Both were merged into one long note.
  for (const kind of ['dip', 'click']) {
    const out = new Float32Array(SR * 3), want = [], step = 0.357, t0 = 0.3, n = 6;
    let ph = 0;
    for (let i = Math.floor(t0 * SR); i < Math.floor((t0 + n * step) * SR); i++) {
      const t = i / SR - t0, k = Math.floor(t / step), u = t - k * step;
      ph += 2 * Math.PI * hz(38) / SR;
      const dip = kind === 'dip' && k > 0 && u < 0.045 ? Math.pow(10, -8 * Math.sin(Math.PI * u / 0.045) / 20) : 1;
      const v = harm.reduce((a, h, j) => a + Math.sin((j + 1) * ph) * h, 0);
      out[i] += v * 0.5 * dip * (0.75 + 0.25 * Math.exp(-u * 6)) * Math.min(1, (t0 + n * step - i / SR) / 0.01);
    }
    for (let k = 0; k < n; k++) {
      want.push([t0 + k * step, 38]);
      if (kind === 'click' && k > 0) { let lp = 0; for (let i = Math.floor((t0 + k * step) * SR); i < Math.floor((t0 + k * step + 0.004) * SR); i++) { const x = rand() * 2 - 1; out[i] += (x - lp) * 0.08; lp = x; } }
    }
    cases.push({ name: `same note re-plucked while ringing (${kind})`, out, want });
  }
}
{ // 7: E1 ... (finger lands: pitch goes to F1, level drops) ... E1 plucked again
  const out = new Float32Array(SR * 3), want = [], BL = P('BLIP') || 0.1, DROP = P('DROP') || 6;
  [0.3, 0.75, 1.2, 1.65].forEach((t, k, a) => {
    const len = k < a.length - 1 ? a[k + 1] - t : 0.4, b0 = len - BL;
    const w = u => (k < a.length - 1 ? Math.max(0, Math.min(1, (u - b0) / 0.015)) : 0); // 15 ms smooth finger landing
    tone(out, t, len, u => 28 + w(u), { env: u => Math.pow(10, -DROP * w(u) / 20) });
    want.push([t, 28]);
  });
  cases.push({ name: 'fret-touch blip before a re-pluck is not a note', out, want });
}
{ // 12: owner's Arabic song (separated in-app): a short note an octave above a low note that is still ringing (A1 ... A2, G1 ... G2)
  //     read as the low note again - the ringing fundamental kept the tracker on the low period. A same-octave re-pluck stays.
  const out = new Float32Array(SR * 3), want = [];
  tone(out, 0.3, 0.55, () => 33); want.push([0.3, 33]);
  tone(out, 0.62, 0.11, () => 45, { gain: P('OG') || 0.9 }); want.push([0.62, 45]);
  tone(out, 0.85, 0.4, () => 38); want.push([0.85, 38]);
  tone(out, 1.4, 0.22, () => 31); want.push([1.4, 31]);
  tone(out, 1.62, 0.11, () => 31, { gain: 0.9 }); want.push([1.62, 31]);
  tone(out, 1.85, 0.4, () => 36); want.push([1.85, 36]);
  cases.push({ name: 'short octave-up note over a ringing low note', out, want });
}
{ // 13: owner's Arabic song 0:21.84: a 60 ms G1 pickup right before a G1 note was an 'x' (YIN frames never settled on 49 Hz)
  const out = new Float32Array(SR * 3), want = [];
  tone(out, 0.3, 0.5, () => 38); want.push([0.3, 38]);
  tone(out, 1.0, 0.06, () => 31); want.push([1.0, 31]);
  tone(out, 1.21, 0.45, () => 31); want.push([1.21, 31]);
  cases.push({ name: 'short pitched pickup is a note, not an x', out, want });
}
let pass = 0, fail = 0;
const check = (ok, name, info) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' | ' + info}`); };
// pitch frames recorded from the real stem (48 kHz decode), fed straight to buildPieces
const fr = a => a.map((m, i) => ({ t: i * 0.0107, m: m === null ? NaN : m, c: m === null ? 0 : 0.95 }));
{ // F#1 -> B1: sag 29.7 -> 29.2, 3 unvoiced frames, then B1. Was one piece (the F#1 vanished).
  const p = A.buildPieces(fr([29.6,29.68,29.73,29.72,29.7,29.67,29.64,29.66,29.69,29.71,29.7,29.67,29.43,29.48,29.15,29.2,null,null,null,34.51,34.61,34.58,34.64,34.7,34.76,34.78,34.82,34.84,34.87,34.86,34.85,34.82,34.83,34.84,34.82,34.73,34.64,34.74,34.88,null]));
  check(p.length === 2 && Math.round(p[0].mf) === 30 && Math.round(p[1].mf) === 35, 'jump across a pitch dropout keeps the note before it', p.map(q => q.mf.toFixed(1)).join(' '));
}
{ // F#1 -> B1 whose tail ends as B2 (2nd harmonic outlasting the fundamental). The B2 piece must be flagged so
  // analyze() can drop it when there is no pluck (it was emitted as a separate B2 note).
  const p = A.buildPieces(fr([29.72,29.71,29.67,29.67,29.67,29.67,29.68,29.67,29.67,29.66,29.66,29.66,29.67,29.67,29.67,29.65,29.64,29.64,29.64,29.64,29.63,29.64,29.62,29.63,29.42,29.3,null,null,null,34.57,34.8,34.79,34.85,34.86,34.95,35.04,35.08,35.12,35.12,35.11,35.05,35.02,35,35,35.02,35.02,35.02,35.01,34.99,34.95,34.94,34.96,35,34.82,34.71,34.57,34.9,null,46.96,46.91,46.85,46.86,46.87,46.91,47.02]));
  const tail = p.find(q => Math.round(q.mf) === 47);
  check(tail && tail.octaveTail === true, 'octave-up tail is flagged', tail ? 'not flagged' : 'no B2 piece');
}
{ // G#1 -> G1 one-semitone step with no pluck (Ool Tani Keda 0:39, frames from the separated bass). The step measured
  // 0.9-0.95 semitones edge-to-edge, under the 1.0 glide/jump minimum, so both notes became one G1.
  const p = A.buildPieces(fr([32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.0,32.1,31.9,31.4,31.1,30.9,31.0,31.0,31.1,31.1,31.1,31.0,31.0,30.9,31.0,31.0,31.0,31.0,31.0,31.2]));
  check(p.length === 2 && Math.round(p[0].mf) === 32 && Math.round(p[1].mf) === 31, 'one-semitone step (legato) splits the note', p.map(q => q.mf.toFixed(1)).join(' '));
  // guard: vibrato (+-0.45 around one pitch) stays one note
  const v = A.buildPieces(fr(Array.from({ length: 40 }, (_, i) => 32 + 0.45 * Math.sin(i * 0.9))));
  check(v.length === 1, 'vibrato stays one note', v.map(q => q.mf.toFixed(1)).join(' '));
}
{ // 9: same-note re-pluck seen only as a pitch dropout (Ool Tani Keda 0:51, frames from the separated bass). A synthetic
  // version could not be made: any synthetic gap deep enough to stop the tracker already trips the normal onset test.
  const f = [27.1,27,27,26.9,26.9,27,27,27,27,27,26.9,27,27,27,27,27,27,27,27,27,27,27,27,26.9,27,27,27.1,27.1,27,27.1,27.2,27.4,null,null,null,27,27.1,27.2,27.1,27,27,27,27,26.9,27,26.9,27,27.1,27.3,27.4,27.8];
  const has = typeof A.dropoutReplucks === 'function';
  const hit = has ? A.dropoutReplucks(fr(f), () => 4.6, 0) : [];
  check(hit.length === 1 && Math.abs(hit[0] - 35 * 0.0107) < 0.02, 'pitch dropout + same pitch + 4.6 dB rise = re-pluck', has ? hit.map(t => t.toFixed(3)).join(' ') : 'no dropoutReplucks()');
  check(has && A.dropoutReplucks(fr(f), () => 1.0, 0).length === 0, 'same dropout with no energy rise is not a re-pluck', 'fired');
  const g = f.map((m, i) => (m !== null && i > 34 ? m + 2 : m));  // different pitch after the gap: that is a note change, not this rule
  check(has && A.dropoutReplucks(fr(g), () => 4.6, 0).length === 0, 'dropout into a different pitch is left to the jump logic', 'fired');
}
{ // 10: fast same-note re-plucks (The Trooper's gallop, separated stem 15.64-16.22 s): pitch steady at E2, confidence dips
  // 0.83 / 0.86 at the two re-plucks. Found nothing before (both merged into one long E2).
  const m = [40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40.1,40.3,40.4,40.3,40.1,40,40,40,40,40,40,40,40,40,40,40.2,40.3,40.3,40.1,40,40,40,40,40,40];
  const cs = [.99,1,1,.99,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,.97,.89,.83,.83,.92,.96,.99,.99,.99,1,.99,.99,.99,1,.99,.96,.94,.86,.87,.89,.95,.98,.99,1,.99];
  const fr2 = m.map((v, i) => ({ t: 15.64 + i * 0.0116, m: v, c: cs[i] }));
  const has = typeof A.confDipReplucks === 'function', hit = has ? A.confDipReplucks(fr2, () => 4) : [];
  check(hit.length === 2 && Math.abs(hit[0] - 15.92) < 0.03 && Math.abs(hit[1] - 16.08) < 0.04, 'gallop re-plucks found from pitch-confidence dips', has ? hit.map(t => t.toFixed(2)).join(' ') : 'no confDipReplucks()');
  check(has && A.confDipReplucks(fr2, () => 0.5).length === 0, 'same dips without an energy rise are not re-plucks', 'fired');
  const steady = m.map((v, i) => ({ t: i * 0.0116, m: 40 + 0.3 * Math.sin(i * 0.8), c: 0.97 + 0.02 * Math.sin(i) }));
  check(has && A.confDipReplucks(steady, () => 4).length === 0, 'a steady (vibrato) note has no confidence dips', 'fired');
}
{ // 11: transition blip, real notes from Billie Jean (separated stem, 31.26-31.74 s): B1, a 70 ms A#1 with no pluck, C#2.
  // The A#1 was an extra note. A real short note WITH a pluck, and a longer legato note, must stay.
  const seq = () => [{ time: 31.26, midi: 35, dur: 0.15 }, { time: 31.41, midi: 34, dur: 0.07, inner: true, technique: 'legato' }, { time: 31.52, midi: 37, dur: 0.22 }];
  const has = typeof A.dropTransitions === 'function';
  const r = has ? A.dropTransitions(seq()) : seq();
  check(has && r[1].blip === true && !r[0].blip && !r[2].blip, 'a 70 ms pitch passing between two notes is not a note', has ? r.map(n => n.blip ? 'x' : n.midi).join(' ') : 'no dropTransitions()');
  const plucked = seq(); plucked[1].inner = false;
  const legato = seq(); legato[1].dur = 0.14;
  check(has && !A.dropTransitions(plucked)[1].blip && !A.dropTransitions(legato)[1].blip, 'a plucked short note or a 140 ms hammer-on stays', 'dropped');
}
// owner's Arabic song (Law Yeuaaidni El Hawa, 0:02.2): F2, ~65 ms of no pitch, then A2 with no onset of its own. The gap is too long
// to bridge, so no jump was seen and the A2 vanished into the F2. A clear pitch change across a gap splits the note.
{
  const p = A.buildPieces(fr([41.04,41.03,41.04,41.05,41.04,41.04,41.03,41.04,41.02,41.02,41.01,41.02,41.02,41.03,41.01,40.89,null,null,null,null,null,null,45.01,44.93,45.04,45.03,44.99,45.02,45.03,45.02,45.02,45,45.01,44.97,44.87]));
  check(p.length === 2 && Math.round(p[0].mf) === 41 && Math.round(p[1].mf) === 45 && p[1].technique !== 'legato', 'new pitch after a silent gap is its own (plucked) note', p.map(q => q.mf.toFixed(1) + (q.technique ? ' ' + q.technique : '')).join(' | '));
  const same = A.buildPieces(fr([41,41,41,41,41,41,41,41,null,null,null,null,null,null,41.02,41,41,41,41,41,41]));
  check(same.length === 1, 'same pitch across a gap stays one note (re-plucks are decided elsewhere)', same.length + ' pieces');
}
(async () => {
  for (const c of cases) {
    const notes = (await A.analyze([c.out], SR)).notes, used = new Set(), miss = [];
    c.want.forEach(([t, m]) => {
      const i = notes.findIndex((n, j) => !used.has(j) && Math.abs(n.time - t) < 0.07 && (m === 'x' ? n.mute : !n.mute && n.midi === m));
      if (i < 0) miss.push(`${t}:${m}`); else used.add(i);
    });
    const extra = notes.filter((n, j) => !used.has(j)).map(n => `${n.time.toFixed(2)}:${n.mute ? 'x' : n.midi}`);
    check(!miss.length && !extra.length, c.name, (miss.length ? 'missing ' + miss.join(' ') : '') + (extra.length ? ' extra ' + extra.join(' ') : ''));
  }
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
