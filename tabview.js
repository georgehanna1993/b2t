/* Lowline tab renderer
 *
 * Draws a bass tab the way notation programs (Guitar Pro, Songsterr, MuseScore) do:
 *   - TAB clef, time signature, tempo mark, bar lines, measure numbers
 *   - rhythm under the staff: stems, beams, flags, dots, rests
 *   - hammer-on / pull-off slurs with H / P
 *   - legato slide (line + slur), slide-in, slide-out (lone slanted line, no second number)
 *   - slap S / pop P above the staff, dead note x, ties with (n), vibrato squiggle
 *   - optional left-hand finger numbers and note names
 *
 * render() returns, for every note, the x position of its attack (xs) and where it ends (ends,
 * different for legato slides) so the player can scroll the tab and place the playhead.
 * Works in the browser only (window.LowlineTabView).
 */
(function (root) {
  'use strict';

  const L = {
    TOP: 46, GAP: 26, LEFT: 78, NOTE_H: 23,
    RS_TOP: 138, RS_BOT: 160,           // rhythm stems (below the staff)
    SLIDE_SPAN: 62, TICK: 24            // room for a legato slide's second note / a slide-in/out tick
  };
  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#0f3d2e', SOFT = '#7d8a74', ACC = '#e8553b';
  const spring = d => 34 + 16 * Math.log2(Math.max(1, d)); // natural spacing for a gap of d sixteenths

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, o) {
    o = o || {};
    const t = el('text', { x, y, 'text-anchor': o.anchor || 'middle', 'font-size': o.size || 10, 'font-weight': o.weight || 400, fill: o.fill || INK, 'font-family': o.font || "'Archivo',Arial,sans-serif" }, parent);
    t.textContent = str;
    if (o.title) { const ti = el('title', {}, t); ti.textContent = o.title; }
    return t;
  }
  const arc = (x1, x2, y, h) => `M ${x1} ${y} Q ${(x1 + x2) / 2} ${y - 2 * h} ${x2} ${y}`;

  function render(cfg) {
    const { grid, notes, rhythm: rh, names, opts, midiName, fmt, onSeek, openMidis } = cfg;
    const onPlay = cfg.onPlay || ((t0) => onSeek(t0));
    const withNotation = !!opts.notation && !!rh, NOT_H = withNotation ? 104 : 0, TOP = L.TOP + NOT_H;
    grid.innerHTML = '';
    const nStr = (openMidis || names || [0, 0, 0, 0]).length, EXTRA = (nStr - 4) * L.GAP;
    const RS_TOP = L.RS_TOP + EXTRA + NOT_H, RS_BOT = L.RS_BOT + EXTRA + NOT_H;
    const rowY = s => TOP + (nStr - 1 - s) * L.GAP;
    const staffBottom = rowY(0);
    const withRhythm = !!opts.rhythm && !!rh;
    const H = (withRhythm ? 182 : 154) + EXTRA + NOT_H;
    const xs = new Array(notes.length).fill(0), ends = new Array(notes.length).fill(0);
    if (!notes.length || !rh) { grid.style.width = '820px'; grid.style.height = H + 'px'; return { xs, ends, width: 820, height: H, cursor: null, barStarts: [] }; }

    // ---------- 1) horizontal layout, bar by bar ----------
    const labelOf = (e, n) => (n.mute ? 'x' : e.kind === 'tie' ? '(' + n.fret + ')' : String(n.fret));
    const halfW = (e, n) => (e.kind === 'rest' ? 7 : Math.max(12.5, (labelOf(e, n).length * 8 + 8) / 2));
    const barsEv = []; for (let b = 0; b < rh.bars; b++) barsEv.push([]);
    rh.events.forEach(e => { if (barsEv[e.bar]) barsEv[e.bar].push(e); });
    const barStart = [], barEnd = [];
    let cursorX = L.LEFT;
    for (let b = 0; b < rh.bars; b++) {
      const evs = barsEv[b];
      barStart[b] = cursorX;
      let x = cursorX + (b === 0 ? 34 : 14), prev = null;
      if (!evs.length) { barEnd[b] = cursorX + 100; cursorX = barEnd[b]; continue; }
      evs.forEach((e, j) => {
        const n = e.note != null ? notes[e.note] : null;
        const left = n && e.kind === 'note' && n.slideIn ? L.TICK : 0, hw = halfW(e, n);
        if (j === 0) x += left + hw;
        else {
          const pn = prev.note != null ? notes[prev.note] : null;
          const right = pn && prev.kind === 'note' ? (pn.slideTo != null ? L.SLIDE_SPAN : 0) + (pn.slideOut ? L.TICK : 0) : 0;
          const need = halfW(prev, pn) + right + left + hw + 6;
          x += Math.max(need, spring(e.u - prev.u));
        }
        e.x = x; prev = e;
      });
      const pn = prev.note != null ? notes[prev.note] : null;
      const tailRight = pn && prev.kind === 'note' ? (pn.slideTo != null ? L.SLIDE_SPAN : 0) + (pn.slideOut ? L.TICK : 0) : 0;
      barEnd[b] = prev.x + Math.max(halfW(prev, pn) + tailRight + 14, spring(prev.len) * 0.7);
      if (evs.length === 1 && evs[0].kind === 'rest') { evs[0].x = (barStart[b] + barEnd[b]) / 2; barEnd[b] = Math.max(barEnd[b], barStart[b] + 96); evs[0].x = (barStart[b] + barEnd[b]) / 2; }
      cursorX = barEnd[b];
    }
    const W = Math.ceil(cursorX + 40);
    grid.style.width = W + 'px'; grid.style.height = H + 'px';

    // staff lines (HTML so they always span the full width)
    for (let s = 0; s < nStr; s++) { const l = document.createElement('div'); l.className = 'string-line'; l.style.top = rowY(s) + 'px'; grid.appendChild(l); }
    const svg = el('svg', { class: 'tab-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, grid);
    svg.setAttribute('aria-hidden', 'true');
    const gBack = el('g', {}, svg), gMarks = el('g', {}, svg);

    function hit(x, y, w, h, title, t0, t1, i) {
      const d = document.createElement('button'); d.className = 'mark-hit'; d.type = 'button';
      Object.assign(d.style, { left: x + 'px', top: y + 'px', width: Math.max(10, w) + 'px', height: h + 'px' });
      d.title = title; d.setAttribute('aria-label', title); d.onclick = () => onPlay(t0, t1, i); grid.appendChild(d);
    }

    // ---------- 2) bar lines, clef, time signature, tempo ----------
    const topY = TOP - 7, botY = staffBottom + 7;
    for (let b = 0; b <= rh.bars; b++) {
      const x = b < rh.bars ? barStart[b] : barEnd[rh.bars - 1];
      el('line', { x1: x, x2: x, y1: topY, y2: botY, stroke: INK, 'stroke-width': b === 0 ? 1.6 : 1.2 }, gBack);
      if (b === rh.bars) el('line', { x1: x + 4, x2: x + 4, y1: topY, y2: botY, stroke: INK, 'stroke-width': 3 }, gBack);
      if (b < rh.bars && opts.bars) text(gBack, x + 4, topY - 16, String(b + 1), { anchor: 'start', size: 9, fill: SOFT });
    }
    ['T', 'A', 'B'].forEach((c, i) => text(gBack, 44, TOP + 22 + EXTRA / 2 + i * 21, c, { size: 17, weight: 700 }));
    const sg = rh.sig.split('/');
    text(gBack, barStart[0] + 15, TOP + 27, sg[0], { size: 21, weight: 700 });
    text(gBack, barStart[0] + 15, TOP + 27 + 25, sg[1], { size: 21, weight: 700 });
    text(gBack, barStart[0] + 4, 12, '\u2669 = ' + Math.round(rh.bpm), { anchor: 'start', size: 11, weight: 700 });

    // ---------- 3) notes, technique marks ----------
    const noteEv = new Map();           // note index -> its 'note' event
    rh.events.forEach(e => { if (e.kind === 'note') noteEv.set(e.note, e); });
    const evOfNote = i => noteEv.get(i);
    const rowOf = n => rowY(n.string);

    notes.forEach((n, i) => {
      const e = evOfNote(i); if (!e) return;
      xs[i] = e.x; ends[i] = n.slideTo != null ? e.x + L.SLIDE_SPAN : e.x;
    });

    rh.events.forEach(e => {
      if (e.kind === 'rest') return;
      const n = notes[e.note], i = e.note, y = rowOf(n), x = e.x, hw = halfW(e, n), top = y - L.NOTE_H / 2 - 2;
      const b = document.createElement('button');
      b.className = 'tab-note' + (n.confidence < 0.75 ? ' uncertain' : '') + (n.mute ? ' muted' : '') + (e.kind === 'tie' ? ' tied' : '');
      b.style.left = x + 'px'; b.style.top = y + 'px';
      b.textContent = labelOf(e, n);
      b.dataset.index = i;
      const tech = [];
      if (n.technique === 'legato') tech.push('hammer-on/pull-off');
      if (n.slideTo != null) tech.push((n.slideCut ? 'slides off toward ' : 'legato slide to ') + midiName(n.slideTo) + (n.slideCut ? ' (too far for one string)' : ''));
      if (n.slideOut) tech.push('slide out ' + n.slideOut);
      if (n.slideIn) tech.push('slide in from ' + (n.slideIn === 'up' ? 'below' : 'above'));
      if (n.vibrato) tech.push('vibrato');
      if (n.slap) tech.push(n.string >= nStr - 2 ? 'pop' : 'slap');
      b.title = `${n.mute ? 'Dead note' : midiName(n.midi)} \u00b7 ${fmt(n.time)}${n.confidence < 0.75 ? ' \u00b7 uncertain' : ''}${tech.length ? ' \u00b7 ' + tech.join(', ') : ''}${n.octaveUp ? ' \u00b7 below the low string: played ' + (n.octaveUp / 12) + ' octave up' : ''}${n.finger ? ' \u00b7 finger ' + n.finger : ''}${n.feat ? ' \u00b7 brightness ' + n.feat.bright.toFixed(2) : ''}`;
      b.setAttribute('aria-label', n.mute ? `Dead note at ${fmt(n.time)}` : `Note ${midiName(n.midi)}, ${names[n.string]} string, fret ${n.fret}, ${fmt(n.time)}${tech.length ? ', ' + tech.join(', ') : ''}`);
      b.onclick = () => onPlay(n.time, n.time + n.dur, i);
      grid.appendChild(b);

      // tie arc back to the note it continues
      if (e.kind === 'tie') {
        const prev = rh.events.filter(q => q.note === i && q.u < e.u && q.kind !== 'rest').pop();
        if (prev) el('path', { d: arc(prev.x + 7, x - 7, top, 6), fill: 'none', stroke: INK, 'stroke-width': 1.2 }, gMarks);
        return;
      }
      // hammer-on / pull-off: slur between this note and the previous one, with H or P
      if (n.technique === 'legato' && i > 0 && !notes[i - 1].mute) {
        const px = ends[i - 1] || xs[i - 1], up = n.midi > notes[i - 1].midi;
        el('path', { d: arc(px + 6, x - 6, top, 8), fill: 'none', stroke: INK, 'stroke-width': 1.3 }, gMarks);
        text(gMarks, (px + x) / 2, top - 9, up ? 'H' : 'P', { size: 8, weight: 700 });
        hit(px + 8, top - 20, x - px - 16, 22, (up ? 'Hammer-on' : 'Pull-off') + ': hear both notes', notes[i - 1].time, n.time + n.dur, i);
      }
      // legato slide: slanted line + slur to the second number (which is not plucked again)
      if (n.slideTo != null && !n.slideCut) {
        const endX = x + L.SLIDE_SPAN, up = n.slideTo > n.midi, endFret = n.slideTo - openMidis[n.string];
        el('line', { x1: x + hw + 2, y1: y + (up ? 6 : -6), x2: endX - hw - 2, y2: y + (up ? -6 : 6), stroke: INK, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, gMarks);
        el('path', { d: arc(x + 6, endX - 6, top, 8), fill: 'none', stroke: INK, 'stroke-width': 1.3 }, gMarks);
        hit(x + hw, top - 18, L.SLIDE_SPAN - 2 * hw, L.NOTE_H + 20, 'Slide: hear it', n.time, n.time + n.dur, i);
        const eb = document.createElement('button');
        eb.className = 'tab-note slide-end'; eb.style.left = endX + 'px'; eb.style.top = y + 'px'; eb.textContent = endFret;
        eb.dataset.slideEnd = i; eb.title = `Slide lands on ${midiName(n.slideTo)}`; eb.setAttribute('aria-label', `Slide lands on ${midiName(n.slideTo)}, fret ${endFret}`);
        eb.onclick = () => onPlay(n.time, n.time + n.dur, i);
        grid.appendChild(eb);
      }
      // slide out: lone slanted line after the note
      if (n.slideOut || n.slideCut) {
        const up = n.slideCut ? n.slideTo > n.midi : n.slideOut === 'up';
        el('line', { x1: x + hw + 2, y1: y + (up ? 5 : -5), x2: x + hw + 2 + 17, y2: y + (up ? -7 : 7), stroke: INK, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, gMarks);
        hit(x + hw, y - 11, 21, 22, 'Slide off: hear it', n.time, n.time + n.dur, i);
      }
      // slide in: lone slanted line before the note
      if (n.slideIn) {
        const fromBelow = n.slideIn === 'up';
        el('line', { x1: x - hw - 2 - 17, y1: y + (fromBelow ? 7 : -7), x2: x - hw - 2, y2: y + (fromBelow ? -5 : 5), stroke: INK, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, gMarks);
        hit(x - hw - 21, y - 11, 21, 22, 'Slide in: hear it', n.time, n.time + n.dur, i);
      }
      // slap / pop letter above the staff
      if (n.slap) hit(x - 8, TOP - 26, 16, 16, (n.string >= nStr - 2 ? 'Pop' : 'Slap') + ': hear it', n.time, n.time + n.dur, i);
      if (n.slap) text(gMarks, x, TOP - 14, n.string >= nStr - 2 ? 'P' : 'S', { size: 12, weight: 700, title: n.string >= nStr - 2 ? 'Pop' : 'Slap' });
      // vibrato squiggle above the staff
      if (n.vibrato) {
        const nextEv = rh.events.find(q => q.u > e.u && q.kind !== 'rest'), len = Math.max(24, Math.min(110, (nextEv ? nextEv.x : x + 90) - x - 14));
        let d = `M ${x - 6} ${TOP - 12}`; for (let k = 0; k * 6 < len; k++) d += ` q 3 ${k % 2 ? 4 : -4} 6 0`;
        el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 1.2 }, gMarks);
        hit(x - 6, TOP - 20, len, 16, 'Vibrato: hear it', n.time, n.time + n.dur, i);
      }
      // left-hand finger number
      if (!n.mute && n.octaveUp) text(gMarks, x, y - 23, n.octaveUp === 24 ? '15ma' : '8va', { size: 8, fill: ACC, weight: 700 });
      if (opts.fingers && !n.mute && n.finger) text(gMarks, x + hw - 3, y - 13, String(n.finger), { size: 8, fill: SOFT, weight: 700 });
      // note name
      if (opts.names && !n.mute) text(gMarks, x, y + 20, midiName(n.midi), { size: 8, fill: SOFT });
    });

    // ---------- 4) rhythm: stems, beams, flags, dots, rests ----------
    if (withRhythm) {
      const beamable = len => len <= 3, beatU = rh.beatU;
      const stemX = e => e.x;
      const flag = (x, n16) => { // flag(s) at the bottom of a stem
        for (let k = 0; k < n16; k++) el('path', { d: `M ${x} ${RS_BOT - k * 5} q 7 3 6 11`, fill: 'none', stroke: INK, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, gMarks);
      };
      for (let b = 0; b < rh.bars; b++) {
        const evs = barsEv[b]; let group = [];
        const flush = () => {
          if (group.length >= 2) {
            const x1 = stemX(group[0]), x2 = stemX(group[group.length - 1]);
            el('line', { x1, x2, y1: RS_BOT, y2: RS_BOT, stroke: INK, 'stroke-width': 3 }, gMarks);
            group.forEach((g, k) => {
              if (g.len !== 1) return;
              const nx = group[k + 1], pv = group[k - 1];
              if (nx && nx.len === 1) el('line', { x1: stemX(g), x2: stemX(nx), y1: RS_BOT - 5.5, y2: RS_BOT - 5.5, stroke: INK, 'stroke-width': 3 }, gMarks);
              else if (!(pv && pv.len === 1)) { const dir = nx ? 1 : -1; el('line', { x1: stemX(g), x2: stemX(g) + dir * 8, y1: RS_BOT - 5.5, y2: RS_BOT - 5.5, stroke: INK, 'stroke-width': 3 }, gMarks); }
            });
          } else if (group.length === 1) flag(stemX(group[0]), group[0].len === 1 ? 2 : 1);
          group = [];
        };
        evs.forEach(e => {
          if (e.kind === 'rest') { flush(); drawRest(e, rh.barU); return; }
          const x = stemX(e);
          if (e.len < 16) el('line', { x1: x, x2: x, y1: RS_TOP, y2: RS_BOT, stroke: INK, 'stroke-width': 1.3 }, gMarks);
          else el('circle', { cx: x, cy: RS_BOT - 4, r: 3.6, fill: 'none', stroke: INK, 'stroke-width': 1.3 }, gMarks);
          if (e.len >= 8 && e.len < 16) el('ellipse', { cx: x, cy: RS_BOT + 3, rx: 3.6, ry: 2.6, fill: '#fbf5e6', stroke: INK, 'stroke-width': 1.3 }, gMarks); // half note: hollow head
          if ([3, 6, 12].includes(e.len)) el('circle', { cx: x + 7, cy: RS_BOT + (e.len >= 8 ? 3 : -2), r: 1.5, fill: INK }, gMarks);
          const beat = Math.floor(e.pos / beatU);
          if (beamable(e.len)) {
            if (group.length && Math.floor(group[0].pos / beatU) !== beat) flush();
            group.push(e);
          } else flush();
        });
        flush();
      }
      function drawRest(e, barU) {
        const x = e.x, y = (RS_TOP + RS_BOT) / 2, len = e.len;
        if (len >= barU || len === 16) { el('rect', { x: x - 6, y: y - 6, width: 12, height: 4.5, fill: INK }, gMarks); el('line', { x1: x - 9, x2: x + 9, y1: y - 6, y2: y - 6, stroke: INK, 'stroke-width': 1 }, gMarks); }
        else if (len >= 8) { el('rect', { x: x - 6, y: y - 1.5, width: 12, height: 4.5, fill: INK }, gMarks); el('line', { x1: x - 9, x2: x + 9, y1: y + 3, y2: y + 3, stroke: INK, 'stroke-width': 1 }, gMarks); }
        else if (len >= 4) el('path', { d: `M ${x - 2} ${y - 9} l 5 5 l -5 5 l 5 6 q -6 0 -5 5`, fill: 'none', stroke: INK, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }, gMarks);
        else { // eighth / sixteenth rests
          const k = len >= 2 ? 1 : 2;
          for (let q = 0; q < k; q++) { const yy = y - 5 + q * 7; el('circle', { cx: x - 2, cy: yy, r: 1.9, fill: INK }, gMarks); el('path', { d: `M ${x - 2} ${yy} q 4 0 5 -3 l -5 14`, fill: 'none', stroke: INK, 'stroke-width': 1.3 }, gMarks); }
        }
        if ([3, 6, 12].includes(len)) el('circle', { cx: x + 8, cy: y + 2, r: 1.5, fill: INK }, gMarks);
      }
    }

    if (withNotation) drawNotation();
    function drawNotation() {
      const G = 9, base = 36, lineY = k => base + k * G;        // k = 0 (top, A3) .. 4 (bottom, G2) in bass clef
      for (let k = 0; k < 5; k++) el('line', { x1: L.LEFT - 40, x2: W - 40, y1: lineY(k), y2: lineY(k), stroke: INK, 'stroke-width': 1 }, gBack);
      for (let b = 0; b <= rh.bars; b++) { const x = b < rh.bars ? barStart[b] : barEnd[rh.bars - 1]; el('line', { x1: x, x2: x, y1: lineY(0), y2: lineY(4), stroke: INK, 'stroke-width': b === rh.bars ? 3 : 1.2 }, gBack); }
      // bass (F) clef
      const cx = L.LEFT - 32, fy = lineY(1);
      el('path', { d: `M ${cx} ${fy} c 0 -12 22 -12 22 4 c 0 14 -12 24 -24 28`, fill: 'none', stroke: INK, 'stroke-width': 2.6, 'stroke-linecap': 'round' }, gBack);
      el('circle', { cx: cx + 2, cy: fy + 1, r: 3.6, fill: INK }, gBack);
      el('circle', { cx: cx + 28, cy: fy - 4.5, r: 1.8, fill: INK }, gBack); el('circle', { cx: cx + 28, cy: fy + 4.5, r: 1.8, fill: INK }, gBack);
      const sg2 = rh.sig.split('/');
      text(gBack, barStart[0] + 15, lineY(2) - 2, sg2[0], { size: 21, weight: 700 }); text(gBack, barStart[0] + 15, lineY(4) - 1, sg2[1], { size: 21, weight: 700 });
      // written an octave above sounding pitch (standard for bass). staff step 0 = middle line D3 written.
      const LET = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
      const stepOf = m => { const w = m + 12, pc = ((w % 12) + 12) % 12, oct = Math.floor(w / 12) - 1; return { step: oct * 7 + LET[pc][0] - (3 * 7 + 1), sharp: LET[pc][1], letter: LET[pc][0] }; };
      const yOf = st => lineY(2) - st * G / 2;
      let barSharps = {}, curBar = -1;
      const heads = [];
      rh.events.forEach(e => {
        const x = e.x;
        if (e.bar !== curBar) { curBar = e.bar; barSharps = {}; }
        if (e.kind === 'rest') { drawRestAt(e, lineY(2)); return; }
        const n = notes[e.note], i = e.note;
        const p = n.mute ? { step: 0, sharp: 0, letter: -1 } : stepOf(n.midi), y = yOf(p.step);
        for (let st = p.step <= -6 ? -6 : 6; p.step <= -6 ? st >= p.step : st <= p.step; st += p.step <= -6 ? -2 : 2)
          el('line', { x1: x - 9, x2: x + 9, y1: yOf(st), y2: yOf(st), stroke: INK, 'stroke-width': 1 }, gMarks);
        const key = p.letter + ':' + Math.floor(p.step / 7);
        if (!n.mute && e.kind !== 'tie') {
          if (p.sharp && barSharps[key] !== 1) { text(gMarks, x - 13, y + 4, '\u266f', { size: 14, weight: 700 }); barSharps[key] = 1; }
          else if (!p.sharp && barSharps[key] === 1) { text(gMarks, x - 13, y + 4, '\u266e', { size: 14, weight: 700 }); barSharps[key] = 0; }
        }
        const len = e.len, open = len >= 8;
        if (n.mute) text(gMarks, x, y + 4, '\u00d7', { size: 15, weight: 700 });
        else el('ellipse', { cx: x, cy: y, rx: 5.2, ry: 3.8, transform: `rotate(-20 ${x} ${y})`, fill: open ? '#fbf5e6' : INK, stroke: INK, 'stroke-width': 1.4 }, gMarks);
        if ([3, 6, 12].includes(len)) el('circle', { cx: x + 9, cy: y - (p.step % 2 === 0 ? 3 : 0), r: 1.6, fill: INK }, gMarks);
        if (len < 16) heads.push({ e, x, y, step: p.step, len });
        if (e.kind === 'tie') { const prev = rh.events.filter(q => q.note === i && q.u < e.u && q.kind !== 'rest').pop(); if (prev) el('path', { d: arc(prev.x + 6, x - 6, y + 9, -4), fill: 'none', stroke: INK, 'stroke-width': 1.2 }, gMarks); }
        if (n.slideTo != null && !n.slideCut && e.kind === 'note') el('line', { x1: x + 8, y1: y, x2: x + L.SLIDE_SPAN - 8, y2: yOf(stepOf(n.slideTo).step), stroke: INK, 'stroke-width': 1.3 }, gMarks);
        hit(x - 9, y - 9, 18, 18, (n.mute ? 'Dead note' : midiName(n.midi)) + ': hear it', n.time, n.time + n.dur, i);
      });
      // stems: notes of one beat that are eighths or shorter share a beam (like printed bass parts)
      const beatU = rh.beatU, groups = [];
      heads.forEach(h => {
        const g = groups[groups.length - 1], beat = h.e.bar * 1000 + Math.floor(h.e.pos / beatU);
        if (h.len <= 3 && g && g.beat === beat && g.items[g.items.length - 1].len <= 3 && g.items[g.items.length - 1].e.u + g.items[g.items.length - 1].len === h.e.u) g.items.push(h);
        else groups.push({ beat, items: [h] });
      });
      groups.forEach(({ items }) => {
        const avg = items.reduce((a, h) => a + h.step, 0) / items.length, up = avg < 0, SL = 30;
        if (items.length === 1) {
          const h = items[0], sx = up ? h.x + 4.8 : h.x - 4.8, y2 = up ? h.y - SL : h.y + SL;
          el('line', { x1: sx, x2: sx, y1: h.y, y2, stroke: INK, 'stroke-width': 1.3 }, gMarks);
          const nf = h.len === 1 ? 2 : h.len <= 3 ? 1 : 0;
          for (let k = 0; k < nf; k++) el('path', { d: up ? `M ${sx} ${y2 + k * 6} q 2 8 9 12` : `M ${sx} ${y2 - k * 6} q 2 -8 9 -12`, fill: 'none', stroke: INK, 'stroke-width': 1.7, 'stroke-linecap': 'round' }, gMarks);
          return;
        }
        const by = up ? Math.min(...items.map(h => h.y)) - SL : Math.max(...items.map(h => h.y)) + SL, d = up ? 1 : -1;
        const sxOf = h => (up ? h.x + 4.8 : h.x - 4.8);
        items.forEach(h => el('line', { x1: sxOf(h), x2: sxOf(h), y1: h.y, y2: by, stroke: INK, 'stroke-width': 1.3 }, gMarks));
        el('line', { x1: sxOf(items[0]), x2: sxOf(items[items.length - 1]), y1: by, y2: by, stroke: INK, 'stroke-width': 4 }, gMarks);
        items.forEach((h, k) => { // second beam for sixteenths
          if (h.len !== 1) return; const nx = items[k + 1], pv = items[k - 1], yy = by + d * 6;
          if (nx && nx.len === 1) el('line', { x1: sxOf(h), x2: sxOf(nx), y1: yy, y2: yy, stroke: INK, 'stroke-width': 4 }, gMarks);
          else if (!(pv && pv.len === 1)) { const dir = nx ? 1 : -1; el('line', { x1: sxOf(h), x2: sxOf(h) + dir * 8, y1: yy, y2: yy, stroke: INK, 'stroke-width': 4 }, gMarks); }
        });
        if (items.some(h => [3, 6].includes(h.len))) { /* dotted notes keep their dot, drawn with the head */ }
      });
      function drawRestAt(e, y) {
        const x = e.x, len = e.len;
        if (len >= 8) { const yy = len >= 16 ? lineY(1) : lineY(2) - 4.5; el('rect', { x: x - 6, y: yy, width: 12, height: 4.5, fill: INK }, gMarks); }
        else if (len >= 4) el('path', { d: `M ${x - 2} ${y - 11} l 5 5 l -5 5 l 5 6 q -6 0 -5 5`, fill: 'none', stroke: INK, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }, gMarks);
        else { const k = len >= 2 ? 1 : 2; for (let q = 0; q < k; q++) { const yy = y - 5 + q * 7; el('circle', { cx: x - 2, cy: yy, r: 1.9, fill: INK }, gMarks); el('path', { d: `M ${x - 2} ${yy} q 4 0 5 -3 l -5 14`, fill: 'none', stroke: INK, 'stroke-width': 1.3 }, gMarks); } }
      }
    }

    // playhead
    const cursor = document.createElement('div');
    cursor.className = 'tab-cursor'; cursor.style.left = L.LEFT + 'px';
    grid.appendChild(cursor);

    // sticky string labels
    const labels = document.createElement('div'); labels.className = 'string-labels';
    for (let s = 0; s < nStr; s++) { const sp = document.createElement('span'); sp.className = 'string-label'; sp.style.top = rowY(s) + 'px'; sp.textContent = names[s]; labels.appendChild(sp); }
    grid.appendChild(labels);

    return { xs, ends, width: W, height: H, cursor, barStarts: barStart };
  }

  root.LowlineTabView = { render, L };
})(typeof window !== 'undefined' ? window : globalThis);
