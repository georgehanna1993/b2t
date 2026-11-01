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
    slapBright: 0.15,    // fraction of attack energy above 1.5 kHz that suggests slap/pop
    muteMaxMs: 170,
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

  // ---------- YIN ----------
  function yin(x, start, W, tauMin, tauMax, d, cmnd) {
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const df = x[start + j] - x[start + j + tau]; sum += df * df; }
      d[tau] = sum;
    }
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cmnd[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < CFG.yinThresh) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] > CFG.yinVoicedMax) return null;
      tau = best;
    }
    let refined = tau;
    if (tau > 1 && tau < tauMax) {
      const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1], den = a - 2 * b + c;
      if (Math.abs(den) > 1e-9) refined = tau + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    return { tau: refined, aper: cmnd[tau] };
  }

  // ---------- pitch plateaus -> notes ----------
  // frames: [{t, m (midi float or NaN), c (0..1)}]
  function buildPieces(frames) {
    const TOL = CFG.runTol, runs = [];
    let cur = null, pend = [];
    for (let i = 0; i < frames.length; i++) {
      const v = frames[i].m;
      if (isNaN(v)) continue;
      if (!cur) { cur = { start: i, end: i, vals: [v], cs: [frames[i].c], trans: [] }; continue; }
      const ref = median(cur.vals.slice(-5));
      if (Math.abs(v - ref) <= TOL) { cur.vals.push(v); cur.cs.push(frames[i].c); cur.end = i; pend = []; continue; }
      pend.push({ i, v, c: frames[i].c });
      if (pend.length >= 3) {
        const tail = pend.slice(-3), vs = tail.map(x => x.v);
        const spread = Math.max(...vs) - Math.min(...vs);
        if (spread <= CFG.stableSpread && tail[2].i - tail[0].i <= 5) {
          const trans = pend.slice(0, pend.length - 3);
          runs.push(cur);
          cur = { start: tail[0].i, end: tail[2].i, vals: vs, cs: tail.map(x => x.c), trans };
          pend = [];
        } else if (pend.length > 30) {
          runs.push(cur);
          cur = { start: tail[0].i, end: tail[2].i, vals: vs, cs: tail.map(x => x.c), trans: [] };
          pend = [];
        }
      }
    }
    if (cur) runs.push(cur);
    if (!runs.length) return [];

    const pieces = [];
    const mkPiece = (r, startIdx) => ({
      startIdx, mf: median(r.vals), slideToF: null, lastM: median(r.vals),
      endIdx: r.end, conf: r.cs.slice(), frames: r.vals.length, technique: null, slideEndIdx: null
    });
    let piece = mkPiece(runs[0], runs[0].start), prevEnd = runs[0].end;
    pieces.push(piece);
    for (let k = 1; k < runs.length; k++) {
      const r = runs[k], m = median(r.vals), delta = m - piece.lastM, ad = Math.abs(delta);
      if (ad < CFG.legatoMinSemis) {
        piece.endIdx = r.end; piece.conf.push(...r.cs); prevEnd = r.end; continue;
      }
      if (Math.abs(ad - 12) < 0.6 && r.vals.length < 4) { prevEnd = r.end; continue; } // octave glitch
      const transLen = r.start - prevEnd - 1, sgn = Math.sign(delta);
      let good = 0, tot = 0;
      for (let q = 1; q < r.trans.length; q++) { tot++; if (Math.sign(r.trans[q].v - r.trans[q - 1].v) === sgn) good++; }
      const monotonic = tot === 0 || good / tot >= 0.6;
      if (transLen >= CFG.slideMinFrames && ad >= CFG.slideMinSemis && monotonic && piece.slideToF === null) {
        piece.slideToF = m; piece.lastM = m; piece.endIdx = r.end; piece.slideEndIdx = r.start; piece.conf.push(...r.cs);
      } else {
        const startIdx = r.trans.length ? r.trans[0].i : r.start;
        piece = mkPiece(r, startIdx); piece.technique = 'legato'; pieces.push(piece);
      }
      prevEnd = r.end;
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
    if (b0 < nb - 8 && eb[b0] >= peakDb - 20 && (!onsets.length || onsets[0].b > b0 + 8)) onsets.unshift({ b: b0, od: 0 });
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

    function pitchFrames(fA, fB, limitSample) {
      const out = [];
      for (let f = fA; f <= fB; f++) {
        const start = f * HOP, avail = limitSample - start - W, cap = Math.min(tauMax, avail);
        if (cap < tauMin + 12 || start + W + cap >= x.length) continue;
        let s = 0; for (let j = 0; j < W; j++) s += x[start + j] * x[start + j];
        if (Math.sqrt(s / W) < silRms) { out.push({ t: frameSec(f), m: NaN, c: 0 }); continue; }
        const r = yin(x, start, W, tauMin, cap, d, cmnd);
        if (!r) { out.push({ t: frameSec(f), m: NaN, c: 0 }); continue; }
        const hz = srD / r.tau, m = 69 + 12 * Math.log2(hz / 440);
        out.push({ t: frameSec(f), m: (m >= CFG.minMidi - 0.5 && m <= CFG.maxMidi + 0.5) ? m : NaN, c: Math.max(0, Math.min(1, 1 - r.aper)) });
      }
      return out;
    }

    for (let i = 0; i < onsets.length; i++) {
      const on = onsets[i], bS = on.b, nextB = i + 1 < onsets.length ? onsets[i + 1].b : nb;
      let segPeak = -1e9;
      for (let b = bS; b < Math.min(nextB, bS + 6); b++) segPeak = Math.max(segPeak, eb[b]);
      let endB = nextB;
      for (let b = bS + 4; b < nextB; b++) if (eb[b] < segPeak - 30 || eb[b] < floorDb) { endB = b; break; }
      const L = endB - bS, onsetSample = bS * HOP + 64, tOn = onsetSample / srD;
      const feat = attackFeatures(onsetSample);

      let fr = L >= 5 ? pitchFrames(bS + 2, endB - 4, endB * HOP + 32) : [];
      let voiced = fr.filter(q => !isNaN(q.m)).length;
      if (voiced < 1 && L >= 4) { // short note: allow window to overlap into the next one
        fr = pitchFrames(bS + 2, Math.max(bS + 2, endB - 1), Math.min(x.length, nextB * HOP + 192));
        voiced = fr.filter(q => !isNaN(q.m)).length;
      }
      if (voiced < 1) {
        const ms = L * HOP / srD * 1000;
        if (ms <= CFG.muteMaxMs && on.od >= 8) notes.push({ time: tOn, mf: NaN, midi: null, dur: Math.max(0.05, L * HOP / srD), confidence: 0.45, technique: 'muted', mute: true, feat });
        if (i % 20 === 19) { progress(10 + 85 * (i + 1) / onsets.length); await yieldUI(); }
        continue;
      }
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
