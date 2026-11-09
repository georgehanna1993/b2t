/* Lowline fingering engine
 *
 * Chooses string + fret for every note the way an experienced bassist would.
 *
 * Model (from standard bass technique: one finger per fret, economy of motion):
 *   - The fretting hand has a POSITION p = fret under the index finger and covers p..p+3
 *     (one finger per fret). Reaching one fret outside (p-1 or p+4) is a cheap "stretch".
 *   - A full position SHIFT costs more the further it travels, and much more when the
 *     notes are fast (a shift needs time).
 *   - Open strings don't move the hand. They are welcome in fast lines, mildly avoided in slow ones.
 *   - Hammer-ons / pull-offs and slides must stay on ONE string.
 *   - A repeated note stays on the same string/fret.
 *   - REPEATED PHRASES get the same fingering every time. Each repeated phrase is solved once:
 *     every fingering that appears for it (or is best in isolation) is tried on ALL repeats
 *     in the context of the whole song, and the cheapest wins.
 *
 * Output on each note: string (0 = lowest), fret, finger (0 open, 1-4), pos (hand position).
 * Works in the browser (window.LowlineFingering) and in Node.
 */
(function (root) {
  'use strict';

  const CFG = {
    maxFret: 22,
    stretch: 0.35,        // one fret outside the 4-fret hand span
    shiftBase: 0.9,       // any position shift
    shiftPerFret: 0.35,   // per fret travelled
    cross: 0.35,          // per string crossed
    skipString: 0.4,      // extra per skipped string
    sameNoteMove: 2.5,    // repeating a pitch on a different string/fret
    highFret: 0.03,       // gentle pull toward lower positions
    veryHigh: 0.06,       // frets above 12
    openFast: -0.12,      // open string in a fast passage
    openSlow: 0.12,       // open string in a slow/lyrical passage
    openLong: 0.2,        // open string under a long, sustained note
    fastIoi: 0.22,        // seconds between notes that count as "fast"
    fretLegato: 0.25,     // hammer/pull between two fretted notes
    slideBase: 0.1,
    slidePerFret: 0.02,
    hard: 100,            // forbidden
    minMotif: 4,
    maxMotif: 24,
    maxGroups: 40,
    maxVariants: 6
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- candidates ----------
  function buildItems(notes, openMidis) {
    const items = [];
    let prevPitched = -1;
    notes.forEach((n, i) => {
      if (n.mute || n.midi == null) return;
      const candsAt = (shift, noSlide) => {
        const out = [];
        openMidis.forEach((open, s) => {
          const f = n.midi + shift - open;
          if (f < 0 || f > CFG.maxFret) return;
          let endF = f;
          if (n.slideTo != null && !noSlide) { endF = n.slideTo + shift - open; if (endF < 0 || endF > CFG.maxFret) return; }
          out.push({ s, f, endF });
        });
        return out;
      };
      // below the lowest string (e.g. a 5-string's low D on a 4-string): play it an octave up, as a bassist would
      let octUp = 0, cands = candsAt(0);
      while (!cands.length && n.midi + octUp < Math.min(...openMidis) && octUp < 24) { octUp += 12; cands = candsAt(octUp); }
      // a slide longer than any string (e.g. 2 octaves down): play the start note and slide off it (slide-out), not a negative fret
      let slideCut = false;
      if (!cands.length && n.slideTo != null) { cands = candsAt(octUp, true); slideCut = cands.length > 0; }
      const prev = prevPitched >= 0 ? items[prevPitched] : null;
      const ioi = prev ? Math.max(0.03, n.time - prev.n.time) : 1;
      items.push({
        i, n, cands, ioi, octUp, slideCut,
        prevMidi: prev ? prev.n.midi : null,
        legato: n.technique === 'legato' && !!prev,
        slideIn: n.slideIn || null, slideOut: n.slideOut || null
      });
      prevPitched = items.length - 1;
    });
    return items;
  }

  // ---------- one step of the hand model ----------
  // returns [{cost, pos}] (several when the hand position is a free choice)
  function moves(prev, item, c) {
    const { n, ioi } = item, out = [];
    const sf = clamp(0.35 / ioi, 0.6, 2.5);               // fast -> shifting is costlier
    let base = 0;

    // technique constraints
    if (n.slideTo != null && c.f === 0) base += CFG.hard;                 // can't slide from an open string
    if (item.slideOut === 'down' && c.f < 2) base += CFG.hard;
    if (item.slideIn === 'up' && c.f < 1) base += CFG.hard;
    if (item.slideIn === 'down' && c.f > CFG.maxFret - 2) base += CFG.hard;
    if (item.legato && prev && prev.c.s !== c.s) base += CFG.hard;        // hammer-on/pull-off stays on one string
    if (item.legato && prev && prev.c.endF > 0 && c.f > 0) base += CFG.fretLegato;   // fretted-to-fretted legato is harder than from open
    if (prev && item.prevMidi === n.midi && !item.legato) {
      if (prev.c.s !== c.s || prev.c.endF !== c.f) base += CFG.sameNoteMove;
    }

    // string crossing
    if (prev) {
      const ds = Math.abs(prev.c.s - c.s);
      if (ds > 0) base += (CFG.cross * ds + CFG.skipString * Math.max(0, ds - 1)) * (0.8 + 0.2 * sf);
    }
    // register / open-string taste
    base += CFG.highFret * c.f + CFG.veryHigh * Math.max(0, c.f - 12);
    if (c.f === 0) base += ioi < CFG.fastIoi ? CFG.openFast : (n.dur >= 0.5 ? CFG.openLong : CFG.openSlow);
    // slide travel (the hand moves with the slide, so no separate shift cost)
    const slideCost = n.slideTo != null ? CFG.slideBase + CFG.slidePerFret * Math.abs(c.endF - c.f) : 0;

    // where does the hand end up after this note?
    const endFret = c.endF;
    const posAfter = (cost0, p0) => {
      if (n.slideTo != null && c.endF > 0) { for (let p = Math.max(1, c.endF - 3); p <= c.endF; p++) out.push({ cost: cost0 + slideCost, pos: p }); return; }
      out.push({ cost: cost0 + slideCost, pos: p0 });
    };

    if (c.f === 0) { // open string: hand stays
      posAfter(base, prev ? prev.pos : 0);
      return out;
    }
    const f = c.f, pos = prev ? prev.pos : 0;
    if (pos === 0) { // hand position still free: pick the most useful one at no cost
      if (n.slideTo != null && c.endF > 0) { for (let q = Math.max(1, endFret - 3); q <= endFret; q++) out.push({ cost: base + slideCost, pos: q }); }
      else for (let p = Math.max(1, f - 3); p <= f; p++) out.push({ cost: base, pos: p });
      return out;
    }
    if (f >= pos && f <= pos + 3) return posAfter(base, pos), out;
    if (f === pos - 1 || f === pos + 4) return posAfter(base + CFG.stretch, pos), out;
    // full shift: land the hand so that f is covered; nearest landing spots first
    const lo = Math.max(1, f - 3), hi = f;
    for (let p = lo; p <= hi; p++) {
      const cost = base + (CFG.shiftBase + CFG.shiftPerFret * Math.abs(p - pos)) * sf;
      if (n.slideTo != null && c.endF > 0) { for (let q = Math.max(1, endFret - 3); q <= endFret; q++) out.push({ cost: cost + slideCost, pos: q }); }
      else out.push({ cost, pos: p });
    }
    return out;
  }

  // ---------- dynamic programming over the whole line ----------
  function solve(items, locks) {
    const layers = [];
    for (let k = 0; k < items.length; k++) {
      const item = items[k], lock = locks && locks.get(k);
      let cands = item.cands;
      if (lock) { const f = cands.filter(c => c.s === lock.s && c.f === lock.f); if (f.length) cands = f; }
      const states = new Map();
      const put = (c, pos, score, back) => {
        const key = c.s * 1000 + c.f * 40 + pos;
        const ex = states.get(key);
        if (!ex || score < ex.score) states.set(key, { c, pos, score, back });
      };
      if (!cands.length) cands = [{ s: 0, f: 0, endF: 0, bad: true }];
      cands.forEach(c => {
        if (k === 0) { moves(null, item, c).forEach(m => put(c, m.pos, m.cost, null)); return; }
        layers[k - 1].forEach(prev => moves(prev, item, c).forEach(m => put(c, m.pos, prev.score + m.cost, prev)));
      });
      layers.push(Array.from(states.values()));
    }
    if (!layers.length) return { cost: 0, path: [] };
    let cur = layers[layers.length - 1].reduce((a, b) => (b.score < a.score ? b : a));
    const total = cur.score, path = new Array(items.length);
    for (let k = items.length - 1; k >= 0; k--) { path[k] = { c: cur.c, pos: cur.pos }; cur = cur.back; }
    return { cost: total, path };
  }

  // ---------- repeated phrases ----------
  const noteKeys = notes => notes.map(n => (n.mute ? 'x' : n.midi) + '|' + (n.technique || '') + '|' + (n.slideTo != null ? n.slideTo : '') + '|' + (n.slideOut || '') + (n.slideIn || ''));

  // every phrase (4..24 notes) that occurs at least twice without overlapping itself,
  // ranked by how much repeated material it explains: (copies - 1) * length
  function motifCandidates(notes) {
    const keys = noteKeys(notes), n = notes.length, out = [];
    for (let L = Math.min(CFG.maxMotif, Math.floor(n / 2)); L >= CFG.minMotif; L--) {
      const map = new Map();
      for (let i = 0; i + L <= n; i++) {
        const h = keys.slice(i, i + L).join(';');
        if (!map.has(h)) map.set(h, []);
        map.get(h).push(i);
      }
      for (const starts of map.values()) {
        if (starts.length < 2) continue;
        const occ = []; let end = -1;
        for (const s of starts) if (s >= end) { occ.push(s); end = s + L; }
        if (occ.length < 2) continue;
        if (!notes.slice(occ[0], occ[0] + L).some(q => !q.mute)) continue;
        out.push({ L, occ, keys: keys.slice(occ[0], occ[0] + L), score: (occ.length - 1) * L });
      }
    }
    out.sort((a, b) => b.score - a.score || b.occ.length - a.occ.length || b.L - a.L);
    return out;
  }
  const findMotifs = motifCandidates;

  function assign(notes, openMidis, opts) {
    opts = opts || {};
    notes.forEach(n => { n.string = null; n.fret = null; n.finger = null; n.pos = null; n.unplayable = false; n.octaveUp = 0; n.slideCut = false; });
    const items = buildItems(notes, openMidis);
    const itemOfNote = new Map(); items.forEach((it, k) => itemOfNote.set(it.i, k));
    const locks = new Map();
    if (opts.locks) Object.keys(opts.locks).forEach(i => { const k = itemOfNote.get(+i); if (k != null) locks.set(k, opts.locks[i]); });
    const userK = new Set(locks.keys());                    // the user's own choices: repeated-phrase consistency never overrides them

    let best = solve(items, locks);
    const info = { groups: 0, repeated: 0, cost0: best.cost };
    const claimed = new Array(notes.length).fill(false), allKeys = noteKeys(notes);
    const cands = opts.consistent === false ? [] : motifCandidates(notes);
    for (const g0 of cands) {
      if (info.groups >= CFG.maxGroups) break;
      const L = g0.L, occ = g0.occ.filter(s => { for (let q = s; q < s + L; q++) if (claimed[q]) return false; return true; });
      if (occ.length < 2) continue;
      const first = occ[0], ks = [];
      for (let q = first; q < first + L; q++) { const k = itemOfNote.get(q); if (k != null) ks.push(k); }
      if (!ks.length) continue;
      // fingerings to try: whatever the current solution did in each copy, plus the best one in isolation
      const seen = new Map(), asVar = (start, path) => ks.map(k0 => { const k = itemOfNote.get(items[k0].i - first + start); return { off: items[k0].i - first, s: path[k].c.s, f: path[k].c.f }; });
      occ.forEach(s => { const v = asVar(s, best.path); seen.set(v.map(x => x.s + ':' + x.f).join(','), v); });
      const iso = solve(ks.map(k => items[k]), null);
      const isoV = ks.map((k, j) => ({ off: items[k].i - first, s: iso.path[j].c.s, f: iso.path[j].c.f }));
      seen.set(isoV.map(x => x.s + ':' + x.f).join(','), isoV);
      let bestSol = null, bestTrial = null, bestV = null;
      Array.from(seen.values()).slice(0, CFG.maxVariants).forEach(v => {
        const trial = new Map(locks);
        occ.forEach(s => v.forEach(x => { const k2 = itemOfNote.get(s + x.off); if (k2 != null && !userK.has(k2)) trial.set(k2, { s: x.s, f: x.f }); }));
        const sol = solve(items, trial);
        if (!bestSol || sol.cost < bestSol.cost) { bestSol = sol; bestTrial = trial; bestV = v; }
      });
      bestTrial.forEach((v, k) => locks.set(k, v)); best = bestSol;
      occ.forEach(s => { for (let q = s; q < s + L; q++) claimed[q] = true; });
      info.groups++; info.repeated += occ.length;
      // partial copies of this phrase elsewhere (e.g. the same riff minus its first note) get the same fingering
      const byOff = new Map(bestV.map(x => [x.off, x]));
      for (let i = 0; i < notes.length; i++) {
        if (claimed[i]) continue;
        let bestM = 0, bestJ = -1;
        for (let j = 0; j < L; j++) {
          let m = 0;
          while (j + m < L && i + m < notes.length && !claimed[i + m] && allKeys[i + m] === g0.keys[j + m]) m++;
          if (m > bestM) { bestM = m; bestJ = j; }
        }
        if (bestM >= CFG.minMotif) {
          for (let t = 0; t < bestM; t++) { const k2 = itemOfNote.get(i + t), x = byOff.get(bestJ + t); if (k2 != null && x && !userK.has(k2)) locks.set(k2, { s: x.s, f: x.f }); claimed[i + t] = true; }
          info.repeated++;
          i += bestM - 1;
        }
      }
      best = solve(items, locks);
    }

    // write results
    items.forEach((it, k) => {
      const st = best.path[k], n = it.n;
      n.string = st.c.s; n.fret = st.c.f; n.pos = st.pos;
      n.finger = st.c.f === 0 ? 0 : clamp(st.c.f - st.pos + 1, 1, 4);
      n.octaveUp = it.octUp && it.cands.length ? it.octUp : 0;
      n.slideCut = !!it.slideCut;
      if (st.c.bad || !it.cands.length) {
        n.unplayable = true;
        const alt = openMidis.map((o, s) => ({ s, f: n.midi - o })).filter(c => c.f >= 0 && c.f <= 24).sort((a, b) => a.f - b.f)[0];
        n.string = alt ? alt.s : 0; n.fret = alt ? alt.f : 0; n.finger = 0;
      }
    });
    // muted notes sit on the previous note's string
    let last = { s: 0, f: 0 };
    notes.forEach(n => { if (n.mute) { n.string = last.s; n.fret = last.f; n.finger = null; } else if (n.string != null) last = { s: n.string, f: n.fret }; });
    info.cost = best.cost;
    return info;
  }

  const api = { CFG, assign, findMotifs, motifCandidates, solve, buildItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LowlineFingering = api;
})(typeof window !== 'undefined' ? window : globalThis);
