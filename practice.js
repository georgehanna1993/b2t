/* Lowline practice tools (uses app.js globals: play, pause, playing, speed, nowTime, curPos, setPosition, seek, getAC, recOut,
 * audio, notes, tabInfo, lastRh, rhythmState, loopOn, loopStart, loopEnd, buildTab, toast).
 *  - Loop bars: drag across the tab (or press "Loop bars" and tap the first and last bar); the bars are shaded and repeat.
 *  - Click: a metronome on every beat (accent on the first beat of each bar); Count-in: one bar of clicks before playing.
 *  - Speed: 40-100 % (pitch kept; below 100 % the <audio> element plays, at 100 % Web Audio).
 *  - Hear tab: the tab played by a synth bass, with the song or alone ("tab only" mutes the recording).
 * Clicks and synth notes are scheduled ~0.2 s ahead on the Web Audio clock from the song position, so they follow seeks,
 * loops and speed changes.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem('lowline.' + k); localStorage.setItem('lowline.' + k, v); } catch (e) { return null; } };
  let clickOn = store('click') === '1', countIn = store('countIn') === '1', tabMode = store('tabSound') || 'off';
  let loopBars = null, armed = null, counting = false;

  // ---------- sound ----------
  let master = null;
  function out() { const ac = getAC(); if (!master) { master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination); } return master; }
  const live = [];
  function keep(node, end) { live.push(node); node.onended = () => { const i = live.indexOf(node); if (i >= 0) live.splice(i, 1); }; node.stop(end); }
  function clickAt(when, accent) {
    const ac = getAC(), o = ac.createOscillator(), g = ac.createGain();
    o.type = 'square'; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.22, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    o.connect(g); g.connect(out()); o.start(when); keep(o, when + 0.06);
  }
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  function bassAt(when, midi, len, slideTo, mute) {
    const ac = getAC(), g = ac.createGain(), end = when + Math.max(0.08, len);
    g.connect(out());
    if (mute) { // dead note: a short muted thump
      const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 70;
      g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.35, when + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
      o.connect(g); o.start(when); keep(o, when + 0.09); return;
    }
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.42, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.18, when + Math.min(0.25, len * 0.6)); g.gain.setValueAtTime(0.18, Math.max(when + 0.01, end - 0.03)); g.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, when); lp.frequency.exponentialRampToValueAtTime(500, when + 0.25); lp.connect(g);
    [[1, 'sawtooth', 0.35], [1, 'triangle', 0.8], [2, 'sine', 0.25]].forEach(([h, type, a]) => {
      const o = ac.createOscillator(), og = ac.createGain(); o.type = type; o.frequency.setValueAtTime(hz(midi) * h, when);
      if (slideTo != null) { o.frequency.setValueAtTime(hz(midi) * h, when + len * 0.25); o.frequency.linearRampToValueAtTime(hz(slideTo) * h, when + len * 0.8); }
      og.gain.value = a; o.connect(og); og.connect(lp); o.start(when); keep(o, end + 0.02);
    });
  }
  function silence() { live.splice(0).forEach(n => { try { n.onended = null; n.stop(); } catch (e) { } }); }

  // ---------- song timeline ----------
  function grid() {
    const rh = window.lastRh; if (!rh) return null; const p = 15 / rhythmState.bpm;
    return { origin: rh.origin, beat: rh.beatU * p, perBar: Math.max(1, Math.round(rh.barU / rh.beatU)), bar: rh.barU * p, bars: rh.bars };
  }
  const barTime = b => { const g = grid(); return g.origin + b * g.bar; };

  // ---------- scheduler ----------
  let timer = 0, horizon = 0;
  function startSched() { stopSched(); horizon = nowTime(); applyMix(); timer = setInterval(tick, 25); tick(); }
  function stopSched() { clearInterval(timer); timer = 0; silence(); }
  function tick() {
    if (!playing) return stopSched();
    const ac = getAC(), now = nowTime(), acNow = ac.currentTime, ahead = 0.2 * speed;
    let until = now + ahead; if (loopOn && loopEnd > loopStart && until > loopEnd) until = loopEnd;
    if (until <= horizon) return;
    const at = t => acNow + Math.max(0, t - now) / speed;
    const g = grid();
    if (clickOn && g) {
      for (let k = Math.ceil((horizon - g.origin) / g.beat - 1e-6); ; k++) {
        const t = g.origin + k * g.beat; if (t >= until) break; if (t < horizon) continue;
        clickAt(at(t), ((k % g.perBar) + g.perBar) % g.perBar === 0);
      }
    }
    if (tabMode !== 'off') {
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i]; if (n.time < horizon) continue; if (n.time >= until) break;
        const next = notes[i + 1], len = Math.min(n.dur || 0.2, next ? next.time - n.time : 9) / speed;
        bassAt(at(n.time), n.midi, len * 0.97, n.slideTo != null && !n.slideCut ? n.slideTo : null, n.mute);
      }
    }
    horizon = until;
  }
  function applyMix() {
    const only = tabMode === 'only';
    try { recOut().gain.value = only ? 0 : 1; } catch (e) { }
    audio.muted = only;
  }
  // follow play / pause / seek: app.js calls these globals, so wrapping them is enough
  const origPlay = play, origPause = pause;
  play = async function () {
    if (!playing && loopOn && loopEnd > loopStart && (curPos < loopStart - 0.01 || curPos >= loopEnd)) setPosition(loopStart);
    await origPlay.apply(this, arguments);
    if (playing) startSched();
  };
  pause = function () { stopSched(); counting = false; return origPause.apply(this, arguments); };

  // count-in: one bar of clicks, then the song starts on the next downbeat
  function playWithCountIn() {
    const g = grid(); if (!g || !audio.src) return play();
    counting = true; $('playBtn').classList.add('counting');
    const ac = getAC(); if (ac.state === 'suspended') ac.resume();
    const beat = g.beat / speed, t0 = ac.currentTime + 0.1;
    for (let i = 0; i < g.perBar; i++) clickAt(t0 + i * beat, i === 0);
    setTimeout(() => { $('playBtn').classList.remove('counting'); if (counting) { counting = false; play(); } }, (0.1 + g.perBar * beat) * 1000 - 15);
  }
  $('playBtn').onclick = () => { if (playing || counting) { counting = false; $('playBtn').classList.remove('counting'); return pause(); } countIn ? playWithCountIn() : play(); };
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) || !notes.length) return;
    e.preventDefault(); $('playBtn').click();
  });

  // ---------- loop bars ----------
  function barAt(x) { const s = (tabInfo && tabInfo.barStarts) || []; let b = 0; for (let i = 0; i < s.length; i++) if (s[i] <= x) b = i; return b; }
  function setLoop(b1, b2) {
    const g = grid(); if (!g) return;
    if (b2 < b1) [b1, b2] = [b2, b1];
    loopBars = { b1, b2 }; loopStart = barTime(b1); loopEnd = barTime(b2 + 1); loopOn = true;
    drawLoop(); syncLoopUi();
    if (!playing) setPosition(loopStart);
  }
  function clearLoop() { loopBars = null; loopOn = false; armed = null; drawLoop(); syncLoopUi(); }
  function syncLoopUi() {
    const b = $('loopBtn');
    b.setAttribute('aria-pressed', !!loopBars || !!armed);
    b.textContent = loopBars ? (loopBars.b1 === loopBars.b2 ? `⟲ Bar ${loopBars.b1 + 1}` : `⟲ Bars ${loopBars.b1 + 1}–${loopBars.b2 + 1}`) : armed ? (armed.first == null ? 'Tap the first bar…' : 'Tap the last bar…') : '⟲ Loop bars';
    $('loopClear').hidden = !loopBars && !armed;
    document.body.classList.toggle('loop-armed', !!armed);
  }
  function drawLoop(preview) {
    const gridEl = $('tabGrid'); gridEl.querySelectorAll('.loop-zone').forEach(e => e.remove());
    const sel = preview || loopBars; if (!sel || !tabInfo || !tabInfo.barStarts) return;
    const s = tabInfo.barStarts, lo = Math.min(sel.b1, sel.b2), hi = Math.max(sel.b1, sel.b2), x1 = s[lo], x2 = hi + 1 < s.length ? s[hi + 1] : tabInfo.width - 40;
    const z = document.createElement('div'); z.className = 'loop-zone' + (preview ? ' preview' : ''); z.style.left = x1 + 'px'; z.style.width = (x2 - x1) + 'px';
    gridEl.appendChild(z);
  }
  const origBuild = buildTab;
  buildTab = function () {
    origBuild();
    if (loopBars) { const g = grid(); if (g && loopBars.b2 < g.bars) { loopStart = barTime(loopBars.b1); loopEnd = barTime(loopBars.b2 + 1); } else clearLoop(); }
    drawLoop();
  };
  // mouse/pen: drag across the tab; any pointer: tap two bars after pressing "Loop bars"
  (() => {
    const scroller = $('tabScroll'); let down = null;
    const gx = e => e.clientX - $('tabGrid').getBoundingClientRect().left;
    scroller.addEventListener('pointerdown', e => {
      if (!tabInfo || e.button !== 0 || (!armed && e.target.closest('.tab-note,.mark-hit,button'))) return;   // while choosing bars, a tap on a note counts too
      down = { x: gx(e), id: e.pointerId, moved: false, touch: e.pointerType === 'touch' };
      if (e.pointerType !== 'touch') { try { scroller.setPointerCapture(e.pointerId); } catch (_) { } }
    });
    scroller.addEventListener('pointermove', e => {
      if (!down || down.touch || e.pointerId !== down.id) return;
      if (!down.moved && Math.abs(gx(e) - down.x) < 8) return;
      down.moved = true; e.preventDefault(); drawLoop({ b1: barAt(down.x), b2: barAt(gx(e)) });
    });
    const up = e => {
      if (!down || e.pointerId !== down.id) return;
      const x = gx(e), d = down; down = null;
      if (d.moved) return setLoop(barAt(d.x), barAt(x));
      if (armed) { const b = barAt(x); if (armed.first == null) { armed.first = b; drawLoop({ b1: b, b2: b }); syncLoopUi(); } else { const f = armed.first; armed = null; setLoop(f, b); } }
    };
    scroller.addEventListener('pointerup', up); window.addEventListener('pointerup', up); scroller.addEventListener('pointercancel', () => { down = null; drawLoop(); });
  })();
  $('loopBtn').onclick = () => {
    if (!notes.length) return toast('Load a song first.');
    if (loopBars) { loopOn = !loopOn; $('loopBtn').setAttribute('aria-pressed', loopOn); $('tabGrid').classList.toggle('loop-off', !loopOn); return; }
    armed = armed ? null : { first: null }; syncLoopUi();
    if (armed) toast('Tap the first bar, then the last bar (or drag across the tab).');
  };
  $('loopClear').onclick = clearLoop;

  // ---------- click / count-in / hear tab / speed ----------
  const press = (id, on) => $(id).setAttribute('aria-pressed', on);
  press('clickBtn', clickOn); press('countBtn', countIn); $('tabSound').value = tabMode;
  $('clickBtn').onclick = () => { clickOn = !clickOn; store('click', clickOn ? '1' : '0'); press('clickBtn', clickOn); if (playing) startSched(); };
  $('countBtn').onclick = () => { countIn = !countIn; store('countIn', countIn ? '1' : '0'); press('countBtn', countIn); };
  $('tabSound').onchange = e => { tabMode = e.target.value; store('tabSound', tabMode); applyMix(); if (playing) startSched(); };
  const sr = $('speedRange');
  sr.oninput = () => {
    $('speedOut').textContent = sr.value + '%';
    const was = playing; if (was) pause();
    speed = +sr.value / 100; if (audio.src) { audio.playbackRate = speed; audio.preservesPitch = true; }
    if (was) play();
  };
  applyMix();
  window.LowlinePractice = { setLoop, clearLoop, get loopBars() { return loopBars; }, get state() { return { clickOn, countIn, tabMode, scheduled: live.length }; } };
})();
