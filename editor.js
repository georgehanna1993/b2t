/* Lowline tab editor + PDF export (uses app.js globals: notes, buildTab, playClip, strings, rhythmState, nowTime, getAC).
 *
 * Edit mode: click a note to select it (you hear the recording), then change it; every change plays the new pitch as a
 * short synthesized bass tone. A string choice is kept by locking that note's string/fret in the fingering engine.
 * Keys: Up/Down semitone, Shift+Up/Down other string, Left/Right one 16th earlier/later, Delete, N add at the playhead,
 * Ctrl+Z undo, Esc done.
 */
(function () {
  'use strict';
  let editMode = false, sel = null;
  const undo = [];
  const $ = id => document.getElementById(id);
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const nameOf = m => names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  // the fingering engine honours locks: {noteIndex: {s, f}}
  const origAssign = LowlineFingering.assign;
  LowlineFingering.assign = function (ns, open, opts) {
    const locks = Object.assign({}, (opts && opts.locks) || {});
    ns.forEach((n, i) => { if (n.lock) locks[i] = n.lock; });
    return origAssign.call(this, ns, open, Object.assign({}, opts || {}, { locks }));
  };
  // clicking a note in edit mode also selects it
  const origClip = playClip;
  playClip = function (t0, t1, i) { if (editMode && i != null && notes[i]) select(notes[i]); return origClip(t0, t1, i); };
  // re-mark the selection after every redraw
  const origBuild = buildTab;
  buildTab = function () { origBuild(); mark(); };

  function tone(midi) {
    try {
      const ac = getAC(); if (ac.state === 'suspended') ac.resume();
      const f = 440 * Math.pow(2, (midi - 69) / 12), t = ac.currentTime, g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      g.connect(ac.destination);
      [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]].forEach(([h, type, a]) => {
        const o = ac.createOscillator(), og = ac.createGain(); o.type = type; o.frequency.value = f * h; og.gain.value = a;
        o.connect(og); og.connect(g); o.start(t); o.stop(t + 0.75);
      });
    } catch (e) { /* no audio: fine */ }
  }
  function snapshot() { undo.push({ notes: notes.map(n => Object.assign({}, n, { lock: n.lock ? Object.assign({}, n.lock) : undefined })), sel: notes.indexOf(sel) }); if (undo.length > 100) undo.shift(); }
  function changed(play) {
    sel && (sel.confidence = 1, sel.edited = true);
    buildTab();
    $('noteCount').textContent = `· ${notes.length} NOTES`;
    if (play && sel && !sel.mute) tone(sel.midi);
    info();
  }
  function select(n) { sel = n; mark(); info(); }
  function mark() {
    document.querySelectorAll('.tab-note.selected').forEach(e => e.classList.remove('selected'));
    if (!editMode || !sel) return;
    const i = notes.indexOf(sel); if (i < 0) { sel = null; return; }
    const el = document.querySelector(`.tab-note[data-index="${i}"]:not(.slide-end)`); if (el) el.classList.add('selected');
  }
  function info() {
    const box = $('editInfo'); if (!box) return;
    if (!sel || notes.indexOf(sel) < 0) { box.textContent = 'Click a note to select it, or add one at the playhead.'; return; }
    box.textContent = sel.mute ? `Dead note · ${fmt(sel.time)}` : `${nameOf(sel.midi)} · ${(stringNames()[sel.string] || '?')} string, fret ${sel.fret} · ${fmt(sel.time)}`;
  }
  const step16 = () => 60 / rhythmState.bpm / 4;
  const ops = {
    pitch(d) {
      if (!sel || sel.mute) return; snapshot();
      sel.midi += d; sel.mf = sel.midi; if (sel.slideTo != null) sel.slideTo += d;
      if (sel.string != null && sel.fret + d >= 0 && sel.fret + d <= 24) sel.lock = { s: sel.string, f: sel.fret + d }; else delete sel.lock;
      changed(true);
    },
    string(dir) {
      if (!sel || sel.mute || sel.string == null) return;
      const open = strings(), m = sel.midi + (sel.octaveUp || 0);
      for (let s = sel.string + dir; s >= 0 && s < open.length; s += dir) {
        const f = m - open[s];
        if (f >= 0 && f <= 22) { snapshot(); sel.lock = { s, f }; changed(true); return; }
      }
      toast('No other string can play this note.');
    },
    time(d) {
      if (!sel) return; snapshot();
      sel.time = Math.max(0, sel.time + d * step16());
      notes.sort((a, b) => a.time - b.time); changed(true);
    },
    del() {
      if (!sel) return; snapshot();
      const i = notes.indexOf(sel); notes.splice(i, 1); sel = notes[Math.min(i, notes.length - 1)] || null; changed(false);
    },
    add() {
      snapshot();
      const t = playing ? nowTime() : curPos, prev = notes.filter(n => !n.mute && n.time <= t).pop() || notes.find(n => !n.mute);
      const m = sel && !sel.mute ? sel.midi : prev ? prev.midi : 40;
      const n = { time: t, midi: m, mf: m, dur: 60 / rhythmState.bpm / 2, confidence: 1, edited: true, added: true, technique: null };
      notes.push(n); notes.sort((a, b) => a.time - b.time); sel = n; changed(true);
    },
    undo() {
      const u = undo.pop(); if (!u) return toast('Nothing to undo.');
      notes = u.notes; sel = notes[u.sel] || null; changed(false);
    }
  };
  function setMode(on) {
    editMode = on; document.body.classList.toggle('editing', on);
    $('editBtn').setAttribute('aria-pressed', on); $('editBtn').textContent = on ? '✓ Done' : '✎ Edit';
    $('editBar').hidden = !on; if (!on) sel = null; mark(); info();
  }
  $('editBtn').onclick = () => setMode(!editMode);
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const [op, arg] = b.dataset.edit.split(':'); ops[op](arg != null ? +arg : undefined); });
  document.addEventListener('keydown', e => {
    if (!editMode || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key; let done = true;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') ops.undo();
    else if (k === 'ArrowUp') e.shiftKey ? ops.string(1) : ops.pitch(1);
    else if (k === 'ArrowDown') e.shiftKey ? ops.string(-1) : ops.pitch(-1);
    else if (k === 'ArrowLeft') ops.time(-1);
    else if (k === 'ArrowRight') ops.time(1);
    else if (k === 'Delete' || k === 'Backspace') ops.del();
    else if (k.toLowerCase() === 'n') ops.add();
    else if (k === 'Escape') setMode(false);
    else done = false;
    if (done) e.preventDefault();
  });

  // ---- PDF: a print layout that wraps the tab into rows at bar lines; the browser's "Save as PDF" makes the file ----
  function exportPdf() {
    if (!notes.length || !tabInfo) return toast('Load a song first.');
    const wasEdit = editMode; if (wasEdit) setMode(false);
    const area = $('printArea'); area.innerHTML = '';
    const grid = $('tabGrid'), H = grid.offsetHeight, PW = 660, GUT = 38, starts = (tabInfo.barStarts || []).concat([tabInfo.width - 40]);
    const title = $('trackName').textContent.replace(/\s+—\s+your bassline$/, '').replace(/\.(mp3|wav|m4a|ogg|flac)$/i, '');
    const head = document.createElement('div'); head.className = 'print-head';
    head.innerHTML = `<h1></h1><p>Bass · tuning ${stringNames().join(' ')} · ♩ = ${Math.round(rhythmState.bpm)} · ${rhythmState.sig}</p>`;
    head.querySelector('h1').textContent = title; area.appendChild(head);
    let x0 = 0;
    while (x0 < tabInfo.width - 41) {
      let x1 = x0; for (const b of starts) if (b > x0 && b - x0 <= PW) x1 = b;
      if (x1 <= x0) x1 = Math.min(tabInfo.width, x0 + PW);
      const row = document.createElement('div'); row.className = 'print-row'; row.style.width = (x1 - x0 + 2 + GUT) + 'px'; row.style.height = H + 'px';
      const c = grid.cloneNode(true); c.removeAttribute('id'); c.style.position = 'absolute'; c.style.left = (GUT - x0) + 'px'; c.style.top = '0';
      row.appendChild(c); area.appendChild(row); x0 = x1;
    }
    const foot = document.createElement('p'); foot.className = 'print-foot'; foot.textContent = 'Tab made with Lowline · estimated from audio, check it by ear'; area.appendChild(foot);
    const oldTitle = document.title; document.title = title + ' - bass tab';
    setTimeout(() => { window.print(); document.title = oldTitle; if (wasEdit) setMode(true); }, 50);
  }
  $('pdfBtn').onclick = exportPdf;
  window.LowlineEditor = { ops, select, setMode, exportPdf, get sel() { return sel; }, get editMode() { return editMode; } };
})();
