const fs = require('fs');
function readWav(path) {
  const b = fs.readFileSync(path);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, Math.min(b.length, p + 8 + sz)); break; }
    p += 8 + sz + (sz & 1);
  }
  const n = Math.floor(data.length / (fmt.bits / 8) / fmt.ch), chans = [];
  for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) chans[c][i] = data.readInt16LE((i * fmt.ch + c) * 2) / 32768;
  return { chans, sr: fmt.sr };
}
module.exports = { readWav };
