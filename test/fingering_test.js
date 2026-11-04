// node test/fingering_test.js   -> checks the fingering engine against bass-technique rules
const F = require('../fingering.js'), tab = require('./tabtext.js');
const E = [28, 33, 38, 43];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };
const mk = (midis, step) => midis.map((m, i) => ({ time: i * (step || 0.25), midi: m, dur: (step || 0.25) * 0.8 }));
const fp = ns => ns.map(n => n.mute ? 'x' : n.string + ':' + n.fret).join(' ');
const span = ns => { const f = ns.filter(n => n.fret > 0).map(n => n.fret); return f.length ? Math.max(...f) - Math.min(...f) : 0; };

// 1. chromatic run 1-2-3-4 stays on one string, one finger per fret
{ const n = mk([29, 30, 31, 32]); F.assign(n, E);
  ok(new Set(n.map(x => x.string)).size === 1 && n.every((x, i) => x.fret === i + 1), 'chromatic run should be frets 1-4 on one string: ' + fp(n));
  ok(n.map(x => x.finger).join('') === '1234', 'fingers should be 1 2 3 4: ' + n.map(x => x.finger)); }

// 2. repeated pitch stays on the same string and fret
{ const n = mk([40, 40, 40, 40, 43, 43]); F.assign(n, E);
  ok(n.slice(0, 4).every(x => x.string === n[0].string && x.fret === n[0].fret), 'repeated notes must not move: ' + fp(n)); }

// 3. hammer-on / pull-off and slide stay on one string
{ const n = mk([33, 35, 38, 40, 45, 47]); n[1].technique = 'legato'; n[3].technique = 'legato'; n[4].slideTo = 50; F.assign(n, E);
  ok(n[0].string === n[1].string, 'hammer-on must be on one string: ' + fp(n));
  ok(n[2].string === n[3].string, 'second hammer-on must be on one string: ' + fp(n));
  ok(n[4].fret > 0 && (n[4].slideTo - E[n[4].string]) <= 22, 'slide needs a fretted start'); }

// 4. a hand-friendly pentatonic climb needs few shifts
{ const n = mk([40, 43, 45, 47, 50, 52, 55, 57], 0.3); F.assign(n, E);
  let shifts = 0; for (let i = 1; i < n.length; i++) if (n[i].fret > 0 && n[i - 1].fret > 0 && Math.abs(n[i].pos - n[i - 1].pos) > 0) shifts++;
  ok(shifts <= 2, 'pentatonic climb should need at most 2 position shifts, got ' + shifts + ': ' + fp(n)); }

// 5. REPEATED PHRASES: same fingering every time, even with different notes around them
{ const riff = [38, 40, 28, 33, 35, 38, 40, 28]; let m = [];
  const around = [[45, 43], [28], [40, 38, 36], [31, 33], [52], [43, 45, 47]];
  around.forEach((a, i) => { m = m.concat(a, riff); });
  const n = mk(m, 0.18); n.forEach(x => { x.time += 0; });
  F.assign(n, E);
  const starts = []; let idx = 0; around.forEach(a => { idx += a.length; starts.push(idx); idx += riff.length; });
  const variants = new Set(starts.map(s => fp(n.slice(s, s + riff.length))));
  ok(variants.size === 1, 'all ' + starts.length + ' copies of the riff must share one fingering, got ' + variants.size + ': ' + Array.from(variants).join(' | ')); }

// 6. the real shape of Play That Funky Music (4 copies + a partial copy): identical fingering throughout
{ const riff = [38, 40, 28, 33, 35, 38, 40, 28]; let m = [28]; riff.forEach(x => m.push(x)); riff.forEach(x => m.push(x));
  m = m.concat([40, 28, 33, 35, 38, 40, 28]); m.push(-1); riff.forEach(x => m.push(x)); riff.forEach(x => m.push(x)); m = m.concat([40, 28]);
  const n = m.map((x, i) => ({ time: i * 0.16, midi: x < 0 ? null : x, mute: x < 0, dur: 0.12, technique: ([35, 40].includes(x) && i > 0 && m[i - 1] !== -1 && (x === 35 ? m[i - 1] === 33 : m[i - 1] === 38)) ? 'legato' : undefined }));
  F.assign(n, E);
  const copies = []; let i = 1; while (i + 8 <= n.length) { if (n[i].midi === 38 && n[i + 7] && n[i + 7].midi === 28) { copies.push(fp(n.slice(i, i + 8))); i += 8; } else i++; }
  ok(copies.length >= 4 && new Set(copies).size === 1, 'funk riff copies should be identical (' + copies.length + ' copies): ' + Array.from(new Set(copies)).join(' | ')); }

// 7. speed: 1500 notes
{ const m = []; for (let i = 0; i < 1500; i++) m.push(28 + [0, 3, 5, 7, 10, 12, 10, 7][i % 8] + (i % 40 < 20 ? 0 : 5));
  const n = mk(m, 0.15); const t0 = Date.now(); F.assign(n, E); const ms = Date.now() - t0;
  ok(ms < 4000, '1500 notes took ' + ms + ' ms'); console.log('  1500 notes fingered in ' + ms + ' ms'); }

// 8. unplayable pitch falls back gracefully
{ const n = mk([10, 40]); F.assign(n, E); ok(n[0].unplayable === true && n[0].string != null, 'unplayable note flagged'); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
