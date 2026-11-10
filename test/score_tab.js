// node test/score_tab.js file.wav reference.js
// Scores the analyzer against a known tab when the tab has no timing: aligns the two pitch sequences (like a diff)
// and counts matched / wrong pitch (octave errors separately) / missed / extra. A slide counts as both its notes.
// Reference module exports { sections: [[name, [midi...]], ...] }.
const A = require('../analysis.js'), { readWav } = require('./wav.js'), path = require('path');
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], nm = m => names[m % 12] + (Math.floor(m / 12) - 1);
function align(ref, got) {
  const n = ref.length, m = got.length, C = [];
  for (let i = 0; i <= n; i++) { C.push(new Int32Array(m + 1)); C[i][0] = i; }
  for (let j = 0; j <= m; j++) C[0][j] = j;
  const sub = (a, b) => a === b ? 0 : 1;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    C[i][j] = Math.min(C[i - 1][j - 1] + sub(ref[i - 1], got[j - 1].midi), C[i - 1][j] + 1, C[i][j - 1] + 1);
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && C[i][j] === C[i - 1][j - 1] + sub(ref[i - 1], got[j - 1].midi)) { ops.push([ref[i - 1] === got[j - 1].midi ? 'ok' : 'wrong', i - 1, j - 1]); i--; j--; }
    else if (i > 0 && C[i][j] === C[i - 1][j] + 1) { ops.push(['miss', i - 1, null]); i--; }
    else { ops.push(['extra', null, j - 1]); j--; }
  }
  return ops.reverse();
}
module.exports = { align };
if (require.main === module) {
  const ref = require(path.resolve(process.argv[3])), { chans, sr } = readWav(process.argv[2]);
  const verbose = process.argv.includes('-v');
  A.analyze(chans, sr).then(r => {
    const got = [];
    r.notes.forEach(n => { if (n.mute) return; got.push({ midi: n.midi, t: n.time }); if (n.slideTo != null) got.push({ midi: n.slideTo, t: n.time + 0.05, slide: true }); });
    const refN = [], secOf = [];
    ref.sections.forEach(([name, ns], k) => ns.forEach(m => { refN.push(m); secOf.push(k); }));
    let ops = align(refN, got);
    if (ref.partial) { let last = -1; ops.forEach((o, k) => { if (o[1] != null) last = k; }); ops = ops.slice(0, last + 1); }   // tab covers only the start of the song
    const per = ref.sections.map(s => ({ name: s[0], n: s[1].length, ok: 0, wrong: 0, oct: 0, miss: 0, extra: 0, t0: null }));
    let lastSec = 0; const mistakes = [];
    ops.forEach(([op, i, j]) => {
      const k = i != null ? secOf[i] : lastSec; if (i != null) lastSec = k; const P = per[k];
      if (j != null && P.t0 === null) P.t0 = got[j].t;
      if (op === 'ok') P.ok++;
      else if (op === 'wrong') { P.wrong++; if (Math.abs(refN[i] - got[j].midi) === 12) P.oct++; mistakes.push(`${got[j].t.toFixed(2)}s ${P.name}: got ${nm(got[j].midi)} want ${nm(refN[i])}`); }
      else if (op === 'miss') { P.miss++; mistakes.push(`   ~${(got[Math.max(0, (ops.find(o => o[1] === i + 1 && o[2] != null) || [0, 0, 0])[2])] || { t: 0 }).t.toFixed(2)}s ${P.name}: MISSED ${nm(refN[i])}`); }
      else { P.extra++; mistakes.push(`${got[j].t.toFixed(2)}s ${P.name}: EXTRA ${nm(got[j].midi)}`); }
    });
    const T = { n: 0, ok: 0, wrong: 0, oct: 0, miss: 0, extra: 0 };
    console.log('section          start   notes  correct  wrong(oct)  missed  extra');
    per.forEach(P => { ['n', 'ok', 'wrong', 'oct', 'miss', 'extra'].forEach(k => T[k] += P[k]);
      console.log(`${P.name.padEnd(16)} ${P.t0 == null ? '   -  ' : (P.t0.toFixed(1) + 's').padStart(6)} ${String(P.n).padStart(6)}  ${(100 * P.ok / P.n).toFixed(0).padStart(5)}%  ${String(P.wrong).padStart(5)}(${P.oct})  ${String(P.miss).padStart(6)}  ${String(P.extra).padStart(5)}`); });
    console.log(`TOTAL                    ${String(T.n).padStart(6)}  ${(100 * T.ok / T.n).toFixed(1).padStart(5)}%  ${String(T.wrong).padStart(5)}(${T.oct})  ${String(T.miss).padStart(6)}  ${String(T.extra).padStart(5)}`);
    console.log(`precision ${(100 * T.ok / got.length).toFixed(1)}% (${T.ok}/${got.length} detected notes are right)`);
    if (verbose) mistakes.forEach(x => console.log('  ' + x));
  });
}
