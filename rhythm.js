/* Lowline rhythm engine
 *
 *   estimate(notes)            -> { bpm, origin, confidence }   tempo + where bar 1 starts (seconds)
 *   build(notes, cfg)          -> { events, bars, ... }          16th-note grid, bars, note values, rests, ties
 *
 * Time is measured in sixteenth-note UNITS (16th = 1, 8th = 2, quarter = 4 ...).
 * Works in the browser (window.LowlineRhythm) and in Node.
 */
(function (root) {
  'use strict';

  const SIGS = {
    '4/4': { num: 4, den: 4, bar: 16, beat: 4 },
    '3/4': { num: 3, den: 4, bar: 12, beat: 4 },
    '2/4': { num: 2, den: 4, bar: 8, beat: 4 },
    '6/8': { num: 6, den: 8, bar: 12, beat: 6 },
    '12/8': { num: 12, den: 8, bar: 24, beat: 6 }
  };
  const ALLOWED = [1, 2, 3, 4, 6, 8, 12, 16];            // 16th, 8th, dotted 8th, quarter, dotted quarter, half, dotted half, whole
  const CFG = { minBpm: 60, maxBpm: 180, priorBpm: 105, priorOct: 0.55, sigma: 0.028, posWeight: [1, 0.45, 0.75, 0.45] };

  const floorAllowed = n => { let r = 1; for (const a of ALLOWED) if (a <= n) r = a; return r; };
  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function weights(notes) { return notes.map(n => (n.technique === 'legato' ? 0.4 : 1) * (n.mute ? 0.7 : 1)); }

  // ---- tempo: which 16th-note grid do the onsets sit on? ----
  function estimate(notes) {
    const T = notes.map(n => n.time), W = weights(notes);
    if (T.length < 4) return { bpm: 100, origin: T.length ? T[0] : 0, confidence: 0 };
    const sumW = W.reduce((a, b) => a + b, 0);
    let best = { score: -1, bpm: 100, off: 0 };
    for (let bpm = CFG.minBpm; bpm <= CFG.maxBpm; bpm += 0.25) {
      const p = 15 / bpm, beat = 4 * p, prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / CFG.priorBpm) / CFG.priorOct, 2));
      for (let off = 0; off < beat; off += 0.005) {
        let sc = 0;
        for (let i = 0; i < T.length; i++) {
          const x = (T[i] - off) / p, r = Math.round(x), err = (x - r) * p, pos = ((r % 4) + 4) % 4;
          sc += W[i] * CFG.posWeight[pos] * Math.exp(-0.5 * Math.pow(err / CFG.sigma, 2));
        }
        sc = sc / sumW * prior;
        if (sc > best.score) best = { score: sc, bpm, off };
      }
    }
    // refine bpm/offset around the winner
    for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5; bpm += 0.05) {
      const p = 15 / bpm, beat = 4 * p;
      for (let off = Math.max(0, best.off - 0.01); off < Math.min(beat, best.off + 0.01); off += 0.001) {
        let sc = 0;
        for (let i = 0; i < T.length; i++) {
          const x = (T[i] - off) / p, r = Math.round(x), err = (x - r) * p, pos = ((r % 4) + 4) % 4;
          sc += W[i] * CFG.posWeight[pos] * Math.exp(-0.5 * Math.pow(err / CFG.sigma, 2));
        }
        sc = sc / sumW * Math.exp(-0.5 * Math.pow(Math.log2(bpm / CFG.priorBpm) / CFG.priorOct, 2));
        if (sc > best.score) best = { score: sc, bpm, off };
      }
    }
    const bpm = Math.round(best.bpm * 10) / 10, p = 15 / bpm, beat = 4 * p;
    // which beat is the downbeat? the one where the longest notes land
    const phaseScore = [0, 0, 0, 0];
    notes.forEach((n, i) => {
      const x = (n.time - best.off) / beat, r = Math.round(x);
      if (Math.abs(x - r) * beat < 0.05) phaseScore[((r % 4) + 4) % 4] += Math.min(1.5, n.dur || 0.2) * W[i];
    });
    let phase = 0; phaseScore.forEach((v, k) => { if (v > phaseScore[phase] + 1e-9) phase = k; });
    let origin = best.off + phase * beat;
    const bar = 4 * beat;
    origin -= Math.ceil((origin - T[0] + 0.02) / bar) * bar;   // bar 1 starts at or before the first note
    return { bpm, origin, confidence: Math.min(1, best.score / 0.8) };
  }

  // ---- quantize + bars ----
  function build(notes, cfg) {
    cfg = cfg || {};
    const sig = SIGS[cfg.sig] ? cfg.sig : '4/4', S = SIGS[sig], bpm = cfg.bpm || 100, p = 15 / bpm;
    let origin = cfg.origin != null ? cfg.origin : (notes.length ? notes[0].time : 0);
    const barU = S.bar;
    if (notes.length && Math.round((notes[0].time - origin) / p) < 0) origin -= Math.ceil(-Math.round((notes[0].time - origin) / p) / barU) * barU * p;
    // onset positions on the grid, strictly increasing
    const u = []; let last = -1e9;
    notes.forEach((n, i) => { let q = Math.round((n.time - origin) / p); if (q <= last) q = last + 1; u.push(q); last = q; });
    const minU = u.length ? Math.min(0, u[0]) : 0;
    // note values
    const len = notes.map((n, i) => {
      const next = i + 1 < notes.length ? u[i + 1] : null, ioi = next != null ? next - u[i] : null;
      const sound = Math.max(1, Math.round(((n.time + (n.dur || 0.1)) - origin) / p - u[i]));
      if (ioi == null) return floorAllowed(Math.max(1, Math.min(sound, barU)));
      if (n.slideOut || sound >= 0.6 * ioi) return Math.max(1, ioi);           // rings into the next note
      return floorAllowed(Math.max(1, Math.min(sound, ioi)));                     // staccato: shorter than the gap
    });
    // build events, splitting at barlines and filling gaps with rests
    const events = []; let cursor = 0;                                          // cursor = next free unit
    const pushRest = (from, to) => {
      while (from < to) {
        const bar = Math.floor(from / barU), room = Math.min(to, (bar + 1) * barU) - from;
        let piece = floorAllowed(room);
        if (from % barU === 0 && room === barU) piece = barU;                   // whole-bar rest
        events.push({ kind: 'rest', u: from, len: piece, bar, pos: from - bar * barU });
        from += piece;
      }
    };
    notes.forEach((n, i) => {
      const start = Math.max(u[i], cursor);
      if (start > cursor) pushRest(cursor, start);
      let remaining = len[i], first = true, cur = start;
      while (remaining > 0) {                       // a note that crosses a barline is split and tied
        const bar = Math.floor(cur / barU), room = (bar + 1) * barU - cur, part = Math.min(remaining, room);
        const shown = ALLOWED.includes(part) ? part : floorAllowed(part);
        events.push({ kind: first ? 'note' : 'tie', note: i, u: cur, len: shown, bar, pos: cur - bar * barU });
        if (shown < part) pushRest(cur + shown, cur + part);
        remaining -= part; cur += part; first = false;
      }
      cursor = Math.max(cursor, cur);
    });
    // trailing rest to complete the last bar
    const lastBar = Math.floor((Math.max(cursor, 1) - 1) / barU);
    pushRest(cursor, (lastBar + 1) * barU);
    events.sort((a, b) => a.u - b.u || (a.kind === 'rest') - (b.kind === 'rest'));
    notes.forEach((n, i) => { n.q = { u: u[i], len: len[i], bar: Math.floor(u[i] / barU), pos: u[i] - Math.floor(u[i] / barU) * barU }; });
    const bars = events.length ? events[events.length - 1].bar + 1 : 1;
    return { sig, bpm, origin, p, barU, beatU: S.beat, bars, events, minU };
  }

  const api = { SIGS, CFG, ALLOWED, estimate, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LowlineRhythm = api;
})(typeof window !== 'undefined' ? window : globalThis);
