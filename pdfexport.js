/* Lowline PDF engine: draws the tab (and optional notation / rhythm) as vector lines and text with jsPDF, laid out like a
 * printed tab book: bars packed into systems and every full system justified to the page width.
 * LowlinePdf.build(o, data) -> jsPDF doc
 *   o:    { title, artist, comment, info, notation, rhythm, bars, names, fingers, legend, credit, page, orient }
 *   data: { notes (with string/fret from the fingering engine), rh (LowlineRhythm.build result), names, openMidis, bpm, sig }
 * Text in the title block goes through a <canvas> (any script, e.g. Arabic); everything else is Helvetica.
 */
(function (root) {
  'use strict';
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const INK = [20, 20, 20], LINE = [150, 150, 150], ACC = [200, 70, 45];

  function textImage(doc, str, px, weight, color, maxW) {   // canvas text -> image (keeps any script and the app's font)
    const c = document.createElement('canvas'), g = c.getContext('2d'), k = 3;
    const font = `${weight} ${px * k}px ${weight >= 800 ? "'Archivo Black'," : ''} Archivo, Arial, sans-serif`;
    g.font = font; const w = Math.min(maxW * k, Math.ceil(g.measureText(str).width) + 4 * k), h = Math.ceil(px * 1.35 * k);
    c.width = Math.max(1, w); c.height = h; g.font = font; g.fillStyle = color; g.textBaseline = 'top';
    g.direction = /[֐-ࣿ]/.test(str) ? 'rtl' : 'ltr'; if (g.direction === 'rtl') { g.textAlign = 'right'; g.fillText(str, w - 2 * k, px * 0.12 * k); } else g.fillText(str, 2 * k, px * 0.12 * k);
    return { c, w: w / k, h: h / k };
  }

  function build(o, d) {
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: o.page || 'a4', orientation: o.orient || 'portrait', compress: true });
    const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 40, CW = PW - 2 * M;
    const { notes, rh } = d, nStr = d.openMidis.length;
    const S = { gap: 8, fret: 8, unit: 3.2, minEv: 12 };       // tab line gap, fret font, pt per 16th, min event width
    const tabH = (nStr - 1) * S.gap;

    // ---------- bars -> natural widths ----------
    const bars = []; for (let b = 0; b < rh.bars; b++) bars.push({ i: b, evs: [] });
    rh.events.forEach(e => { if (bars[e.bar]) bars[e.bar].evs.push(e); });
    // ---------- repeats, as tab books write them: identical bars (or 2- / 4-bar riffs) once, between |: :| with 'xN' ----------
    // a bar's identity = the notes it starts (position in the bar + pitch, or x) and where ties land: small length or technique
    // differences from the analysis would otherwise make every repeat of a riff look different
    const sig = b => b.evs.filter(e => e.kind !== 'rest').map(e => { const n = notes[e.note]; return `${e.kind === 'tie' ? 't' : ''}${e.pos}:${n.mute ? 'x' : n.midi}`; }).join(' ') || 'rest';
    let shown = bars;
    if (o.repeats) {
      const S2 = bars.map(sig), out = [];
      for (let i = 0; i < bars.length;) {
        let done = false;
        for (const L of [4, 2, 1]) {
          if (i + 2 * L > bars.length) continue;
          let c = 1; const same = (a, b) => { for (let q = 0; q < L; q++) if (S2[a + q] !== S2[b + q]) return false; return true; };
          while (i + (c + 1) * L <= bars.length && same(i, i + c * L)) c++;
          if (c >= 2 && !(L > 1 && S2.slice(i, i + L).every(x => x === S2[i]))) {   // a 2/4-bar group of one repeated bar is better as 1 bar xN
            for (let q = 0; q < L; q++) out.push(Object.assign({}, bars[i + q], { repStart: q === 0, repEnd: q === L - 1 ? c : 0 }));
            i += L * c; done = true; break;
          }
        }
        if (!done) { out.push(bars[i]); i++; }
      }
      shown = out;
    }
    const evW = e => {
      const n = e.note != null ? notes[e.note] : null;
      let w = Math.max(S.minEv, e.len * S.unit * 1.0);
      if (n && e.kind === 'note' && n.slideTo != null && !n.slideCut) w = Math.max(w, 26);
      if (n && e.kind === 'tie') w = Math.max(w, 16);
      if (n && !n.mute && n.fret >= 10) w = Math.max(w, 14);
      return w;
    };
    shown.forEach(b => { b.evs.forEach(e => (e.w = evW(e))); b.pad = b.repStart ? 12 : 7; b.w = b.pad + b.evs.reduce((a, e) => a + e.w, 0) + 3; if (!b.evs.length) b.w = 60; });
    // ---------- systems ----------
    const LABEL = 14, FIRST = 26;                                  // string names column, clef + time signature on system 1
    const systems = []; let cur = null;
    shown.forEach(b => {
      const room = CW - LABEL - (systems.length ? 0 : FIRST);
      if (!cur || cur.w + b.w > (cur.first ? room : CW - LABEL)) { cur = { bars: [], w: 0, first: !systems.length }; systems.push(cur); }
      cur.bars.push(b); cur.w += b.w;
    });
    // ---------- vertical layout of one system ----------
    const NOT = o.notation ? 64 : 0, TOP = 15, RHY = o.rhythm ? 20 : 0, NAMES = o.names ? 9 : 0, GAPSYS = 16;
    const sysH = NOT + TOP + tabH + 6 + NAMES + RHY + GAPSYS;

    let y = M, page = 1;
    // ---------- title block ----------
    if (o.title) { const t = textImage(doc, o.title, 22, 900, '#0f3d2e', CW); doc.addImage(t.c, 'PNG', M, y, t.w, t.h); y += t.h + 2; }
    if (o.artist) { const t = textImage(doc, o.artist, 13, 600, '#333333', CW); doc.addImage(t.c, 'PNG', M, y, t.w, t.h); y += t.h + 1; }
    if (o.info) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(60); doc.text(`Bass  ·  Tuning ${d.names.join(' ')}  ·  Tempo ${Math.round(d.sig === '6/8' || d.sig === '12/8' ? d.bpm / 1.5 : d.bpm)} bpm  ·  ${d.sig}`, M, y + 9); y += 14; }
    if (o.comment) { const t = textImage(doc, o.comment, 10, 400, '#444444', CW); doc.addImage(t.c, 'PNG', M, y, t.w, t.h); y += t.h + 2; }
    y += 10;

    const ln = (x1, y1, x2, y2, w, c) => { doc.setLineWidth(w || 0.5); doc.setDrawColor(...(c || INK)); doc.line(x1, y1, x2, y2); };
    const arc = (x1, x2, yy, h) => { doc.setLineWidth(0.6); doc.setDrawColor(...INK); const dx = x2 - x1; doc.lines([[dx * 0.25, -h, dx * 0.75, -h, dx, 0]], x1, yy, [1, 1], 'S'); };
    const txt = (s, x, yy, size, opt) => { doc.setFontSize(size); doc.text(String(s), x, yy, Object.assign({ align: 'center', baseline: 'middle' }, opt || {})); };

    systems.forEach((sys, si) => {
      if (y + sysH > PH - M - (o.credit ? 10 : 0)) { doc.addPage(); page++; y = M; }
      const x0 = M + LABEL + (sys.first ? FIRST : 0), avail = M + CW - x0;
      const last = si === systems.length - 1, fill = sys.w / avail;
      const k = last && fill < 0.75 ? 1 : avail / sys.w;          // justify: stretch every system except a short last one
      const yN = y + 8, yTab = y + NOT + TOP, rowY = s => yTab + (nStr - 1 - s) * S.gap, yRhy = yTab + tabH + 6 + NAMES;

      // tab staff
      for (let s = 0; s < nStr; s++) ln(M + LABEL - 2, rowY(s), x0 + sys.w * k, rowY(s), 0.4, LINE);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(60);
      for (let s = 0; s < nStr; s++) txt(d.names[s], M + 5, rowY(s), 7);
      if (sys.first) {
        doc.setTextColor(...INK); doc.setFont('helvetica', 'bold');
        ['T', 'A', 'B'].forEach((c, i) => txt(c, M + LABEL + 5, yTab + tabH * (0.18 + i * 0.32), 8));
        const [a, b] = d.sig.split('/'); txt(a, M + LABEL + 17, yTab + tabH * 0.28, 11); txt(b, M + LABEL + 17, yTab + tabH * 0.75, 11);
      }
      // notation staff
      const G = 5, nTop = yN + 14, lineYn = j => nTop + j * G, mid = lineYn(2);
      if (o.notation) {
        for (let j = 0; j < 5; j++) ln(M + LABEL - 2, lineYn(j), x0 + sys.w * k, lineYn(j), 0.4, INK);
        // F clef: a curl + two dots
        doc.setLineWidth(1.3); doc.setDrawColor(...INK); doc.lines([[0, -6, 11, -6, 11, 2], [0, 6, -6, 10, -12, 12]], M + LABEL - 1, lineYn(1), [1, 1], 'S');
        doc.setFillColor(...INK); doc.circle(M + LABEL, lineYn(1), 1.6, 'F'); doc.circle(M + LABEL + 14, lineYn(1) - 2.3, 0.8, 'F'); doc.circle(M + LABEL + 14, lineYn(1) + 2.3, 0.8, 'F');
        if (sys.first) { const [a, b] = d.sig.split('/'); doc.setFont('helvetica', 'bold'); txt(a, M + LABEL + 21, lineYn(1), 10); txt(b, M + LABEL + 21, lineYn(3), 10); }
      }
      // bars and events
      let x = x0, prevNoteX = new Map();
      const heads = [];
      sys.bars.forEach((b, bi) => {
        const bx = x, bw = b.w * k;
        ln(bx, yTab, bx, yTab + tabH, bi === 0 ? 0.8 : 0.6, INK);
        if (o.notation) ln(bx, lineYn(0), bx, lineYn(4), 0.6, INK);
        if (o.bars) { doc.setFont('helvetica', 'normal'); doc.setTextColor(120); txt(String(b.i + 1), bx + 2, (o.notation ? yN + 2 : yTab - 11), 6, { align: 'left' }); }
        const repSign = (xx, start) => {            // thick + thin bar and two dots (start: dots after, end: dots before)
          const th = start ? xx + 1 : xx - 1, tn = start ? xx + 3.5 : xx - 3.5, dx = start ? xx + 6.5 : xx - 6.5;
          [[yTab, yTab + tabH, tabH]].concat(o.notation ? [[lineYn(0), lineYn(4), 4 * G]] : []).forEach(([a, z, h]) => {
            ln(th, a, th, z, 2, INK); ln(tn, a, tn, z, 0.6, INK); doc.setFillColor(...INK);
            doc.circle(dx, a + h * 0.36, 0.9, 'F'); doc.circle(dx, a + h * 0.64, 0.9, 'F');
          });
        };
        if (b.repStart) repSign(bx, true);
        if (b.repEnd) { repSign(bx + bw, false); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); txt(`\u00d7${b.repEnd}`, bx + bw - 2, (o.notation ? yN + 2 : yTab - 11), 7.5, { align: 'right' }); }
        let ex = bx + b.pad * k, barSharps = {};
        b.evs.forEach(e => {
          const w = e.w * k, cx = ex + Math.min(w / 2, 6 * k) + 1; e.px = cx; ex += w;
          if (e.kind === 'rest') { if (o.rhythm) rest(cx, yRhy + 8, e.len, b); if (o.notation) restN(cx, mid, e.len); return; }
          const n = notes[e.note], ry = n.string != null ? rowY(n.string) : rowY(0);
          // fret number with a white box behind it
          const label = n.mute ? 'x' : e.kind === 'tie' ? `(${n.fret})` : String(n.fret);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(S.fret); const tw = doc.getTextWidth(label) + 2;
          doc.setFillColor(255, 255, 255); doc.rect(cx - tw / 2, ry - 3.6, tw, 7.2, 'F');
          doc.setTextColor(...(e.kind === 'tie' ? [110, 110, 110] : INK)); txt(label, cx, ry + 0.3, S.fret);
          if (e.kind === 'note') {
            if (n.octaveUp) { doc.setTextColor(...ACC); doc.setFont('helvetica', 'normal'); txt(n.octaveUp === 24 ? '15ma' : '8va', cx, ry - 6.5, 4.8); }
            if (o.fingers && n.finger && !n.mute) { doc.setTextColor(110); doc.setFont('helvetica', 'normal'); txt(n.finger, cx + tw / 2 + 2, ry - 4, 5); }
            if (o.names && !n.mute) { doc.setTextColor(90); doc.setFont('helvetica', 'normal'); txt(NOTE[n.midi % 12] + (Math.floor(n.midi / 12) - 1), cx, yTab + tabH + 8, 5.2); }
            // hammer-on / pull-off from the previous note
            const pv = notes[e.note - 1], px = prevNoteX.get(e.note - 1);
            if (n.technique === 'legato' && pv && !pv.mute && px != null) { const top = Math.min(ry, pv.string != null ? rowY(pv.string) : ry) - 5; arc(px + 2, cx - 2, top, 4); doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); txt(n.midi > pv.midi ? 'H' : 'P', (px + cx) / 2, top - 6.5, 5); }
            // legato slide to a second number, slide in / off
            if (n.slideTo != null && !n.slideCut) {
              const ex2 = cx + Math.max(12, w * 0.55), f2 = n.slideTo + (n.octaveUp || 0) - d.openMidis[n.string], up = n.slideTo > n.midi;
              ln(cx + tw / 2, ry + (up ? 2.5 : -2.5), ex2 - 4, ry + (up ? -2.5 : 2.5), 0.7); arc(cx + 2, ex2 - 2, ry - 5, 3.5);
              doc.setFillColor(255, 255, 255); doc.rect(ex2 - 4, ry - 3.6, 8, 7.2, 'F'); doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); txt(f2, ex2, ry + 0.3, S.fret);
            }
            if (n.slideOut || n.slideCut) { const up = n.slideCut ? n.slideTo > n.midi : n.slideOut === 'up'; ln(cx + tw / 2 + 0.5, ry + (up ? 2.5 : -2.5), cx + tw / 2 + 7, ry + (up ? -3 : 3), 0.7); }
            if (n.slideIn) { const fb = n.slideIn === 'up'; ln(cx - tw / 2 - 7, ry + (fb ? 3 : -3), cx - tw / 2 - 0.5, ry + (fb ? -2.5 : 2.5), 0.7); }
            if (n.slap) { doc.setTextColor(...INK); doc.setFont('helvetica', 'bold'); txt(n.string >= nStr - 2 ? 'P' : (o.slapLetter || 'S'), cx, yTab - 8, 6); }
            if (n.vibrato) { doc.setLineWidth(0.5); doc.setDrawColor(...INK); const seg = []; for (let q = 0; q < 4; q++) seg.push([1.5, q % 2 ? 1.5 : -1.5, 3, q % 2 ? 1.5 : -1.5, 3, 0]); doc.lines(seg.map(s => [s[0], s[1], s[2], s[3], s[4], s[5]]), cx - 4, yTab - 7, [1, 1], 'S'); }
          } else { // tie arc back to the note's first event
            const fx = prevNoteX.get(e.note); if (fx != null) arc(fx + 3, cx - 5, ry - 4, 3);
          }
          prevNoteX.set(e.note, cx);
          heads.push({ e, n, cx });
          if (o.notation) noteHead(e, n, cx, barSharps);
        });
        x += bw;
      });
      const endX = x0 + sys.w * k;
      ln(endX, yTab, endX, yTab + tabH, si === systems.length - 1 ? 1.6 : 0.6, INK);
      if (o.notation) ln(endX, lineYn(0), endX, lineYn(4), si === systems.length - 1 ? 1.6 : 0.6, INK);
      if (si === 0) { const ty = o.notation ? yN - 4 : yTab - 20; doc.setFillColor(...INK); doc.ellipse(x0 + 2, ty + 1.5, 2.1, 1.5, 'F'); ln(x0 + 4, ty + 1.5, x0 + 4, ty - 6, 0.6); doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); txt(`${d.sig === '6/8' || d.sig === '12/8' ? '. ' : ''}= ${Math.round(d.sig === '6/8' || d.sig === '12/8' ? d.bpm / 1.5 : d.bpm)}`, x0 + 7, ty, 7, { align: 'left' }); }
      if (o.rhythm) stems(heads, yRhy, false);
      if (o.notation) stems(heads.filter(h => !h.n.mute || true), mid, true);
      y += sysH;

      // ----- helpers that need this system's geometry -----
      function stepOf(m) { const LET = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]], w = m + 12, pc = ((w % 12) + 12) % 12, oct = Math.floor(w / 12) - 1; return { step: oct * 7 + LET[pc][0] - 22, sharp: LET[pc][1], letter: LET[pc][0] }; }
      function noteHead(e, n, cx, sharps) {
        const p = n.mute ? { step: 0, sharp: 0, letter: -1 } : stepOf(n.midi), yy = mid - p.step * G / 2; e.ny = yy; e.step = p.step;
        for (let st = p.step <= -6 ? -6 : 6; p.step <= -6 ? st >= p.step : st <= p.step; st += p.step <= -6 ? -2 : 2) ln(cx - 5, mid - st * G / 2, cx + 5, mid - st * G / 2, 0.5);
        const key = p.letter + ':' + Math.floor(p.step / 7);
        doc.setTextColor(...INK); doc.setFont('helvetica', 'bold');
        if (!n.mute && e.kind !== 'tie') { if (p.sharp && sharps[key] !== 1) { txt('#', cx - 7, yy, 8); sharps[key] = 1; } else if (!p.sharp && sharps[key] === 1) { const nx = cx - 8; ln(nx - 1.2, yy - 4, nx - 1.2, yy + 1.8, 0.5); ln(nx + 1.2, yy - 1.8, nx + 1.2, yy + 4, 0.5); ln(nx - 1.2, yy - 1, nx + 1.2, yy - 1.8, 1.1); ln(nx - 1.2, yy + 1.8, nx + 1.2, yy + 1, 1.1); sharps[key] = 0; } }
        if (n.mute) { txt('x', cx, yy, 8); return; }
        doc.setFillColor(...INK); doc.setDrawColor(...INK); doc.setLineWidth(0.8);
        doc.ellipse(cx, yy, 3, 2.2, e.len >= 8 ? 'S' : 'F');
        if ([3, 6, 12].includes(e.len)) doc.circle(cx + 5, yy - (p.step % 2 === 0 ? 1.5 : 0), 0.7, 'F');
      }
      function restN(cx, yy, len) { restShape(cx, yy, len); }
      function rest(cx, yy, len) { restShape(cx, yy, len); }
      function restShape(cx, yy, len) {
        doc.setFillColor(...INK); doc.setDrawColor(...INK); doc.setLineWidth(0.9);
        if (len >= 16) doc.rect(cx - 3, yy - 3, 6, 2, 'F');
        else if (len >= 8) doc.rect(cx - 3, yy - 1, 6, 2, 'F');
        else if (len >= 4) doc.lines([[2.5, 2.5], [-2.5, 2.5], [2.5, 3], [-3, 2.5]], cx - 1, yy - 5, [1, 1], 'S');
        else { const kk = len >= 2 ? 1 : 2; for (let q = 0; q < kk; q++) { doc.circle(cx - 1, yy - 2 + q * 3.5, 0.9, 'F'); ln(cx + 1.5, yy - 3 + q * 3.5, cx - 0.5, yy + 4 + q * 3.5, 0.6); } }
        if ([3, 6, 12].includes(len)) doc.circle(cx + 4, yy + 1, 0.7, 'F');
      }
      // stems, beams, flags: below the tab (rhythm) or on the notation staff (stem direction by pitch)
      function stems(hs, base, isNot) {
        const beatU = rh.beatU, groups = [];
        hs.forEach(h => {
          if (h.e.len >= 16) return;
          const g = groups[groups.length - 1], beat = h.e.bar * 1000 + Math.floor(h.e.pos / beatU), lastH = g && g.items[g.items.length - 1];
          if (h.e.len <= 3 && g && g.beat === beat && lastH.e.len <= 3 && lastH.e.u + lastH.e.len === h.e.u) g.items.push(h); else groups.push({ beat, items: [h] });
        });
        groups.forEach(({ items }) => {
          let up = true, by;
          const sx = h => (isNot ? (up ? h.cx + 2.9 : h.cx - 2.9) : h.cx);
          if (isNot) { const avg = items.reduce((a, h) => a + (h.e.step || 0), 0) / items.length; up = avg < 0; }
          if (isNot) by = up ? Math.min(...items.map(h => h.e.ny)) - 16 : Math.max(...items.map(h => h.e.ny)) + 16; else by = base + 14;
          items.forEach(h => { const y1 = isNot ? h.e.ny : base; ln(sx(h), y1, sx(h), by, 0.6); if (!isNot && h.e.len >= 8) { doc.setDrawColor(...INK); doc.setLineWidth(0.6); doc.ellipse(h.cx, by + 1.5, 1.8, 1.3, h.e.len >= 8 ? 'S' : 'F'); } if (!isNot && [3, 6, 12].includes(h.e.len)) { doc.setFillColor(...INK); doc.circle(h.cx + 3, by - 2, 0.6, 'F'); } });
          const d2 = isNot && !up ? -1 : 1, beamY = by, dirIn = isNot ? (up ? 1 : -1) : -1;
          if (items.length > 1) {
            doc.setLineWidth(2); doc.setDrawColor(...INK); doc.line(sx(items[0]), beamY, sx(items[items.length - 1]), beamY);
            items.forEach((h, q) => { if (h.e.len !== 1) return; const nx = items[q + 1], pv = items[q - 1], yy = beamY + dirIn * 3.4;
              if (nx && nx.e.len === 1) doc.line(sx(h), yy, sx(nx), yy); else if (!(pv && pv.e.len === 1)) doc.line(sx(h), yy, sx(h) + (nx ? 4 : -4), yy); });
          } else { const h = items[0], nf = h.e.len === 1 ? 2 : h.e.len <= 3 ? 1 : 0;
            for (let f = 0; f < nf; f++) { const fy = by + f * dirIn * 3.4; ln(sx(h), fy, sx(h) + 4, fy + dirIn * 4.5, 1); } }
        });
      }
    });

    if (o.legend) {
      const L = ['H / P  curve between two numbers: hammer-on / pull-off (pluck once).', 'Slanted line + curve: legato slide to the second number (not plucked again).',
        'Slanted tick after / before a number: slide off / slide in.', 'S slap, P pop, x dead note, (5) tied (held, not plucked again), ~ vibrato.',
        '8va over a number: the note is below the low string, played an octave up.'];
      if (y + 14 + L.length * 11 > PH - M) { doc.addPage(); y = M; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...INK); doc.text('Legend', M, y + 4); doc.setFont('helvetica', 'normal'); doc.setTextColor(60);
      L.forEach((t, i) => doc.text(t, M, y + 16 + i * 11)); y += 16 + L.length * 11;
    }
    if (o.credit) {
      const n = doc.getNumberOfPages();
      for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140); doc.text('Bass tab made with Lowline · estimated from audio, check it by ear', M, PH - 20); doc.text(`${i} / ${n}`, PW - M, PH - 20, { align: 'right' }); }
    }
    return doc;
  }
  root.LowlinePdf = { build };
})(typeof window !== 'undefined' ? window : globalThis);
