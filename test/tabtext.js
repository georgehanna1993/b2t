// helper: render notes as an ASCII bass tab (for tests / debugging)
module.exports = function asciiTab(notes, perLine) {
  perLine = perLine || 16;
  const names = ['E', 'A', 'D', 'G'], out = [];
  for (let a = 0; a < notes.length; a += perLine) {
    const rows = [[], [], [], []];
    notes.slice(a, a + perLine).forEach(n => {
      for (let s = 0; s < 4; s++) {
        let t = '-';
        if (n.string === s) {
          t = n.mute ? 'x' : String(n.fret);
          if (n.technique === 'legato') t = (n.midi > 0 ? 'h' : '') + t;
          if (n.slideTo != null) t += '/';
        }
        rows[s].push(t);
      }
    });
    const w = rows.map(r => r.map(x => x.padEnd(3, '-')).join(''));
    for (let s = 3; s >= 0; s--) out.push(names[s] + '|' + w[s] + '|');
    out.push('');
  }
  return out.join('\n');
};
