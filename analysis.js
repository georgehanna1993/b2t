/* Lowline analysis engine
 *
 * Pipeline:
 *   1. prepare      mono mix, band-limit to the bass range, decimate (~11 kHz)
 *   2. onsets       log-energy envelope -> note attacks (so repeated notes stay separate)
 *   3. per note     YIN pitch tracking AFTER the attack, then split into
 *                   plateaus -> slide (gradual glide) / legato (instant jump)
 *   4. techniques   slap (bright attack), muted (transient with no pitch)
 *   5. cleanup      global tuning offset, octave-glitch repair
 *   (string/fret choice lives in fingering.js, rhythm in rhythm.js)
 *
 * Works in the browser (window.LowlineAnalysis) and in Node (module.exports).
 * All tunable thresholds live in CFG.
 */
(function (root) {
  'use strict';

  const CFG = {
    hop: 128,            // envelope / pitch-frame hop (decimated samples, ~11.6 ms)
    envWin: 256,         // envelope window
    yinWin: 384,         // YIN integration window
    yinThresh: 0.18,     // absolute threshold for the first YIN dip
    yinVoicedMax: 0.40,  // fallback: global minimum must be below this to count as pitched
    minHz: 36,
    maxHz: 460,
    onsetDb: 5,          // minimum energy rise (dB) to call an onset
    onsetGapMs: 55,      // minimum spacing between onsets
    onsetLookMs: 30,     // energy rise is measured against the quietest point this far back (in ms, so it does not depend on sample rate)
    silenceRelDb: 36,    // anything this far below the loud notes is silence (hum, hiss, tails)
    runTol: 0.55,        // semitones: frame belongs to the current pitch plateau
    stableSpread: 0.35,  // semitones: 3 frames this tight form a new plateau
    slideMinSemis: 1.2,
    slideMinFrames: 3,   // transition lasting this many frames (~35 ms+) is a slide, shorter is legato
    legatoMinSemis: 0.7,
    slowMoveSemis: 0.7,  // ...or this much across 8 frames (catches slow glides)
    moveSemis: 0.45,     // pitch moved this much across 4 frames -> candidate glide/jump
    glideMinSemis: 1.0,  // net change needed to call it a glide or jump (vibrato stays below this)
    jumpMaxFrames: 5,    // a pitch change spread over <= this many frames (~58 ms) is a jump, longer is a glide
    hammerMaxSemis: 5,   // bigger leaps without a new attack are re-plucks, not hammer-ons/pull-offs
    kickMaxMidi: 35,     // kick-drum bleed lives down here (< ~62 Hz) and snaps back up
    tailDb: 24,          // frames this far under the note's peak are ignored (decaying tail, hum)
    legatoMaxRiseDb: 8,   // a pitch jump with an energy bump bigger than this at the same moment is a pluck, not a hammer-on
    minNoteFrames: 4,    // notes shorter than this need good confidence to survive
    holdFrames: 10,      // a pause shorter than this inside one gesture does not split a slide (~115 ms)
    slapBright: 0.18,    // fraction of attack energy above 1.5 kHz that suggests slap/pop
    muteMaxMs: 170,
    ghostRiseDb: 3,       // energy rise inside a loud ringing note that marks a ghost (muted) note or a re-pluck
    ghostMaxBelowDb: 15,  // ...only while the note is this close to the loudest notes
    ghostMinAgeMs: 120,   // ...and this long after the note's own attack
    ghostEnergyDb: 5,     // a ghost needs at least this short-term rise (like the legato test)
    repluckDipDb: 3,      // same pitch plucked again: energy dips this much just before the bump...
    repluckHoldDb: 4,     // ...and is still within this much of the bump 150 ms later
    repluckClickDb: 16,   // high-band (>1.5 kHz) click rise that marks a re-pluck (10 scores better on Come Together but adds a doubtful note to the Nov stem)
    muteBeforeNoteMs: 70, // a dead note this close before a pitched note is that note's pluck noise (a two-step attack)
    muteMinRelDb: 19,    // a dead/ghost note must be within this many dB of the loudest notes (quieter blips are bleed)
    quietBlipDb: 24,     // short notes quieter than this (vs the loudest notes) are dropped
    vibratoMinSemis: 0.30,
    unvoicedCost: 0.35,
    voicingSwitchCost: 0.3,
    minMidi: 23,
    maxMidi: 67
  };

  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  function median(a) {
    if (!a.length) return 0;
    const s = Array.from(a).sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function biquad(input, sr, type, cutoff) {
    const q = Math.SQRT1_2, w = 2 * Math.PI * cutoff / sr, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
    let b0, b1, b2;
    if (type === 'lowpass') { b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = b0; }
    else { b0 = (1 + c) / 2 / a0; b1 = -(1 + c) / a0; b2 = b0; }
    const a1 = -2 * c / a0, a2 = (1 - a) / a0, out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const x = input[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    return out;
  }

  function prepare(channels, sr) {
    const n = channels[0].length, mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
    const hp = biquad(mono, sr, 'highpass', 28);
    const lp = biquad(biquad(hp, sr, 'lowpass', 800), sr, 'lowpass', 800);
    const D = Math.max(1, Math.round(sr / 11025)), m = Math.floor(lp.length / D), low = new Float32Array(m);
    for (let i = 0; i < m; i++) low[i] = lp[i * D];
    return { mono: hp, low, D, srD: sr / D };
  }

  // ---------- YIN (returns several pitch candidates per frame) ----------
  function yinCands(x, start, W, tauMin, tauMax, d, cmnd) {
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const df = x[start + j] - x[start + j + tau]; sum += df * df; }
      d[tau] = sum;
    }
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cmnd[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let pick = -1; // classic YIN choice: first dip under the threshold
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < CFG.yinThresh) { while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; pick = t; break; }
    }
    const list = [];
    for (let t = tauMin + 1; t < tauMax; t++) {
      if (cmnd[t] <= CFG.yinVoicedMax && cmnd[t] <= cmnd[t - 1] && cmnd[t] < cmnd[t + 1]) list.push(t);
    }
    if (pick >= 0 && list.indexOf(pick) < 0) list.push(pick);
    list.sort((p, q) => cmnd[p] - cmnd[q]);
    return list.slice(0, 4).map(t => {
      let refined = t;
      if (t > 1 && t < tauMax) {
        const a = cmnd[t - 1], b = cmnd[t], c = cmnd[t + 1], den = a - 2 * b + c;
        if (Math.abs(den) > 1e-9) refined = t + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
      }
      return { tau: refined, aper: cmnd[t], cost: cmnd[t] - (t === pick ? 0.12 : 0) };
    });
  }

  // Viterbi over per-frame candidates (+ an "unvoiced" state) so the pitch path is continuous:
  // kills octave flips and one-frame glitches while still allowing real jumps and glides.
  function trackPath(cands, srD) {
    const n = cands.length, UNV = CFG.unvoicedCost, states = [], score = [], back = [];
    for (let f = 0; f < n; f++) {
      states[f] = cands[f].map(c => ({ m: 69 + 12 * Math.log2(srD / c.tau / 440), aper: c.aper, cost: c.cost }));
      states[f].push(null); // unvoiced
    }
    const jump = (a, b) => {
      const d = Math.abs(a - b);
      let c = Math.min(2, 0.12 * d);
      if (Math.abs(d - 12) < 0.7 || Math.abs(d - 24) < 0.7) c += 0.8; // octave leaps are usually errors
      return c;
    };
    for (let f = 0; f < n; f++) {
      score[f] = []; back[f] = [];
      states[f].forEach((st, si) => {
        const obs = st ? st.cost : UNV;
        if (f === 0) { score[f][si] = obs; back[f][si] = -1; return; }
        let best = 1e9, bi = 0;
        states[f - 1].forEach((pv, pi) => {
          let tr;
          if (!st && !pv) tr = 0; else if (!st || !pv) tr = CFG.voicingSwitchCost; else tr = jump(st.m, pv.m);
          const v = score[f - 1][pi] + tr;
          if (v < best) { best = v; bi = pi; }
        });
        score[f][si] = best + obs; back[f][si] = bi;
      });
    }
    let si = 0; score[n - 1].forEach((v, i) => { if (v < score[n - 1][si]) si = i; });
    const path = new Array(n);
    for (let f = n - 1; f >= 0; f--) { path[f] = states[f][si]; si = back[f][si]; }
    return path;
  }

  // ---------- pitch curve -> notes ----------
  // frames: [{t, m (midi float or NaN), c (0..1)}]
  // 1. find places where the pitch MOVES (4-frame displacement)
  // 2. a smooth move = glide (one start->end event, never extra notes), an abrupt one = jump (hammer/pull)
  // 3. the steady stretches between events are the notes' pitches
  function buildPieces(frames) {
    const n = frames.length;
    if (!n) return [];
    const m0 = frames.map(f => f.m);
    const ms = m0.map((v, i) => {
      if (isNaN(v)) return NaN;
      return median([m0[i - 1], v, m0[i + 1]].filter(q => q !== undefined && !isNaN(q)));
    });
    // `mi` bridges short unvoiced gaps (the tracker abstains while its window straddles a note change)
    // so a jump across a 1-4 frame gap is still seen; regions below use the real voiced values only.
    const mi = ms.slice();
    for (let i = 0; i < n;) {
      if (!isNaN(ms[i])) { i++; continue; }
      let j = i; while (j < n && isNaN(ms[j])) j++;
      if (i > 0 && j < n && j - i <= 4) for (let q = i; q < j; q++) mi[q] = ms[i - 1] + (ms[j] - ms[i - 1]) * (q - i + 1) / (j - i + 1);
      i = j;
    }
    const mv = new Array(n).fill(false);
    for (let i = 2; i < n - 2; i++) {
      const a = mi[i - 2], b = mi[i + 2];
      if (!isNaN(a) && !isNaN(b) && !isNaN(mi[i]) && Math.abs(b - a) >= CFG.moveSemis) mv[i] = true;
      if (i >= 4 && i < n - 4) { const a8 = mi[i - 4], b8 = mi[i + 4]; if (!isNaN(a8) && !isNaN(b8) && !isNaN(mi[i]) && Math.abs(b8 - a8) >= CFG.slowMoveSemis) mv[i] = true; }
    }
    const events = [];
    for (let i = 0; i < n;) {
      if (!mv[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && (mv[j + 1] || (j + 2 < n && mv[j + 2]))) j++;
      let a = Math.max(0, i - 2), b = Math.min(n - 1, j + 2);
      while (a > 0 && isNaN(mi[a])) a--;
      while (b < n - 1 && isNaN(mi[b])) b++;
      while (b > j && isNaN(mi[b])) b--;          // glide runs into the end of the note: use the last voiced frame
      i = j + 1;
      if (isNaN(mi[a]) || isNaN(mi[b])) continue;
      const net = mi[b] - mi[a];
      if (Math.abs(net) < CFG.glideMinSemis) continue;           // vibrato / wobble
      // Steps are measured between REAL voiced frames (ms), not the bridged values: a jump across a 3-frame gap
      // otherwise looks like four 1.3-semitone steps, i.e. neither a jump nor (with a small sag before it) a glide,
      // and the note before it vanished (F#1 -> B1 hammer-on merged into one B1).
      let last = mi[a], maxStep = 0, maxAt = a + 1, moving = 0, good = 0, tot = 0;
      for (let q = a + 1; q <= b; q++) {
        if (isNaN(ms[q])) continue;
        const st = ms[q] - last; last = ms[q];
        if (Math.abs(st) > maxStep) { maxStep = Math.abs(st); maxAt = q; }
        if (Math.abs(st) >= 0.12) { moving++; tot++; if (Math.sign(st) === Math.sign(net)) good++; }
      }
      const monotonic = tot === 0 || good / tot >= 0.7;
      const isJump = moving <= CFG.jumpMaxFrames || maxStep >= 0.7 * Math.abs(net);
      if (isJump) events.push({ type: 'jump', a: Math.max(0, maxAt - 1), b: maxAt, net });
      else if (monotonic) events.push({ type: 'glide', a, b, net });
    }
    // a glide that pauses briefly at each fret is still ONE slide: merge same-direction events
    // separated by a short steady stretch (needs at least one real glide among them)
    const mergedEvents = [];
    for (const ev of events) {
      const last = mergedEvents[mergedEvents.length - 1];
      if (last && Math.sign(ev.net) === Math.sign(last.net) && ev.a - last.b < CFG.holdFrames && (ev.type === 'glide' || last.type === 'glide')) {
        last.b = Math.max(last.b, ev.b); last.net += ev.net; last.type = 'glide';
      } else mergedEvents.push({ ...ev });
    }
    events.length = 0; events.push(...mergedEvents);
    // steady regions between events
    const regions = [];
    let rs = 0;
    const addRegion = (s0, e0) => {
      const vals = [], cs = [];
      for (let q = s0; q <= e0 && q < n; q++) if (!isNaN(ms[q])) { vals.push(ms[q]); cs.push(frames[q].c); }
      regions.push({ s: s0, e: e0, vals, cs, count: vals.length, pitch: vals.length ? median(vals) : NaN, between: [] });
    };
    events.forEach((ev, k) => {
      addRegion(rs, ev.a);
      rs = Math.max(ev.b, rs);
      regions[regions.length - 1].after = ev;
    });
    addRegion(rs, n - 1);
    // keep usable regions; remember which events lie between consecutive usable ones
    const usable = [];
    regions.forEach((r, k) => {
      const lastAfterGlide = k > 0 && k === regions.length - 1 && regions[k - 1].after && regions[k - 1].after.type === 'glide';
      const minC = lastAfterGlide ? 1 : (k === 0 || k === regions.length - 1) ? 2 : 3;
      if (r.count >= minC) usable.push({ r, evBefore: [] });
      else if (usable.length && r.after) usable[usable.length - 1].carry = (usable[usable.length - 1].carry || []).concat([r.after]);
    });
    // attach events between usable regions
    const evOf = [];
    let ei = 0;
    usable.forEach((u, k) => {
      const between = [];
      const idx = regions.indexOf(u.r);
      if (k > 0) {
        const prevIdx = regions.indexOf(usable[k - 1].r);
        for (let q = prevIdx; q < idx; q++) if (regions[q].after) between.push(regions[q].after);
      }
      evOf.push(between);
    });
    if (!usable.length) return [];

    const mkPiece = (R, startIdx) => ({
      startIdx, mf: R.pitch, slideToF: null, lastM: R.pitch, endIdx: R.e,
      conf: R.cs.slice(), frames: R.count, technique: null, slideEndIdx: null, lastCount: R.count
    });
    const pieces = [];
    let piece = mkPiece(usable[0].r, usable[0].r.s), prevR = usable[0].r;
    pieces.push(piece);
    for (let k = 1; k < usable.length; k++) {
      const R = usable[k].r, between = evOf[k];
      const delta = R.pitch - piece.lastM, ad = Math.abs(delta);
      const hasGlide = between.some(e => e.type === 'glide');
      if (ad < CFG.legatoMinSemis) { piece.endIdx = R.e; piece.conf.push(...R.cs); piece.lastCount = R.count; prevR = R; continue; }
      if (Math.abs(ad - 12) < 0.7 && R.count < 4) { prevR = R; continue; } // tiny octave glitch
      // the decaying tail of a note jumping exactly an octave UP is often the 2nd harmonic outlasting the fundamental
      // (a B1 ending as 'B2', a D2 as 'D3'). Flagged here; analyze() drops it unless the energy shows a real pluck.
      const octTail = k === usable.length - 1 && delta > 0 && Math.abs(ad - 12) < 0.7 && !between.some(e => e.type === 'glide');
      if (hasGlide && ad >= CFG.glideMinSemis) {
        const dir = Math.sign(delta);
        if (piece.slideToF === null) {
          piece.slideToF = R.pitch; piece.slideEndIdx = R.s; piece.lastM = R.pitch; piece.endIdx = R.e; piece.conf.push(...R.cs); piece.lastCount = R.count;
        } else if (dir === Math.sign(piece.slideToF - piece.mf) && piece.lastCount < CFG.holdFrames) {
          piece.slideToF = R.pitch; piece.slideEndIdx = R.s; piece.lastM = R.pitch; piece.endIdx = R.e; piece.lastCount = R.count; // glide continues
        } else { // landed, held, then slid again: a separate slide with no new attack
          const np = mkPiece(R, prevR.s); np.mf = piece.lastM; np.slideToF = R.pitch; np.slideEndIdx = R.s; np.technique = 'slide'; np.lastM = R.pitch;
          piece = np; pieces.push(piece);
        }
      } else {
        if (k === usable.length - 1 && R.count < 4) { prevR = R; continue; } // too short at the very end to trust (release artifacts)
        piece = mkPiece(R, between.length && between[0].type === 'jump' ? Math.max(prevR.e + 1, R.s - 1) : R.s);
        piece.technique = ad <= CFG.hammerMaxSemis ? 'legato' : null; if (octTail) piece.octaveTail = true; pieces.push(piece);
      }
      prevR = R;
    }
    // a glide that runs into the end of the note (no landing) is a slide-OUT; one that starts the note is a slide-IN
    pieces.forEach(q => { if (q.slideToF !== null && q.lastCount < 4) q.slideOut = q.slideToF > q.mf ? 'up' : 'down'; });
    const r0 = regions[0], fu = regions.indexOf(usable[0].r);
    if (fu === 1 && r0.count <= 2 && r0.after && r0.after.type === 'glide' && Math.abs(r0.after.net) >= 1.5 && (r0.after.b - r0.after.a) >= 5 && pieces.length) {
      pieces[0].slideIn = r0.after.net > 0 ? 'up' : 'down';     // 'up' = slides up into the note from below
    }
    // big, short excursions that snap back (kick/bleed) are not notes
    const span = q => q.endIdx - q.startIdx + 1;
    for (let k = 1; k < pieces.length - 1;) {
      const A0 = pieces[k - 1], B0 = pieces[k], C0 = pieces[k + 1];
      if (span(B0) <= 8 && B0.slideToF === null && B0.mf <= CFG.kickMaxMidi && A0.lastM - B0.mf > CFG.hammerMaxSemis && Math.abs(C0.mf - A0.lastM) < 1) {
        A0.endIdx = C0.endIdx; A0.conf.push(...B0.conf, ...C0.conf); A0.frames += B0.frames + C0.frames; A0.lastM = C0.lastM;
        pieces.splice(k, 2);
      } else k++;
    }
    if (pieces.length > 1) {
      const L0 = pieces[pieces.length - 1], P0 = pieces[pieces.length - 2];
      if (span(L0) <= 6 && L0.slideToF === null && L0.mf <= CFG.kickMaxMidi && P0.lastM - L0.mf > CFG.hammerMaxSemis + 2 && span(P0) >= 8) pieces.pop();
    }
    return pieces;
  }

  // ---------- vibrato ----------
  // pitch wobbles regularly (3.5-9.5 Hz) by at least ~30 cents peak-to-peak around a steady pitch
  function detectVibrato(vals, frameRate) {
    const v = vals.filter(q => !isNaN(q));
    if (v.length < 26 || v.length < 0.8 * vals.length) return false;
    const W = Math.max(5, Math.round(frameRate / 5.5)), r = [];
    for (let i = 0; i < v.length; i++) {
      let a = Math.max(0, i - (W >> 1)), b = Math.min(v.length, i + (W >> 1) + 1), s = 0;
      for (let q = a; q < b; q++) s += v[q];
      r.push(v[i] - s / (b - a));
    }
    const core = r.slice(W >> 1, r.length - (W >> 1));
    if (core.length < 12) return false;
    const sorted = core.slice().sort((x, y) => x - y), p2p = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
    if (p2p < CFG.vibratoMinSemis) return false;
    const cross = []; let sign = 0;
    core.forEach((x, i) => { if (Math.abs(x) < 0.05) return; const sg = x > 0 ? 1 : -1; if (sign && sg !== sign) cross.push(i); sign = sg; });
    if (cross.length < 6) return false;
    const halves = []; for (let i = 1; i < cross.length; i++) halves.push(cross[i] - cross[i - 1]);
    const mean = halves.reduce((a, b) => a + b, 0) / halves.length, rate = frameRate / (2 * mean);
    const sd = Math.sqrt(halves.reduce((a, b) => a + (b - mean) * (b - mean), 0) / halves.length);
    return rate >= 3.5 && rate <= 9.5 && sd / mean < 0.5;
  }

  // ---------- main analysis ----------
  async function analyze(channels, sr, opts) {
    opts = opts || {};
    const progress = opts.onProgress || (() => {});
    const P = prepare(channels, sr), x = P.low, srD = P.srD, HOP = CFG.hop, WIN = CFG.envWin, W = CFG.yinWin;
    const tauMin = Math.floor(srD / CFG.maxHz), tauMax = Math.ceil(srD / CFG.minHz);
    const nb = Math.floor((x.length - WIN) / HOP) + 1;
    if (nb < 8) throw new Error('This WAV is too short to estimate bass notes.');

    // envelope in dB
    const eb = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0; const st = b * HOP;
      for (let j = 0; j < WIN; j++) { const v = x[st + j]; s += v * v; }
      eb[b] = 20 * Math.log10(Math.sqrt(s / WIN) + 1e-9);
    }
    const sorted = Array.from(eb).sort((a, b) => a - b);
    const peakDb = sorted[Math.floor(sorted.length * 0.97)];
    const floorDb = Math.max(peakDb - CFG.silenceRelDb, -62);
    if (peakDb < -55) throw new Error('This file looks silent.');

    // slap/pop + ghost-note feature signal: full band high-passed at 1.5 kHz
    const hi = biquad(P.mono, sr, 'highpass', 1500);
    // high-band click strength per block: a ghost (muted) note over a ringing note barely raises the bass energy but
    // makes a clear string/finger click above 1.5 kHz
    const hdb = new Float32Array(nb), hRise = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const s0 = Math.floor(b * HOP * P.D), s1 = Math.min(hi.length, s0 + Math.floor(WIN * P.D)); let e = 0;
      for (let i = s0; i < s1; i++) e += hi[i] * hi[i];
      hdb[b] = 10 * Math.log10(e / Math.max(1, s1 - s0) + 1e-12);
    }
    for (let b = 6; b < nb; b++) {
      let lo = 1e9, top = -1e9;
      for (let k = 1; k <= 6; k++) lo = Math.min(lo, hdb[b - k]);
      for (let k = 0; k <= 2 && b + k < nb; k++) top = Math.max(top, hdb[b + k]);
      hRise[b] = top - lo;
    }
    // onsets
    const od = new Float32Array(nb);
    // od = rise over the last 2 blocks (sharp, gives the attack time). odL = rise over ~onsetLookMs, used only for the
    // size test: browsers decode at the device rate (often 48 kHz), which makes blocks shorter and spreads an attack over
    // more of them, so a real 7 dB pluck could show only 4.9 dB in 2 blocks (a missed open E in Play That Funky Music).
    const lookB = Math.max(2, Math.round(CFG.onsetLookMs / 1000 * srD / HOP));
    const odL = new Float32Array(nb);
    for (let b = 2; b < nb; b++) {
      od[b] = Math.max(0, eb[b] - Math.min(eb[b - 1], eb[b - 2]));
      let lo = eb[b - 1]; for (let k = 2; k <= lookB && b - k >= 0; k++) lo = Math.min(lo, eb[b - k]);
      odL[b] = Math.max(0, eb[b] - lo);
    }
    const gapB = Math.round(CFG.onsetGapMs / 1000 * srD / HOP);
    let onsets = [];
    for (let b = 2; b < nb; b++) {
      if (od[b] < CFG.onsetDb && !(od[b] >= CFG.onsetDb * 0.6 && Math.max(odL[b], b + 1 < nb ? odL[b + 1] : 0) >= CFG.onsetDb)) continue;
      // Loudness gate on the note BODY, not on the block that holds the energy jump. A note that starts
      // from digital silence (common in separated stems) has its biggest jump while still quiet, so gating
      // on that block threw the note away entirely.
      let body = eb[b]; for (let k = 1; k <= 3 && b + k < nb; k++) body = Math.max(body, eb[b + k]);
      if (body < floorDb) continue;
      let isMax = true;
      for (let k = -3; k <= 3 && isMax; k++) {
        if (!k || b + k < 0 || b + k >= nb) continue;
        if (k < 0 ? od[b + k] >= od[b] : od[b + k] > od[b]) isMax = false;
      }
      if (!isMax) continue;
      const last = onsets[onsets.length - 1];
      if (last && b - last.b < gapB) { if (od[b] > last.od) onsets[onsets.length - 1] = { b, od: od[b] }; continue; }
      onsets.push({ b, od: od[b] });
    }
    let ghostCands = [];
    // ghost notes over a ringing note: a ringing note only decays, so a >= ghostRiseDb rise while it is still loud and
    // well past its attack means the string was touched again (a muted ghost note). Too small for the normal onset test.
    {
      const sortedOn = onsets.map(o => o.b), add = [];
      for (let b = 3; b < nb - 3; b++) {
        if (odL[b] < CFG.ghostRiseDb || eb[b] < peakDb - CFG.ghostMaxBelowDb) continue;
        let isMax = true; for (let k = -3; k <= 3; k++) if (k && odL[b + k] > odL[b]) isMax = false;
        if (!isMax) continue;
        let prevO = -1e9, nextO = 1e9; sortedOn.forEach(ob => { if (ob <= b) prevO = Math.max(prevO, ob); else nextO = Math.min(nextO, ob); });
        if ((b - prevO) * HOP / srD > CFG.ghostMinAgeMs / 1000 && (nextO - b) * HOP / srD > 0.06) {
          // dip = how far the energy fell just before the bump (finger meeting the string); hold = level ~150 ms later
          let dip = 1e9, pk = -1e9; for (let k = 1; k <= 5; k++) dip = Math.min(dip, eb[b - k]); for (let k = 0; k <= 3 && b + k < nb; k++) pk = Math.max(pk, eb[b + k]);
          const hb = Math.min(nb - 3, b + Math.round(0.15 * srD / HOP)); let hold = -1e9; for (let q = 0; q < 3; q++) hold = Math.max(hold, eb[hb + q]);
          add.push({ b, dip: eb[Math.max(0, b - 8)] - dip, hold: hold - pk });
        }
      }
      // pluck clicks: a string re-plucked while it rings barely moves the bass energy but clicks above 1.5 kHz
      for (let b = 6; b < nb - 3; b++) {
        if (hRise[b] < CFG.repluckClickDb || eb[b] < peakDb - CFG.ghostMaxBelowDb) continue;
        let isMax = true; for (let k = -4; k <= 4; k++) if (k && hRise[b + k] > hRise[b]) isMax = false;
        if (!isMax) continue;
        const near = add.find(c => Math.abs(c.b - b) <= 4);
        let pk = -1e9; for (let k = 0; k <= 3 && b + k < nb; k++) pk = Math.max(pk, eb[b + k]);
        const hb = Math.min(nb - 3, b + Math.round(0.15 * srD / HOP)); let hold = -1e9; for (let q = 0; q < 3; q++) hold = Math.max(hold, eb[hb + q]);
        if (near) near.click = true; else add.push({ b, dip: 0, hold: hold - pk, click: true });
      }
      ghostCands = add;
    }
    let b0 = 0; while (b0 < nb && eb[b0] < floorDb) b0++;
    if (b0 < nb - 8 && eb[b0] >= peakDb - 12 && (!onsets.length || onsets[0].b > b0 + 8)) onsets.unshift({ b: b0, od: 0 });
    if (!onsets.length) throw new Error('No note attacks found. Try a cleaner isolated bass WAV.');

    const D = P.D;
    function attackFeatures(sampleD, fromSilence) {
      // A note that begins from digital silence carries a one-sample click (an artefact of stem separation,
      // not of playing technique) that reads as slap brightness, so skip the first 3 ms in that case only.
      const s0 = Math.max(0, Math.floor(fromSilence ? sampleD * D + 0.003 * sr : (sampleD - 8) * D)), s1 = Math.min(P.mono.length, s0 + Math.floor(0.03 * sr));
      let full = 0, high = 0, peak = 0;
      for (let i = s0; i < s1; i++) { const v = P.mono[i]; full += v * v; high += hi[i] * hi[i]; if (Math.abs(v) > peak) peak = Math.abs(v); }
      const n = Math.max(1, s1 - s0), rms = Math.sqrt(full / n);
      return { bright: full > 0 ? Math.sqrt(high / full) : 0, crest: rms > 0 ? peak / rms : 0 };
    }

    const FW = 128, FH = 32, fnb = Math.max(0, Math.floor((x.length - FW) / FH)), fdb = new Float32Array(fnb);
    for (let b = 0; b < fnb; b++) { let sq = 0; for (let j = 0; j < FW; j++) { const v = x[b * FH + j]; sq += v * v; } fdb[b] = 20 * Math.log10(Math.sqrt(sq / FW) + 1e-9); }
    function energyRise(t) { // biggest short-term energy increase within +-35 ms of t (dB)
      const c = Math.round(t * srD / FH), r = Math.round(0.035 * srD / FH);
      let best = -99;
      for (let b = Math.max(5, c - r); b < Math.min(fnb, c + r); b++) { let base = 1e9; for (let k = 1; k <= 5; k++) base = Math.min(base, fdb[b - k]); best = Math.max(best, fdb[b] - base); }
      return best;
    }
    const d = new Float32Array(tauMax + 2), cmnd = new Float32Array(tauMax + 2);
    const notes = [], silRms = Math.pow(10, floorDb / 20) * 0.5;
    const frameSec = f => (f * HOP + W / 2) / srD;

    function pitchFrames(fA, fB, limitSample, minRms) {
      const meta = [], cands = [];
      for (let f = fA; f <= fB; f++) {
        const start = f * HOP, avail = limitSample - start - W, cap = Math.min(tauMax, avail);
        if (cap < tauMin + 12 || start + W + cap >= x.length) continue;
        let s = 0; for (let j = 0; j < W; j++) s += x[start + j] * x[start + j];
        meta.push({ t: frameSec(f) });
        cands.push(Math.sqrt(s / W) < Math.max(silRms, minRms || 0) ? [] : yinCands(x, start, W, tauMin, cap, d, cmnd));
      }
      if (!meta.length) return [];
      const path = trackPath(cands, srD);
      return meta.map((mt, i) => {
        const st = path[i];
        const ok = st && st.m >= CFG.minMidi - 0.5 && st.m <= CFG.maxMidi + 0.5;
        return { t: mt.t, m: ok ? st.m : NaN, c: ok ? Math.max(0, Math.min(1, 1 - st.aper)) : 0 };
      });
    }

    for (let i = 0; i < onsets.length; i++) {
      const on = onsets[i], bS = on.b, nextB = i + 1 < onsets.length ? onsets[i + 1].b : nb;
      let segPeak = -1e9;
      for (let b = bS; b < Math.min(nextB, bS + 6); b++) segPeak = Math.max(segPeak, eb[b]);
      let endB = nextB;
      for (let b = bS + 4; b < nextB; b++) if (eb[b] < segPeak - 30 || eb[b] < floorDb) { endB = b; break; }
      const L = endB - bS, onsetSample = bS * HOP + 64, tOn = onsetSample / srD;
      const feat = attackFeatures(onsetSample, eb[Math.max(0, bS - 2)] < -90);

      const tailRms = Math.pow(10, (segPeak - CFG.tailDb) / 20) * 0.7;
      let fr = L >= 5 ? pitchFrames(bS + 2, endB - 4, endB * HOP + 32, tailRms) : [];
      let voiced = fr.filter(q => !isNaN(q.m)).length;
      if (voiced < 1 && L >= 4) { // short note: allow window to overlap into the next one
        fr = pitchFrames(bS + 2, Math.max(bS + 2, endB - 1), Math.min(x.length, nextB * HOP + 192), tailRms);
        voiced = fr.filter(q => !isNaN(q.m)).length;
      }
      if (voiced < 1) {
        const ms = L * HOP / srD * 1000;
        if ((ms <= CFG.muteMaxMs && on.od >= 8 && segPeak >= peakDb - CFG.muteMinRelDb)) notes.push({ time: tOn, mf: NaN, midi: null, dur: Math.max(0.05, Math.min(L * HOP / srD, CFG.muteMaxMs / 1000)), confidence: 0.45, technique: 'muted', mute: true, feat });
        if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); }
        continue;
      }
      const vv = fr.filter(q => !isNaN(q.m)).map(q => q.m);
      if (vv.length >= 2 && vv.length <= 10 && median(vv.slice(0, 2)) - median(vv.slice(-2)) >= 1.5) { if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); } continue; } // kick-like thump
      const before = notes.length;
      const pieces = buildPieces(fr);
      pieces.forEach((p, k) => {
        const isFirst = k === 0, time = isFirst ? tOn : Math.max(tOn, fr[p.startIdx].t - W / 2 / srD * 0.5);
        const endT = p.slideEndIdx !== null ? fr[p.slideEndIdx].t : Math.max(fr[p.endIdx].t, time + 0.05);
        const lenF = Math.min(1, p.frames / 4);
        const conf = (p.conf.reduce((a, b) => a + b, 0) / p.conf.length) * (0.55 + 0.45 * lenF);
        const note = { level: segPeak - peakDb, time, mf: p.mf, midi: null, dur: Math.max(0.05, endT - time), confidence: Math.min(0.99, conf), technique: p.technique, feat: isFirst ? feat : null };
        if (!isFirst && p.technique === 'legato') { note.rise = energyRise(time); if (note.rise >= CFG.legatoMaxRiseDb) note.technique = null; }
        if (p.octaveTail && k > 0 && energyRise(time) < CFG.legatoMaxRiseDb) { // octave-up tail with no pluck (measured: tails 1.7-2.5 dB, real plucks 14-19 dB)
          const prev = notes[notes.length - 1]; if (prev && prev.time < time) prev.dur = Math.max(prev.dur, endT - prev.time);
          return;
        }
        if (note.dur < 0.12 && note.level < -CFG.quietBlipDb && p.slideToF === null) return; // very short AND very quiet: bleed, not a played note
        if (p.frames < CFG.minNoteFrames && conf < 0.8 && p.slideToF === null && !p.technique) return; // 2-3 frames of shaky pitch: noise, not a note
        if (p.slideToF !== null) { note.slideToF = p.slideToF; note.dur = Math.max(0.15, note.dur); note.technique = 'slide'; if (p.slideOut) note.slideOut = p.slideOut; }
        if (p.slideIn) note.slideIn = p.slideIn;
        if (p.slideToF === null && detectVibrato(fr.slice(p.startIdx, p.endIdx + 1).map(q => q.m), srD / HOP)) note.vibrato = true;
        notes.push(note);
      });
      // a loud, short hit whose pitch never settled (1-2 frames) gave no note at all: it is a dead note, not nothing
      const ms_ = L * HOP / srD * 1000;
      // ...also when it lands on a note that is still ringing (then the segment runs on with the old note's tail)
      const ringing = eb[Math.max(0, bS - 2)] > peakDb - CFG.ghostMaxBelowDb;
      if (notes.length === before && segPeak >= peakDb - CFG.muteMinRelDb && ((ms_ <= CFG.muteMaxMs && on.od >= 8) || ringing))
        notes.push({ time: tOn, mf: NaN, midi: null, dur: Math.max(0.05, Math.min(L * HOP / srD, CFG.muteMaxMs / 1000)), confidence: 0.4, technique: 'muted', mute: true, feat });
      if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); }
    }

    // ghost notes: only INSIDE a pitched note that keeps its pitch (no note starts nearby) and with a real energy
    // bump (measured: the owner's ghosts 5.2-5.6 dB; sidechain/beating swells in realistic.js 2.1-4.3 dB)
    ghostCands.forEach(({ b, dip, hold, click }) => {
      const tC = (b * HOP + 64) / srD;
      if (notes.some(n => Math.abs(n.time - tC) < 0.08)) return;
      const host = notes.find(n => !n.mute && tC > n.time + CFG.ghostMinAgeMs / 1000 && tC < n.time + n.dur + 0.03);
      if (!host || host.slideToF != null) return;
      // same-note RE-PLUCK: the finger stops the string (a dip), plucks again, and the note rings on at full level.
      // A ghost note instead dies away (measured: owner's ghost fell 49 dB in 150 ms; Come Together re-plucks held within 2 dB)
      if ((dip >= CFG.repluckDipDb || click) && hold >= -CFG.repluckHoldDb) {
        const end = host.time + host.dur; host.dur = Math.max(0.05, tC - host.time);
        notes.push({ ...host, time: tC, dur: Math.max(0.05, end - tC), technique: null, feat: null, slideIn: undefined, repluck: true });
        return;
      }
      if (energyRise(tC) < CFG.ghostEnergyDb) return;
      host.dur = Math.max(0.05, tC - host.time);
      notes.push({ time: tC, mf: NaN, midi: null, dur: 0.08, confidence: 0.4, technique: 'muted', mute: true, ghost: true, feat: null });
    });
    notes.sort((p, q) => p.time - q.time);

    // global tuning offset (bass a little sharp/flat of A=440)
    const pitched = notes.filter(n => !n.mute && !isNaN(n.mf));
    let tune = 0;
    if (pitched.length >= 8) {
      const offs = pitched.map(n => n.mf - Math.round(n.mf));
      const md = median(offs);
      if (Math.abs(md) > 0.08) tune = md;
    }
    pitched.forEach(n => { n.midi = Math.round(n.mf - tune); if (n.slideToF != null) { const end = Math.round(n.slideToF - tune); if (n.slideOut) n.slideEnd = end; else n.slideTo = end; } });

    // octave-glitch repair: a lone note exactly an octave away from two agreeing neighbours
    const real = notes.filter(n => !n.mute && n.midi != null);
    for (let i = 1; i < real.length - 1; i++) {
      const a = real[i - 1].midi, b = real[i + 1].midi, n = real[i];
      if (Math.abs(a - b) <= 3) {
        const ref = (a + b) / 2, diff = n.midi - ref;
        if (Math.abs(Math.abs(diff) - 12) <= 1.5 && n.confidence < 0.6) { n.midi -= 12 * Math.sign(diff); n.confidence *= 0.8; n.octaveFixed = true; if (n.slideTo != null) n.slideTo -= 12 * Math.sign(diff); }
      }
    }
    const kept = notes.filter(n => n.mute || (n.midi >= CFG.minMidi && n.midi <= CFG.maxMidi));

    // slap / pop: bright attack
    kept.forEach(n => {
      if (!n.mute && n.feat && n.feat.bright > CFG.slapBright && n.technique !== 'legato') n.technique = n.technique === 'slide' ? 'slide' : 'slap';
      if (!n.mute && n.feat && n.feat.bright > CFG.slapBright) n.slap = true;
    });
    kept.sort((a, b) => a.time - b.time);
    for (let k = kept.length - 2; k >= 0; k--) if (kept[k].mute && !kept[k + 1].mute && kept[k + 1].time - kept[k].time < CFG.muteBeforeNoteMs / 1000) kept.splice(k, 1);
    // muted notes inherit the previous pitch so they sit on a sensible string
    let prev = 40;
    kept.forEach(n => { if (n.mute) n.midi = prev; else prev = n.midi; });

    progress(100);
    return { notes: kept, debug: { peakDb, floorDb, onsets: onsets.length, tuneOffset: tune, srD } };
  }

  const api = { CFG, analyze, buildPieces, prepare, median, detectVibrato };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LowlineAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
