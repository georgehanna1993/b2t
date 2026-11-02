/* Lowline analysis engine
 *
 * Pipeline:
 *   1. prepare      mono mix, band-limit to the bass range, decimate (~11 kHz)
 *   2. onsets       log-energy envelope -> note attacks (so repeated notes stay separate)
 *   3. per note     YIN pitch tracking AFTER the attack, then split into
 *                   plateaus -> slide (gradual glide) / legato (instant jump)
 *   4. techniques   slap (bright attack), muted (transient with no pitch)
 *   5. cleanup      global tuning offset, octave-glitch repair
 *   6. assignFrets  Viterbi search for the most playable string/fret path
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
    silenceRelDb: 36,    // anything this far below the loud notes is silence (hum, hiss, tails)
    runTol: 0.55,        // semitones: frame belongs to the current pitch plateau
    stableSpread: 0.35,  // semitones: 3 frames this tight form a new plateau
    slideMinSemis: 1.2,
    slideMinFrames: 3,   // transition lasting this many frames (~35 ms+) is a slide, shorter is legato
    legatoMinSemis: 0.7,
    moveSemis: 0.45,     // pitch moved this much across 4 frames -> candidate glide/jump
    glideMinSemis: 1.0,  // net change needed to call it a glide or jump (vibrato stays below this)
    jumpMaxFrames: 5,    // a pitch change spread over <= this many frames (~58 ms) is a jump, longer is a glide
    hammerMaxSemis: 5,   // bigger leaps without a new attack are re-plucks, not hammer-ons/pull-offs
    kickMaxMidi: 35,     // kick-drum bleed lives down here (< ~62 Hz) and snaps back up
    tailDb: 24,          // frames this far under the note's peak are ignored (decaying tail, hum)
    holdFrames: 6,       // landing held this long -> a following glide is a new slide
    slapBright: 0.15,    // fraction of attack energy above 1.5 kHz that suggests slap/pop
    muteMaxMs: 170,
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
    }
    const events = [];
    for (let i = 0; i < n;) {
      if (!mv[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && (mv[j + 1] || (j + 2 < n && mv[j + 2]))) j++;
      let a = Math.max(0, i - 2), b = Math.min(n - 1, j + 2);
      while (a > 0 && isNaN(mi[a])) a--;
      while (b < n - 1 && isNaN(mi[b])) b++;
      i = j + 1;
      if (isNaN(mi[a]) || isNaN(mi[b])) continue;
      const net = mi[b] - mi[a];
      if (Math.abs(net) < CFG.glideMinSemis) continue;           // vibrato / wobble
      let last = mi[a], maxStep = 0, maxAt = a + 1, moving = 0, good = 0, tot = 0;
      for (let q = a + 1; q <= b; q++) {
        if (isNaN(mi[q])) continue;
        const st = mi[q] - last; last = mi[q];
        if (Math.abs(st) > maxStep) { maxStep = Math.abs(st); maxAt = q; }
        if (Math.abs(st) >= 0.12) { moving++; tot++; if (Math.sign(st) === Math.sign(net)) good++; }
      }
      const monotonic = tot === 0 || good / tot >= 0.7;
      const isJump = moving <= CFG.jumpMaxFrames || maxStep >= 0.7 * Math.abs(net);
      if (isJump) events.push({ type: 'jump', a: Math.max(0, maxAt - 1), b: maxAt, net });
      else if (monotonic) events.push({ type: 'glide', a, b, net });
    }
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
      const minC = (k === 0 || k === regions.length - 1) ? 2 : 3;
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
        piece.technique = ad <= CFG.hammerMaxSemis ? 'legato' : null; pieces.push(piece);
      }
      prevR = R;
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

    // onsets
    const od = new Float32Array(nb);
    for (let b = 2; b < nb; b++) od[b] = Math.max(0, eb[b] - Math.min(eb[b - 1], eb[b - 2]));
    const gapB = Math.round(CFG.onsetGapMs / 1000 * srD / HOP);
    let onsets = [];
    for (let b = 2; b < nb; b++) {
      if (od[b] < CFG.onsetDb || eb[b] < floorDb) continue;
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
    let b0 = 0; while (b0 < nb && eb[b0] < floorDb) b0++;
    if (b0 < nb - 8 && eb[b0] >= peakDb - 12 && (!onsets.length || onsets[0].b > b0 + 8)) onsets.unshift({ b: b0, od: 0 });
    if (!onsets.length) throw new Error('No note attacks found. Try a cleaner isolated bass WAV.');

    // slap/pop feature signal: full band high-passed at 1.5 kHz
    const hi = biquad(P.mono, sr, 'highpass', 1500);
    const D = P.D;
    function attackFeatures(sampleD) {
      const s0 = Math.max(0, Math.floor((sampleD - 8) * D)), s1 = Math.min(P.mono.length, s0 + Math.floor(0.03 * sr));
      let full = 0, high = 0, peak = 0;
      for (let i = s0; i < s1; i++) { const v = P.mono[i]; full += v * v; high += hi[i] * hi[i]; if (Math.abs(v) > peak) peak = Math.abs(v); }
      const n = Math.max(1, s1 - s0), rms = Math.sqrt(full / n);
      return { bright: full > 0 ? Math.sqrt(high / full) : 0, crest: rms > 0 ? peak / rms : 0 };
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
      const feat = attackFeatures(onsetSample);

      const tailRms = Math.pow(10, (segPeak - CFG.tailDb) / 20) * 0.7;
      let fr = L >= 5 ? pitchFrames(bS + 2, endB - 4, endB * HOP + 32, tailRms) : [];
      let voiced = fr.filter(q => !isNaN(q.m)).length;
      if (voiced < 1 && L >= 4) { // short note: allow window to overlap into the next one
        fr = pitchFrames(bS + 2, Math.max(bS + 2, endB - 1), Math.min(x.length, nextB * HOP + 192), tailRms);
        voiced = fr.filter(q => !isNaN(q.m)).length;
      }
      if (voiced < 1) {
        const ms = L * HOP / srD * 1000;
        if (ms <= CFG.muteMaxMs && on.od >= 8) notes.push({ time: tOn, mf: NaN, midi: null, dur: Math.max(0.05, L * HOP / srD), confidence: 0.45, technique: 'muted', mute: true, feat });
        if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); }
        continue;
      }
      const vv = fr.filter(q => !isNaN(q.m)).map(q => q.m);
      if (vv.length >= 2 && vv.length <= 10 && median(vv.slice(0, 2)) - median(vv.slice(-2)) >= 1.5) { if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); } continue; } // kick-like thump
      const pieces = buildPieces(fr);
      pieces.forEach((p, k) => {
        const isFirst = k === 0, time = isFirst ? tOn : Math.max(tOn, fr[p.startIdx].t - W / 2 / srD * 0.5);
        const endT = p.slideEndIdx !== null ? fr[p.slideEndIdx].t : Math.max(fr[p.endIdx].t, time + 0.05);
        const lenF = Math.min(1, p.frames / 4);
        const conf = (p.conf.reduce((a, b) => a + b, 0) / p.conf.length) * (0.55 + 0.45 * lenF);
        const note = { time, mf: p.mf, midi: null, dur: Math.max(0.05, endT - time), confidence: Math.min(0.99, conf), technique: p.technique, feat: isFirst ? feat : null };
        if (p.slideToF !== null) { note.slideToF = p.slideToF; note.dur = Math.max(0.15, note.dur); note.technique = 'slide'; }
        notes.push(note);
      });
      if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); }
    }

    // global tuning offset (bass a little sharp/flat of A=440)
    const pitched = notes.filter(n => !n.mute && !isNaN(n.mf));
    let tune = 0;
    if (pitched.length >= 8) {
      const offs = pitched.map(n => n.mf - Math.round(n.mf));
      const md = median(offs);
      if (Math.abs(md) > 0.08) tune = md;
    }
    pitched.forEach(n => { n.midi = Math.round(n.mf - tune); if (n.slideToF != null) n.slideTo = Math.round(n.slideToF - tune); });

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
    // muted notes inherit the previous pitch so they sit on a sensible string
    let prev = 40;
    kept.sort((a, b) => a.time - b.time);
    kept.forEach(n => { if (n.mute) n.midi = prev; else prev = n.midi; });

    progress(100);
    return { notes: kept, debug: { peakDb, floorDb, onsets: onsets.length, tuneOffset: tune, srD } };
  }

  // ---------- fretting (Viterbi over string/fret + hand position) ----------
  // State = (string, fret, handPos). Open strings don't move the hand, so the hand
  // position carries over; fretted notes within a ~4-fret span are nearly free.
  function assignFrets(notes, openMidis, maxFret) {
    maxFret = maxFret == null ? 22 : maxFret;
    notes.forEach(n => { n.string = null; n.fret = null; n.unplayable = false; });
    const cands = notes.map(n => {
      const out = [];
      openMidis.forEach((open, s) => {
        const f = n.midi - open;
        if (f < 0 || f > maxFret) return;
        let endF = f;
        if (n.slideTo != null) { endF = n.slideTo - open; if (endF < 0 || endF > maxFret) return; }
        out.push({ s, f, endF });
      });
      return out;
    });
    const idx = [];
    notes.forEach((n, i) => { if (!n.mute && cands[i].length) idx.push(i); });
    const inDP = new Set(idx), layers = [];
    idx.forEach((i, k) => {
      const states = new Map();
      cands[i].forEach(c => {
        const own = 0.03 * c.f + (c.f === 0 ? -0.1 : 0) + (n_isSlide(notes[i]) ? 0.02 * Math.max(c.f, c.endF) : 0);
        if (k === 0) {
          const pos = c.endF > 0 ? c.endF : (c.f > 0 ? c.f : 2);
          const key = c.s * 100 + pos;
          if (!states.has(key) || own < states.get(key).score) states.set(key, { c, pos, score: own, back: null });
          return;
        }
        layers[k - 1].forEach(prev => {
          let cost = own + 0.3 * Math.abs(c.s - prev.c.s), pos = prev.pos;
          if (c.f > 0) {
            const dist = Math.abs(c.f - prev.pos);
            cost += Math.max(0, dist - 3) * 0.8 + dist * 0.05;
          } else cost += 0.1;
          if (c.endF > 0) pos = c.endF; else if (c.f > 0) pos = c.f;
          const key = c.s * 100 + pos, sc = prev.score + cost;
          if (!states.has(key) || sc < states.get(key).score) states.set(key, { c, pos, score: sc, back: prev });
        });
      });
      layers.push(Array.from(states.values()));
    });
    if (layers.length) {
      let cur = layers[layers.length - 1].reduce((a, b) => (b.score < a.score ? b : a));
      for (let k = layers.length - 1; k >= 0; k--) { notes[idx[k]].string = cur.c.s; notes[idx[k]].fret = cur.c.f; cur = cur.back; }
    }
    let last = { s: 0, f: 0 };
    notes.forEach((n, i) => {
      if (inDP.has(i)) { last = { s: n.string, f: n.fret }; return; }
      if (n.mute) { n.string = last.s; n.fret = last.f; return; }
      const alt = openMidis.map((o, s) => ({ s, f: n.midi - o })).filter(c => c.f >= 0 && c.f <= 24).sort((a, b) => a.f - b.f)[0];
      n.string = alt ? alt.s : 0; n.fret = alt ? alt.f : 0; n.unplayable = !alt;
    });
    return notes;
  }
  function n_isSlide(n) { return n.slideTo != null; }

  const api = { CFG, analyze, assignFrets, buildPieces, prepare, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LowlineAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
