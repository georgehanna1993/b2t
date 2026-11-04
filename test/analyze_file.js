// node test/analyze_file.js file.wav [out.json]   -> prints detected notes, writes JSON for plotting
const fs = require('fs'), A = require('../analysis.js');
const { readWav } = require('./wav.js');
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = m => names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const { chans, sr } = readWav(process.argv[2]);
const t0 = Date.now();
A.analyze(chans, sr).then(r => {
  const ns = r.notes;
  console.log(`${(chans[0].length / sr).toFixed(1)} s -> ${ns.length} notes in ${Date.now() - t0} ms | debug`, JSON.stringify(r.debug));
  ns.forEach((n, i) => console.log(String(i).padStart(3), n.time.toFixed(2).padStart(6), (n.mute ? 'x' : nm(n.midi)).padEnd(4),
    (n.slideTo != null ? ('-> ' + nm(n.slideTo)) : n.slideOut ? ('out ' + n.slideOut) : n.slideIn ? ('in ' + n.slideIn) : '').padEnd(10), 'dur', n.dur.toFixed(2), 'conf', n.confidence.toFixed(2),
    n.technique || '', n.vibrato ? 'VIBRATO' : '', n.slap ? 'SLAP' : '', n.feat ? 'br=' + n.feat.bright.toFixed(2) : '', n.rise !== undefined ? 'rise=' + n.rise.toFixed(1) : ''));
  const pc = {}; ns.filter(n => !n.mute).forEach(n => { const k = names[n.midi % 12]; pc[k] = (pc[k] || 0) + 1; });
  console.log('pitch classes:', JSON.stringify(pc));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({ sr, dur: chans[0].length / sr, notes: ns.map(n => ({ t: n.time, d: n.dur, m: n.midi, to: n.slideTo ?? null, mute: !!n.mute, tech: n.technique, c: n.confidence })) }));
});
