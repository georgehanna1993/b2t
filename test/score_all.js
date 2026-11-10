// node test/score_all.js  - scores every song in samples/ that has a reference (owner's files; samples/ is git-ignored)
// prints found / precision per song and the totals, so each analysis change is measured on all songs at once.
const { execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
const S = path.join(__dirname, '..', 'samples');
const SONGS = [['AOBTD (stem)', 'ab48.wav', 'ab_ref.js'], ['Come Together', 'ct_sepbass.wav', 'ct_ref.js'], ['Billie Jean', 'bj_sepbass.wav', 'bj_ref.js'],
  ['Walking on the Moon', 'wotm_sepbass.wav', 'wotm_ref.js'], ['Stray Cat Strut', 'strut_sepbass.wav', 'strut_ref.js'], ['The Trooper (1st min)', 'trooper_66.wav', 'trooper_ref.js'],
  ['Thank You', 'thankyou_sepbass.wav', 'thankyou_ref.js'], ['Virtual Insanity', 'vi_sepbass.wav', 'vi_ref.js'], ['Something', 'something_sepbass.wav', 'something_ref.js']];
let F = 0, N = 0, R = 0, D = 0;
for (const [name, wav, ref] of SONGS) {
  if (!fs.existsSync(path.join(S, wav))) continue;
  const out = execFileSync('node', [path.join(__dirname, 'score_tab.js'), path.join(S, wav), path.join(S, ref)]).toString();
  const t = out.match(/TOTAL\s+(\d+)\s+([\d.]+)%/), p = out.match(/precision ([\d.]+)% \((\d+)\/(\d+)/);
  const n = +t[1], found = +t[2]; F += found / 100 * n; N += n; R += +p[2]; D += +p[3];
  console.log(`${name.padEnd(22)} found ${found.toFixed(1).padStart(5)}%   precision ${(+p[1]).toFixed(1).padStart(5)}%`);
}
console.log(`${'ALL (note-weighted)'.padEnd(22)} found ${(100 * F / N).toFixed(1).padStart(5)}%   precision ${(100 * R / D).toFixed(1).padStart(5)}%`);
