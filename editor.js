/* Lowline tab editor + PDF download (uses app.js globals: notes, buildTab, playClip, strings, stringNames, rhythmState,
 * nowTime, curPos, playing, getAC, fmt, toast, tabInfo, midiName, showNames...).
 *
 * Edit mode: click a note to select it; the note panel edits everything about it: pitch, string/fret position, start,
 * length, technique. Every change plays the note as a synthesized bass tone, and a note you changed or added always plays
 * as that tone when clicked (the recording still has the old sound). A position choice is kept by locking that note's
 * string/fret in the fingering engine.
 * Keys: Up/Down semitone, Left/Right one 16th earlier/later, Delete, N add, Ctrl+Z undo, Esc done.
 */
(function () {
  'use strict';
  let editMode = false, sel = null;
  const undo = [];
  const $ = id => document.getElementById(id);
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const nameOf = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const LENS = [[1, '16th'], [2, '8th'], [3, 'dotted 8th'], [4, 'quarter'], [6, 'dotted quarter'], [8, 'half'], [12, 'dotted half'], [16, 'whole']];
  const TECH = [['none', 'Plucked (normal)'], ['legato', 'Hammer-on / pull-off from the note before'], ['slide', 'Slide to another note'],
    ['slideInUp', 'Slide in from below'], ['slideInDown', 'Slide in from above'], ['slideOutDown', 'Slide off, down'], ['slideOutUp', 'Slide off, up'],
    ['slap', 'Slap / pop'], ['vibrato', 'Vibrato'], ['mute', 'Dead note (x)']];
  const p16 = () => 15 / rhythmState.bpm;

  // the fingering engine honours locks: {noteIndex: {s, f}}
  const origAssign = LowlineFingering.assign;
  LowlineFingering.assign = function (ns, open, opts) {
    const locks = Object.assign({}, (opts && opts.locks) || {});
    ns.forEach((n, i) => { if (n.lock) locks[i] = n.lock; });
    return origAssign.call(this, ns, open, Object.assign({}, opts || {}, { locks }));
  };
  // clicking a note: select it in edit mode; a changed/added note plays its NEW pitch (the recording has the old one)
  const origClip = playClip;
  playClip = function (t0, t1, i) {
    const n = i != null ? notes[i] : null;
    if (editMode && n) select(n);
    if (n && n.edited && !n.mute) { if (typeof pause === 'function' && playing) pause(); return tone(n.midi, n.slideTo); }
    return origClip(t0, t1, i);
  };
  const origBuild = buildTab;
  buildTab = function () { origBuild(); mark(); };

  function tone(midi, slideTo) {
    try {
      const ac = getAC(); if (ac.state === 'suspended') ac.resume();
      const hz = m => 440 * Math.pow(2, (m - 69) / 12), t = ac.currentTime, g = ac.createGain(), len = slideTo != null ? 0.9 : 0.7;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      g.connect(ac.destination);
      [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]].forEach(([h, type, a]) => {
        const o = ac.createOscillator(), og = ac.createGain(); o.type = type; o.frequency.setValueAtTime(hz(midi) * h, t);
        if (slideTo != null) { o.frequency.setValueAtTime(hz(midi) * h, t + 0.2); o.frequency.linearRampToValueAtTime(hz(slideTo) * h, t + 0.45); }
        og.gain.value = a; o.connect(og); og.connect(g); o.start(t); o.stop(t + len + 0.05);
      });
    } catch (e) { /* no audio: fine */ }
  }
  function snapshot() { undo.push({ notes: notes.map(n => Object.assign({}, n, { lock: n.lock ? Object.assign({}, n.lock) : undefined })), sel: notes.indexOf(sel) }); if (undo.length > 200) undo.shift(); }
  // ---- "fix once, apply to all repeats": the edited note's neighbourhood (3 notes each side, pitches + gaps) is looked
  // for elsewhere in the song; the same change can then be applied to every match in one step (one undo) ----
  let pendingKind = 'mod', lastEdit = null;
  const SIGK = 3, pkey = n => (n.mute ? 'x' : n.midi);
  const DIFF = ['midi', 'mf', 'lock', 'dur', 'technique', 'slideTo', 'slideIn', 'slideOut', 'slap', 'vibrato', 'mute'];
  function sigAt(arr, i) {
    const out = [];
    for (let o = -SIGK; o <= SIGK; o++) { const q = arr[i + o]; if (!q) continue; const nx = arr[i + o + 1]; out.push({ o, p: pkey(q), g: o < SIGK && nx ? nx.time - q.time : null }); }
    return out;
  }
  function matchAt(sig, i) {
    for (const { o, p, g } of sig) {
      const q = notes[i + o]; if (!q || pkey(q) !== p) return false;
      const nx = notes[i + o + 1]; if (g != null && nx && Math.abs(nx.time - q.time - g) > Math.max(0.06, 0.3 * g)) return false;
    }
    return true;
  }
  const findAll = (sig, skip) => { const r = []; for (let i = 0; i < notes.length; i++) if (!skip(notes[i]) && matchAt(sig, i)) r.push(notes[i]); return r; };
  function recordEdit() {
    const u = undo[undo.length - 1], kind = pendingKind; pendingKind = 'mod'; lastEdit = null;
    if (!u || kind === 'none') return;
    const pre = u.notes;
    if (kind === 'mod' && sel && u.sel >= 0) {
      const p = pre[u.sel], diff = {};
      DIFF.forEach(k => { if (JSON.stringify(p[k]) !== JSON.stringify(sel[k])) diff[k] = sel[k] === undefined ? undefined : JSON.parse(JSON.stringify(sel[k])); });
      const dt = sel.time - p.time; if (!Object.keys(diff).length && Math.abs(dt) < 1e-6) return;
      const targets = findAll(sigAt(pre, u.sel), q => q === sel);
      if (targets.length) lastEdit = { kind, diff, dt, targets };
    } else if (kind === 'del' && u.sel >= 0) {
      const targets = findAll(sigAt(pre, u.sel), () => false);
      if (targets.length) lastEdit = { kind, targets };
    } else if (kind === 'add' && sel) {
      let a = -1; pre.forEach((q, i) => { if (q.time <= sel.time + 1e-6) a = i; });
      if (a < 0) return;
      const at = pre[a].time, targets = findAll(sigAt(pre, a), q => Math.abs(q.time - at) < 1e-6);
      const tpl = {}; KEEP.forEach(k => { if (sel[k] !== undefined) tpl[k] = JSON.parse(JSON.stringify(sel[k])); });
      if (targets.length) lastEdit = { kind, targets, offset: sel.time - at, tpl };
    }
  }
  function applyAll() {
    const e = lastEdit; if (!e) return; snapshot(); pendingKind = 'none';
    if (e.kind === 'mod') e.targets.forEach(t => { Object.keys(e.diff).forEach(k => { if (e.diff[k] === undefined) delete t[k]; else t[k] = JSON.parse(JSON.stringify(e.diff[k])); }); t.time = Math.max(0, t.time + e.dt); t.edited = true; t.confidence = 1; });
    else if (e.kind === 'del') e.targets.forEach(t => { const i = notes.indexOf(t); if (i >= 0) notes.splice(i, 1); });
    else if (e.kind === 'add') e.targets.forEach(t => notes.push(Object.assign(JSON.parse(JSON.stringify(e.tpl)), { time: t.time + e.offset })));
    notes.sort((a, b) => a.time - b.time);
    const n = e.targets.length; lastEdit = null; changed(false); toast(`Applied to ${n} more place${n > 1 ? 's' : ''}.`);
  }
  // ---- unsure notes: the ones the analysis doubts ('?') and you have not touched yet ----
  const unsure = () => notes.filter(n => (n.confidence == null || n.confidence < 0.75) && !n.edited);
  function nextUnsure(dir) {
    const list = unsure(); if (!list.length) return toast('No unsure notes left. ✓');
    const ref = sel ? sel.time : curPos;
    let n = dir < 0 ? list.filter(q => q.time < ref - 1e-3).pop() : list.find(q => q.time > ref + 1e-3);
    if (!n) n = dir < 0 ? list[list.length - 1] : list[0];               // wrap around
    select(n); setPosition(n.time); const i = notes.indexOf(n); origClip(n.time, n.time + (n.dur || 0.2), i);
  }
  function changed(play) {
    if (sel) { sel.confidence = 1; sel.edited = true; }
    buildTab(); saveSoon(); recordEdit();
    $('noteCount').textContent = `· ${notes.length} NOTES`;
    if (play && sel && !sel.mute) tone(sel.midi, sel.slideTo);
    panel();
  }
  function select(n) { sel = n; mark(); panel(); }
  function mark() {
    document.querySelectorAll('.tab-note.selected').forEach(e => e.classList.remove('selected'));
    if (!editMode || !sel) return;
    const i = notes.indexOf(sel); if (i < 0) { sel = null; return; }
    const el = document.querySelector(`.tab-note[data-index="${i}"]:not(.slide-end)`); if (el) el.classList.add('selected');
  }
  // every string/fret where a pitch can be played (notes below the low string an octave up, like the fingering engine)
  function positions(m) {
    const open = strings(), low = Math.min(...open); let up = 0;
    while (m + up < low && up < 24) up += 12;
    return open.map((o, s) => ({ s, f: m + up - o, up })).filter(p => p.f >= 0 && p.f <= 24);
  }
  function techOf(n) {
    if (n.mute) return 'mute'; if (n.slideTo != null) return 'slide'; if (n.technique === 'legato') return 'legato';
    if (n.slideIn) return n.slideIn === 'up' ? 'slideInUp' : 'slideInDown'; if (n.slideOut) return n.slideOut === 'up' ? 'slideOutUp' : 'slideOutDown';
    if (n.slap) return 'slap'; if (n.vibrato) return 'vibrato'; return 'none';
  }
  const opt = (v, label, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
  const noteOptions = cur => { let h = ''; for (let m = 64; m >= 21; m--) h += opt(m, nameOf(m), cur); return h; };

  function hasSaved() { const b = $('resetEdits'); return b ? !b.hidden : savedFlag; }
  function panel() {
    const box = $('editBar'); if (!box) return;
    if (!editMode) { box.hidden = true; return; }
    box.hidden = false;
    const nU = unsure().length;
    const rep = lastEdit ? `<div class="ed-repeat">↻ The same spot repeats <b>${lastEdit.targets.length}</b> more time${lastEdit.targets.length > 1 ? 's' : ''} in this song. <button data-op="applyAll">Apply this change to all ${lastEdit.targets.length}</button><button data-op="dismissRepeat">No, only here</button></div>` : '';
    const tools = `<span class="ed-actions"><button data-op="prevUnsure" title="Previous unsure note (Shift+U)"${nU ? '' : ' disabled'}>◀ ?</button><button data-op="nextUnsure" title="Next unsure note (U)"${nU ? '' : ' disabled'}>Next unsure ▶ <small>${nU}</small></button><button data-op="add">+ Add note</button><button data-op="undo">↶ Undo</button><button data-op="reset" id="resetEdits"${hasSaved() ? '' : ' hidden'} title="Throw away your edits for this song">Reset to detected</button></span>`;
    if (!sel || notes.indexOf(sel) < 0) { box.innerHTML = `${rep}<p class="ed-hint">Click a note to edit it, jump to the notes the app is unsure about, or add one at the playhead.</p>${tools}`; wire(); return; }
    const n = sel, len = Math.max(1, Math.round(n.dur / p16())), tech = techOf(n), pos = n.mute ? [] : positions(n.midi);
    const curPosKey = n.string != null ? `${n.string}:${n.fret}` : '';
    box.innerHTML = `${rep}
      <div class="ed-field"><label>Note</label><span class="row"><button data-op="pitch" data-v="-1" title="Down a semitone (↓)">−</button>
        <select data-op="note" ${n.mute ? 'disabled' : ''}>${noteOptions(n.midi)}</select><button data-op="pitch" data-v="1" title="Up a semitone (↑)">+</button></span></div>
      <div class="ed-field"><label>String &amp; fret</label><select data-op="pos" ${n.mute ? 'disabled' : ''}>${pos.map(p => opt(`${p.s}:${p.f}`, `${stringNames()[p.s]} string · fret ${p.f}${p.up ? ' (8va)' : ''}`, curPosKey)).join('')}</select></div>
      <div class="ed-field"><label>Starts at</label><span class="row"><button data-op="time" data-v="-1" title="One 16th earlier (←)">◀</button><output>${fmt(n.time)}.${String(Math.floor((n.time % 1) * 100)).padStart(2, '0')}</output><button data-op="time" data-v="1" title="One 16th later (→)">▶</button></span></div>
      <div class="ed-field"><label>Length</label><select data-op="len">${LENS.map(([u, l]) => opt(u, l, LENS.some(x => x[0] === len) ? len : 2)).join('')}</select></div>
      <div class="ed-field"><label>Technique</label><select data-op="tech">${TECH.map(([v, l]) => opt(v, l, tech)).join('')}</select></div>
      ${tech === 'slide' ? `<div class="ed-field"><label>Slide to</label><select data-op="slideTo">${noteOptions(n.slideTo)}</select></div>` : ''}
      <span class="ed-actions"><button data-op="hear">▶ Hear</button><button data-op="del">Delete</button>${tools.replace(/^<span class="ed-actions">|<\/span>$/g, '')}</span>`;
    wire();
  }
  function wire() {
    $('editBar').querySelectorAll('[data-op]').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'onchange' : 'onclick';
      el[ev] = () => { const op = el.dataset.op, v = el.tagName === 'SELECT' ? el.value : el.dataset.v; ops[op](v != null ? v : undefined); };
    });
  }
  const ops = {
    pitch(d) { if (!sel || sel.mute) return; ops.note(sel.midi + (+d)); },
    note(m) {
      m = +m; if (!sel || sel.mute || m === sel.midi) return; snapshot();
      const d = m - sel.midi; sel.midi = m; sel.mf = m; if (sel.slideTo != null) sel.slideTo += d;
      const keep = positions(m).find(p => p.s === sel.string);           // stay on the same string when it can
      if (keep) sel.lock = { s: keep.s, f: keep.f }; else delete sel.lock;
      changed(true);
    },
    pos(v) { if (!sel) return; const [s, f] = v.split(':').map(Number); snapshot(); sel.lock = { s, f }; changed(true); },
    time(d) { if (!sel) return; snapshot(); sel.time = Math.max(0, sel.time + (+d) * p16()); notes.sort((a, b) => a.time - b.time); changed(true); },
    len(u) { if (!sel) return; snapshot(); sel.dur = (+u) * p16() * 0.98; changed(false); },
    tech(v) {
      if (!sel) return; snapshot();
      const n = sel;
      delete n.slideTo; delete n.slideToF; delete n.slideCut; delete n.slideIn; delete n.slideOut; n.slap = false; n.vibrato = false; n.technique = null;
      if (n.mute && v !== 'mute') { n.mute = false; if (n.midi == null || isNaN(n.midi)) { const pv = notes.filter(q => !q.mute && q.time < n.time).pop(); n.midi = pv ? pv.midi : 40; } n.mf = n.midi; }
      if (v === 'legato') n.technique = 'legato';
      else if (v === 'slide') { n.slideTo = n.midi + 2; n.technique = 'slide'; }
      else if (v === 'slideInUp') n.slideIn = 'up'; else if (v === 'slideInDown') n.slideIn = 'down';
      else if (v === 'slideOutDown') n.slideOut = 'down'; else if (v === 'slideOutUp') n.slideOut = 'up';
      else if (v === 'slap') n.slap = true; else if (v === 'vibrato') n.vibrato = true;
      else if (v === 'mute') { n.mute = true; n.technique = 'muted'; delete n.lock; }
      changed(v !== 'mute');
    },
    slideTo(m) { if (!sel) return; snapshot(); sel.slideTo = +m; changed(true); },
    hear() { if (sel && !sel.mute) tone(sel.midi, sel.slideTo); },
    del() { if (!sel) return; snapshot(); pendingKind = 'del'; const i = notes.indexOf(sel); notes.splice(i, 1); sel = notes[Math.min(i, notes.length - 1)] || null; changed(false); },
    add() {
      snapshot(); pendingKind = 'add';
      const t = playing ? nowTime() : curPos, prev = notes.filter(n => !n.mute && n.time <= t).pop() || notes.find(n => !n.mute);
      const m = sel && !sel.mute ? sel.midi : prev ? prev.midi : 40;
      const n = { time: t, midi: m, mf: m, dur: 2 * p16() * 0.98, confidence: 1, edited: true, added: true, technique: null };
      notes.push(n); notes.sort((a, b) => a.time - b.time); sel = n; changed(true);
    },
    undo() { const u = undo.pop(); if (!u) return toast('Nothing to undo.'); pendingKind = 'none'; notes = u.notes; sel = notes[u.sel] || null; changed(false); },
    reset() { resetEdits(); },
    applyAll() { applyAll(); },
    dismissRepeat() { lastEdit = null; panel(); },
    nextUnsure() { nextUnsure(1); },
    prevUnsure() { nextUnsure(-1); }
  };
  // ---- edits are saved in this browser per song file (IndexedDB 'lowline-edits'), restored when the same file is opened ----
  const KEEP = ['time', 'dur', 'midi', 'mf', 'mute', 'technique', 'slideTo', 'slideToF', 'slideIn', 'slideOut', 'slap', 'vibrato', 'confidence', 'lock', 'edited', 'added', 'level'];
  let original = null, saveTimer = 0, dirty = false, savedFlag = false;
  function db() { return new Promise((res, rej) => { const q = indexedDB.open('lowline-edits', 1); q.onupgradeneeded = () => q.result.createObjectStore('songs'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  async function idb(mode, fn) { const d = await db(); return new Promise(r => { const t = d.transaction('songs', mode), q = fn(t.objectStore('songs')); t.oncomplete = () => r(q && q.result); t.onerror = t.onabort = () => r(null); }); }
  const pack = ns => ns.map(n => { const o = {}; KEEP.forEach(k => { if (n[k] !== undefined && n[k] !== null && n[k] !== false) o[k] = n[k]; }); return o; });
  function saveSoon() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  async function saveNow() {
    const key = window.songKey; if (!key || !dirty) return; dirty = false;
    try { await idb('readwrite', st => st.put({ v: 1, t: Date.now(), notes: pack(notes), rhythm: { bpm: rhythmState.bpm, origin: rhythmState.origin, sig: rhythmState.sig, shiftBeats: rhythmState.shiftBeats, auto: rhythmState.auto } }, key)); setSaved(true); }
    catch (e) { toast('Could not save your edits in this browser.'); }
  }
  function setSaved(has) { savedFlag = has; const b = $('resetEdits'); if (b) b.hidden = !has; }
  async function restore(key) {
    original = notes.map(n => Object.assign({}, n)); undo.length = 0; sel = null;
    let v = null; try { v = key ? await idb('readonly', st => st.get(key)) : null; } catch (e) { v = null; }
    if (!v || !v.notes || !v.notes.length) { setSaved(false); return false; }
    notes = v.notes.map(o => Object.assign({}, o));
    if (v.rhythm) Object.assign(rhythmState, v.rhythm);
    setSaved(true); toast('Your edits for this song were restored.');
    return true;
  }
  async function resetEdits() {
    if (!original) return; if (!confirm('Throw away your edits for this song and go back to the detected notes?')) return;
    snapshot(); notes = original.map(n => Object.assign({}, n)); sel = null;
    try { await idb('readwrite', st => st.delete(window.songKey)); } catch (e) {}
    dirty = false; setSaved(false); autoRhythm(); buildTab(); $('noteCount').textContent = `· ${notes.length} NOTES`; panel(); toast('Back to the detected notes.');
  }
  // tempo / time signature / bar-line changes are part of the edit too
  ['bpmInput', 'sigSelect', 'autoTempoBtn', 'barPrevBtn', 'barNextBtn'].forEach(id => { const el = $(id); if (el) el.addEventListener(el.tagName === 'BUTTON' ? 'click' : 'change', () => { if (window.songKey && (dirty || $('resetEdits') && !$('resetEdits').hidden || editMode)) saveSoon(); }); });
  window.addEventListener('pagehide', () => { if (dirty) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) saveNow(); });

  function setMode(on) {
    editMode = on; document.body.classList.toggle('editing', on);
    $('editBtn').setAttribute('aria-pressed', on); $('editBtn').textContent = on ? '✓ Done' : '✎ Edit';
    if (!on) sel = null; mark(); panel();
  }
  $('editBtn').onclick = () => setMode(!editMode);
  document.addEventListener('keydown', e => {
    if (!editMode || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const k = e.key; let done = true;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') ops.undo();
    else if (k === 'ArrowUp') ops.pitch(1);
    else if (k === 'ArrowDown') ops.pitch(-1);
    else if (k === 'ArrowLeft') ops.time(-1);
    else if (k === 'ArrowRight') ops.time(1);
    else if (k === 'Delete' || k === 'Backspace') ops.del();
    else if (k.toLowerCase() === 'n') ops.add();
    else if (k.toLowerCase() === 'u') nextUnsure(e.shiftKey ? -1 : 1);
    else if (k === 'Escape') setMode(false);
    else done = false;
    if (done) e.preventDefault();
  });

  // ---- PDF: options window with a live preview, vector drawing (pdfexport.js), direct download ----
  function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  const songTitle = () => $('trackName').textContent.replace(/\s+—\s+(your bassline|Lowline session)$/, '').replace(/\.(mp3|wav|m4a|ogg|flac)$/i, '').replace(/[_]+/g, ' ').replace(/^\d+\.\s*/, '').trim();
  let pdfUrl = null, pdfDoc = null, pdfTimer = 0;
  const fileName = o => (o.title || 'Bass').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' - Bass Tab.pdf';
  function readOpts() {
    const f = new FormData($('pdfForm')), on = k => f.get(k) === 'on';
    return { title: (f.get('title') || '').trim(), artist: (f.get('artist') || '').trim(), comment: (f.get('comment') || '').trim(), info: on('info'),
      notation: on('notation'), rhythm: on('rhythm'), names: on('names'), fingers: on('fingers'), bars: on('bars'), legend: on('legend'), credit: on('credit'),
      page: f.get('page'), orient: f.get('orient') };
  }
  async function makePdf(o) {
    await loadScript('vendor/jspdf.umd.min.js'); await loadScript('pdfexport.js');
    const beatSec = 60 / rhythmState.bpm;
    const rh = LowlineRhythm.build(notes, { bpm: rhythmState.bpm, origin: rhythmState.origin + rhythmState.shiftBeats * beatSec, sig: rhythmState.sig });
    return LowlinePdf.build(o, { notes, rh, names: stringNames(), openMidis: strings(), bpm: rhythmState.bpm, sig: rhythmState.sig });
  }
  async function preview() {
    const st = $('pdfStatus'); st.textContent = 'Updating preview…';
    try {
      const t0 = performance.now(), o = readOpts(); pdfDoc = await makePdf(o);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl = URL.createObjectURL(pdfDoc.output('blob'));
      $('pdfPreview').src = pdfUrl + '#toolbar=0&navpanes=0&view=FitH'; $('pdfOpen').href = pdfUrl;
      st.textContent = `${pdfDoc.getNumberOfPages()} page${pdfDoc.getNumberOfPages() > 1 ? 's' : ''} · ${fileName(o)} · made in ${Math.round(performance.now() - t0)} ms`;
    } catch (err) { st.textContent = 'Could not make the PDF: ' + (err.message || err); }
  }
  function openPdfDialog() {
    if (!notes.length || !tabInfo) return toast('Load a song first.');
    const d = $('pdfDialog'), t = d.querySelector('[name=title]');
    if (!t.value || t.dataset.auto === '1') { t.value = songTitle(); t.dataset.auto = '1'; }
    d.querySelector('[name=notation]').checked = viewMode !== 'tab';
    d.hidden = false; preview();
  }
  $('pdfBtn').onclick = openPdfDialog;
  $('pdfCancel').onclick = () => { $('pdfDialog').hidden = true; };
  $('pdfForm').addEventListener('input', e => { if (e.target.name === 'title') e.target.dataset.auto = '0'; clearTimeout(pdfTimer); pdfTimer = setTimeout(preview, 350); });
  $('pdfForm').addEventListener('change', () => { clearTimeout(pdfTimer); pdfTimer = setTimeout(preview, 150); });
  $('pdfForm').onsubmit = async e => {
    e.preventDefault();
    const o = readOpts(); if (!pdfDoc) await preview();
    pdfDoc.save(fileName(o)); $('pdfStatus').textContent = 'Saved: ' + fileName(o);
  };
  window.LowlineEditor = { ops, select, setMode, makePdf, preview, restore, saveNow, saveSoon, get lastEdit() { return lastEdit; }, positions, get sel() { return sel; }, get editMode() { return editMode; } };
})();
