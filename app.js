const audio=document.getElementById('audioPlayer'),fileInput=document.getElementById('fileInput'),dropzone=document.getElementById('dropzone'),waveform=document.getElementById('waveform'),canvas=document.getElementById('waveCanvas'),ctx=canvas.getContext('2d');
const tuningSelect=document.getElementById('tuningSelect');
let notes=[],notePositions=[],rowLabels=[],duration=8,currentIndex=-1,playing=false,speed=1,raf=0,objectUrl=null,demoUrl=null,decoded=null,customDuration=8,loopOn=false,loopStart=0,loopEnd=0,showNames=false,showBars=false,toastTimer;
const noteNames=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const demoMidi=[40,40,43,45,47,45,43,40,40,40,43,45,47,50,47,45,43,43,45,47,45,43,40,38,40,40,43,45,47,45,43,40];
const demoTimes=demoMidi.map((m,i)=>({time:i*.5,midi:m,dur:.43,confidence:i%7===5?.66:.91}));
function midiName(m){return noteNames[((m%12)+12)%12]+(Math.floor(m/12)-1)}
function fmt(t){if(!isFinite(t))t=0;return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`}
const TUNINGS={E:{m:[28,33,38,43],n:['E','A','D','G']},D:{m:[26,31,36,41],n:['D','G','C','F']},dropD:{m:[26,33,38,43],n:['D','A','D','G']},B5:{m:[23,28,33,38,43],n:['B','E','A','D','G']}};
function strings(){return (TUNINGS[tuningSelect.value]||TUNINGS.E).m}
let octaveApplied=0;                                              // semitones the current notes are moved from the detected pitch
function applyOctave(){const want=12*(+(document.getElementById('octaveSelect')||{value:0}).value||0),d=want-octaveApplied;if(!d)return;
  notes.forEach(n=>{if(n.mute)return;n.midi+=d;if(n.slideTo!=null)n.slideTo+=d;});octaveApplied=want}
const rhythmState={bpm:100,origin:0,sig:'4/4',shiftBeats:0,conf:0,auto:true};
let noteEnds=[],tabInfo=null,showRhythm=false,showFingers=false,viewMode='tab',clipEnd=null,clipTimer=0;
function stringNames(){return (TUNINGS[tuningSelect.value]||TUNINGS.E).n}
function autoRhythm(){ // estimate tempo + where bar 1 starts from the notes
  if(!notes.length)return;
  const est=LowlineRhythm.estimate(notes);
  Object.assign(rhythmState,{bpm:est.bpm,origin:est.origin,shiftBeats:0,conf:est.confidence,auto:true});
  syncRhythmControls();
}
function syncRhythmControls(){
  const bpm=document.getElementById('bpmInput'),sig=document.getElementById('sigSelect'),hint=document.getElementById('tempoHint');
  if(bpm)bpm.value=Math.round(rhythmState.bpm*10)/10;if(sig)sig.value=rhythmState.sig;
  if(hint)hint.textContent=rhythmState.auto?`auto · ${rhythmState.conf>.6?'confident':'unsure, adjust if bars look off'}`:'manual';
}
function buildTab(){
  const grid=document.getElementById('tabGrid');
  applyOctave();
  LowlineFingering.assign(notes,strings());                       // string + fret + finger, repeated phrases identical
  const beatSec=60/rhythmState.bpm;
  const rh=notes.length?LowlineRhythm.build(notes,{bpm:rhythmState.bpm,origin:rhythmState.origin+rhythmState.shiftBeats*beatSec,sig:rhythmState.sig}):null;
  tabInfo=LowlineTabView.render({grid,notes,rhythm:rh,names:stringNames(),openMidis:strings(),
    opts:{rhythm:showRhythm,bars:showBars,names:showNames,fingers:showFingers,notation:viewMode!=='tab'},midiName,fmt,onSeek:seek,onPlay:playClip});
  notePositions=tabInfo.xs;noteEnds=tabInfo.ends;
  document.getElementById('noteCount').textContent=`· ${notes.length} NOTES`;
  document.getElementById('tabTuning').textContent=stringNames().join(' ');
  highlight(-1);
  if(typeof duration==='number'&&audio)syncTab(nowTime()||0);
}
function playheadX(t){
  const left=LowlineTabView.L.LEFT;
  if(!notes.length||!tabInfo)return left;
  let i=-1;for(let j=0;j<notes.length;j++){if(notes[j].time<=t)i=j;else break}
  if(i<0){return Math.max(left,notePositions[0]-Math.min(60,(notes[0].time-t)*60))}
  const n=notes[i],x=notePositions[i],endX=noteEnds[i],isSlide=n.slideTo!=null;
  if(isSlide&&n.dur>0&&t<n.time+n.dur)return x+(endX-x)*Math.max(0,(t-n.time)/n.dur);
  if(i>=notes.length-1)return endX;
  const s0=isSlide?n.time+n.dur:n.time,f=Math.max(0,Math.min(1,(t-s0)/Math.max(.001,notes[i+1].time-s0)));
  return endX+(notePositions[i+1]-endX)*f;
}
function drawWave(data){let rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);let count=Math.max(1,Math.floor(rect.width/3)),step=Math.max(1,Math.floor(data.length/count)),mid=rect.height/2;for(let i=0;i<count;i++){let a=0;for(let j=0;j<step;j++)a=Math.max(a,Math.abs(data[i*step+j]||0));let h=Math.max(2,a*rect.height*.92);ctx.fillStyle=i/count<(nowTime()/duration)?'#0f3d2e':'#c7bb98';ctx.globalAlpha=i/count<(nowTime()/duration)?.95:.8;ctx.fillRect(i*rect.width/count,mid-h/2,Math.max(1,rect.width/count-1),h)}ctx.globalAlpha=1}
function demoWave(){let n=2200;let a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=Math.abs(Math.sin(i*.078)*Math.sin(i*.021)*.82+Math.sin(i*.018)*.16);return a}
function setWave(data){if(canvas.getBoundingClientRect().width)drawWave(data);else requestAnimationFrame(()=>drawWave(data));document.getElementById('durationLabel').textContent=fmt(duration);}
function highlight(i){currentIndex=i;document.querySelectorAll('.tab-note').forEach(el=>el.classList.toggle('current',+el.dataset.index===i));let n=notes[i];document.querySelector('#mobileCurrent b').textContent=n?`${midiName(n.midi)} · ${n.fret}`:'—';if(n){let el=document.querySelector(`.tab-note[data-index="${i}"]`);}}
// Playback: at 100% speed the decoded audio plays through Web Audio (starts instantly at any point, so seeking, dragging
// and pausing have no lag). Slowed-down speeds need pitch preservation, which only the <audio> element offers.
let waSrc=null,waStart=0,waOffset=0,curPos=0,waBufs={main:null,bass:null};
function getAC(){const AC=window.AudioContext||window.webkitAudioContext;return window.audioContext||(window.audioContext=new AC())}
function curBuf(){return hearBass&&waBufs.bass?waBufs.bass:waBufs.main}
function useWA(){return speed===1&&!!curBuf()}
function startWA(t,dur){const ac=getAC();if(ac.state==='suspended')ac.resume();stopWA();const src=ac.createBufferSource();src.buffer=curBuf();src.connect(ac.destination);
  if(dur!=null)src.start(0,t,dur);else src.start(0,t);waSrc=src;waStart=ac.currentTime;waOffset=t;src.onended=()=>{if(waSrc===src){waSrc=null;curPos=Math.min(duration,t+(dur!=null?dur:duration))}}}
function stopWA(){if(waSrc){const s=waSrc;waSrc=null;s.onended=null;try{s.stop()}catch(e){}}}
function nowTime(){if(waSrc)return Math.min(duration,waOffset+(getAC().currentTime-waStart));if(!audio.paused)return audio.currentTime;return curPos}
function syncTab(t){const view=document.getElementById('tabScroll'),maxScroll=Math.max(0,view.scrollWidth-view.clientWidth),x=playheadX(t);if(tabInfo&&tabInfo.cursor)tabInfo.cursor.style.left=x+'px';view.scrollLeft=Math.max(0,Math.min(maxScroll,x-view.clientWidth*.45))}
function updateTime(){if(!playing)return;let t=nowTime();if(loopOn&&t>=loopEnd&&loopEnd>loopStart){seek(loopStart);t=loopStart}if(t>=duration-0.01){pause();curPos=0;audio.currentTime=0;return}let pct=Math.min(1,t/duration)*100;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);syncTab(t);let idx=-1;for(let i=0;i<notes.length;i++){if(notes[i].time<=t)idx=i;else break}if(idx!==currentIndex)highlight(idx);raf=requestAnimationFrame(updateTime)}
function pause(){curPos=nowTime();playing=false;cancelAnimationFrame(raf);stopWA();audio.pause();document.body.classList.remove('playing');document.getElementById('playBtn').innerHTML='<span>▶</span>'}
async function play(){clipEnd=null;clearTimeout(clipTimer);if(playing)return;if(!audio.src)return toast('Choose the demo or upload a bass track first.');if(useWA()){audio.pause();startWA(curPos)}else{stopWA();try{if(Math.abs(audio.currentTime-curPos)>0.02)audio.currentTime=curPos}catch(e){}audio.playbackRate=speed;audio.preservesPitch=true;try{await audio.play()}catch{toast('Could not start audio. Try pressing play again.');return}}playing=true;document.body.classList.add('playing');document.getElementById('playBtn').innerHTML='<span>Ⅱ</span>';raf=requestAnimationFrame(updateTime)}
function setPosition(t){t=Math.max(0,Math.min(duration,t));curPos=t;if(!useWA()&&audio.src)try{audio.currentTime=t}catch(e){}if(!audio.src)window.lastDemoNote=-1;const pct=duration?t/duration*100:0;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);let i=-1;for(let j=0;j<notes.length;j++)if(notes[j].time<=t)i=j;if(i!==currentIndex)highlight(i);syncTab(t)}
function seek(t){if(playing){pause();setPosition(t);play()}else setPosition(t)}
function buildDemoWav(){const sr=44100,count=Math.ceil(duration*sr),samples=new Float32Array(count);demoTimes.forEach((n,k)=>{const from=Math.floor(n.time*sr),next=demoTimes[k+1]?.time??duration,to=Math.min(count,Math.floor(next*sr)),f=440*Math.pow(2,(n.midi-69)/12);for(let i=from;i<to;i++){const t=(i-from)/sr,attack=Math.min(1,t/.004),env=attack*Math.exp(-t*4.1),tone=Math.sin(2*Math.PI*f*t)*.58+Math.sin(4*Math.PI*f*t)*.25+Math.sin(6*Math.PI*f*t)*.11+Math.sin(8*Math.PI*f*t)*.045;samples[i]+=tone*env*.72}});const ab=new ArrayBuffer(44+count*2),v=new DataView(ab),write=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};write(0,'RIFF');v.setUint32(4,36+count*2,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);return new Blob([ab],{type:'audio/wav'})}
function makeDemo(){pause();waBufs={main:null,bass:null};curPos=0;lastPeaks=null;setBassSwitch(false);decoded=null;duration=16;notes=demoTimes.map(x=>({...x}));octaveApplied=0;loopStart=2;loopEnd=6;if(demoUrl)URL.revokeObjectURL(demoUrl);demoUrl=URL.createObjectURL(buildDemoWav());audio.src=demoUrl;audio.load();audio.currentTime=0;audio.preservesPitch=true;document.getElementById('trackName').innerHTML='Pocket groove <span>—</span> Lowline session';document.getElementById('trackSub').textContent='Demo bass · E standard tuning';document.getElementById('demoPill').style.display='';document.getElementById('playerSection').classList.add('visible');setWave(demoWave());autoRhythm();buildTab();seek(0);}
function toast(s){let t=document.getElementById('toast');t.textContent=s;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
function updateAnalysis(pct,label){try{localStorage.setItem('lowlineRun',JSON.stringify({pct:Math.round(pct),label,t:Date.now(),dev:navigator.userAgent.slice(0,120),mem:navigator.deviceMemory||null,gpu:!!navigator.gpu}))}catch(e){}document.getElementById('analysisBar').style.width=`${pct}%`;document.getElementById('progressPct').textContent=`${Math.round(pct)}%`;document.getElementById('analysisText').textContent=label}
async function analyze(file){
  if(file.size>80*1024*1024)return toast('That file exceeds the 80 MB limit.');
  if(!/\.(wav|wave|mp3|m4a|aac|ogg|oga|flac)$/i.test(file.name)&&!/^audio\//.test(file.type))return toast('Please choose an audio file (MP3 or WAV).');
  pause();window.lowlineBusy=true;
  const sl=document.getElementById('statusText'),progress=document.getElementById('analysisProgress');
  progress.hidden=false;updateAnalysis(2,'Opening audio…');sl.textContent='Analysis runs locally on your device.';
  document.getElementById('dropzone').disabled=true;document.getElementById('demoBtn').disabled=true;
  await new Promise(r=>setTimeout(r,0));
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)throw new Error('Audio decoding is not supported in this browser.');
    const arr=await file.arrayBuffer();
    const full=srcMode==='full';
    if(objectUrl)URL.revokeObjectURL(objectUrl);if(bassUrl)URL.revokeObjectURL(bassUrl);bassUrl=null;
    objectUrl=URL.createObjectURL(file);
    let buf,channels,rate;
    if(full){                                                       // full song: separate the bass first (HTDemucs, 44.1 kHz stereo)
      const off=new OfflineAudioContext(2,1,44100);buf=await off.decodeAudioData(arr.slice(0));
      if(buf.duration>600)throw new Error('Please use a file shorter than ten minutes.');
      const L=buf.getChannelData(0),R=buf.numberOfChannels>1?buf.getChannelData(1):L;
      const bass=await separateBass(L,R,(pct,label)=>updateAnalysis(pct,label),[file.name,file.size,file.lastModified].join('|'));
      channels=[bass.left,bass.right];rate=44100;
      bassUrl=URL.createObjectURL(wavBlob(channels,rate));
    }else{
      const ac=window.audioContext||(window.audioContext=new AC());buf=await ac.decodeAudioData(arr.slice(0));
      if(buf.duration>600)throw new Error('Please use a file shorter than ten minutes.');
      channels=[];for(let c=0;c<buf.numberOfChannels;c++)channels.push(buf.getChannelData(c));rate=buf.sampleRate;
    }
    decoded=full?null:buf;duration=buf.duration;curPos=0;stopWA();
    waBufs.main=buf;waBufs.bass=null;if(full){const bb=getAC().createBuffer(2,channels[0].length,rate);bb.copyToChannel(channels[0],0);bb.copyToChannel(channels[1],1);waBufs.bass=bb}customDuration=duration;loopStart=duration*.2;loopEnd=Math.min(duration,loopStart+4);
    hearBass=full;setSource();setBassSwitch(full);
    const a0=full?72:8;
    updateAnalysis(a0,'Listening for note attacks and pitch…');
    const result=await LowlineAnalysis.analyze(channels,rate,{onProgress:p=>updateAnalysis(Math.min(92,a0+(92-a0)*p/92),'Listening for note attacks and pitch…')});
    notes=result.notes;octaveApplied=0;window.lowlineDebug=result; // inspect in the console: lowlineDebug.notes
    if(!notes.length)throw new Error('No stable bass pitch found. Try another file.');
    updateAnalysis(94,'Drawing the waveform and laying out the tab…');
    await new Promise(r=>setTimeout(r,0));
    const src=channels[0],peaks=new Float32Array(1800),bucket=Math.ceil(src.length/peaks.length);let max=0;
    for(let i=0;i<peaks.length;i++){let p=0,sum=0,n=0;const start=i*bucket,end=Math.min(src.length,start+bucket);for(let j=start;j<end;j++){const v=Math.abs(src[j]);if(v>p)p=v;sum+=v*v;n++}peaks[i]=n?Math.max(p*.82,Math.sqrt(sum/n)*1.4):0;if(peaks[i]>max)max=peaks[i]}
    if(max>0)for(let i=0;i<peaks.length;i++)peaks[i]=Math.pow(peaks[i]/max,.72);
    document.getElementById('trackName').innerHTML=`${file.name.replace(/</g,'&lt;')} <span>—</span> your bassline`;
    document.getElementById('trackSub').textContent=full?'Bass separated from the full song · click a note to hear it':'Estimated tab · click a note to hear it';
    document.getElementById('demoPill').style.display='none';
    try{localStorage.removeItem('lowlineRun')}catch(e){}lastPeaks=peaks;setWave(peaks);autoRhythm();buildTab();seek(0);updateAnalysis(100,'Analysis complete');
    sl.textContent=`Found ${notes.length} notes. Click any number or mark to hear just that note.`;
    document.getElementById('playerSection').classList.add('visible');progress.hidden=true;
    document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){try{localStorage.removeItem('lowlineRun')}catch(_){}sl.textContent=e.message||'This file could not be analyzed. Try another MP3 or WAV.';progress.hidden=true;toast(e.message||'Could not analyze this file.')}
  finally{document.getElementById('dropzone').disabled=false;document.getElementById('demoBtn').disabled=false}
}
document.getElementById('demoBtn').onclick=()=>{makeDemo();document.getElementById('statusText').textContent='Demo groove ready. Press play to hear the bass and follow along.';document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'})};dropzone.onclick=e=>{if(e.target!==fileInput)fileInput.click()};fileInput.onchange=e=>{if(e.target.files[0])analyze(e.target.files[0]);fileInput.value=''};dropzone.ondragover=e=>{e.preventDefault();dropzone.classList.add('dragover')};dropzone.ondragleave=()=>dropzone.classList.remove('dragover');dropzone.ondrop=e=>{e.preventDefault();dropzone.classList.remove('dragover');let f=e.dataTransfer.files[0];if(f)analyze(f)};
document.getElementById('playBtn').onclick=()=>playing?pause():play();document.getElementById('pauseBtn').onclick=pause;document.getElementById('restartBtn').onclick=()=>{pause();seek(0)};audio.onended=()=>{pause();seek(0)};
(()=>{let dragging=false,resume=false;waveform.style.touchAction='none';
const at=e=>{const r=waveform.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*duration};
waveform.addEventListener('pointerdown',e=>{if(!duration)return;dragging=true;resume=playing;if(playing)pause();try{waveform.setPointerCapture(e.pointerId)}catch{}setPosition(at(e));e.preventDefault()});
waveform.addEventListener('pointermove',e=>{if(dragging)setPosition(at(e))});
const end=e=>{if(!dragging)return;dragging=false;try{waveform.releasePointerCapture(e.pointerId)}catch{}if(resume){resume=false;play()}};
waveform.addEventListener('pointerup',end);waveform.addEventListener('pointercancel',end)})();waveform.onkeydown=e=>{if(e.key==='ArrowRight')seek(nowTime()+1);if(e.key==='ArrowLeft')seek(nowTime()-1);if(e.key==='Home')seek(0);if(e.key==='End')seek(duration)};
document.getElementById('speedSelect').onchange=e=>{const was=playing;if(was)pause();speed=+e.target.value;if(audio.src)audio.playbackRate=speed;if(was)play()};
document.getElementById('loopBtn').onclick=e=>{loopOn=!loopOn;e.currentTarget.setAttribute('aria-pressed',loopOn)};tuningSelect.onchange=buildTab;document.getElementById('octaveSelect').onchange=buildTab;document.getElementById('noteNamesBtn').onclick=e=>{showNames=!showNames;e.currentTarget.setAttribute('aria-pressed',showNames);buildTab()};document.getElementById('barsBtn').onclick=e=>{showBars=!showBars;e.currentTarget.setAttribute('aria-pressed',showBars);buildTab()};document.getElementById('rhythmBtn').onclick=e=>{showRhythm=!showRhythm;e.currentTarget.setAttribute('aria-pressed',showRhythm);buildTab()};
document.getElementById('fingersBtn').onclick=e=>{showFingers=!showFingers;e.currentTarget.setAttribute('aria-pressed',showFingers);buildTab()};
document.getElementById('bpmInput').onchange=e=>{const v=parseFloat(e.target.value);if(v>=30&&v<=300){const keepBar1=rhythmState.origin;rhythmState.bpm=v;rhythmState.origin=keepBar1;rhythmState.auto=false;syncRhythmControls();buildTab()}else syncRhythmControls()};
document.getElementById('sigSelect').onchange=e=>{rhythmState.sig=e.target.value;buildTab()};
document.getElementById('autoTempoBtn').onclick=()=>{autoRhythm();buildTab()};
document.getElementById('barPrevBtn').onclick=()=>{rhythmState.shiftBeats-=1;buildTab()};
document.getElementById('barNextBtn').onclick=()=>{rhythmState.shiftBeats+=1;buildTab()};
document.getElementById('dismissStatus').onclick=()=>document.getElementById('statusLine').style.display='none';document.getElementById('futureLink').onclick=e=>{e.preventDefault();toast('Full songs are split with Demucs (Meta, personal and research use), right in your browser. The model downloads once (90 MB).')};window.addEventListener('resize',()=>{if(notes.length){setWave(lastPeaks||demoWave())}});











// ---- hear one note: play only [t0, t1] of the recording, then stop there ----
function playClip(t0,t1,i){
  if(!audio.src)return;
  clearTimeout(clipTimer);if(playing)pause();
  const start=Math.max(0,t0-0.02),stop=Math.max(t1+0.06,t0+0.25);
  setPosition(start);if(i!=null)highlight(i);
  if(useWA()){startWA(start,stop-start);const tick=()=>{if(!waSrc){syncTab(stop);setPosition(start);return}syncTab(nowTime());clipTimer=setTimeout(tick,15)};tick();return}
  audio.playbackRate=speed;audio.preservesPitch=true;
  audio.play().then(()=>{clipEnd=stop;const tick=()=>{if(clipEnd==null)return;syncTab(audio.currentTime);if(audio.currentTime>=clipEnd||audio.paused){audio.pause();clipEnd=null;return}clipTimer=setTimeout(tick,15)};tick()}).catch(()=>toast('Press play once so the browser allows sound.'));
}
// ---- view & settings panel ----
(()=>{const panel=document.getElementById('viewPanel'),fab=document.getElementById('viewFab'),close=document.getElementById('viewClose'),scrim=document.getElementById('viewScrim');
  const open=v=>{panel.classList.toggle('open',v);scrim.classList.toggle('open',v);fab.setAttribute('aria-expanded',v);if(v)close.focus()};
  fab.onclick=()=>open(!panel.classList.contains('open'));close.onclick=()=>open(false);scrim.onclick=()=>open(false);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')open(false)});
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{viewMode=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',x===b));buildTab()});
})();

// ---- full songs: bass separation in a worker, and a Bass only / Full mix playback switch ----
const MODEL_URL='models/htdemucs_w16.onnx';
let lastPeaks=null,srcMode='full',bassUrl=null,hearBass=false;
document.querySelectorAll('[data-src]').forEach(b=>b.onclick=e=>{e.stopPropagation();srcMode=b.dataset.src;document.querySelectorAll('[data-src]').forEach(x=>x.setAttribute('aria-pressed',x===b))});
// The song is separated in 45 s pieces (+4 s of context on each side, so the cuts are seamless). Every finished piece is
// saved in IndexedDB under a key for this file: if the page reloads (e.g. the browser ran out of memory) dropping the same
// song again resumes, and a song separated before loads instantly.
const SEC=45,CTX=4,SR=44100;
function idb(){return new Promise((res,rej)=>{const q=indexedDB.open('lowline',1);q.onupgradeneeded=()=>q.result.createObjectStore('bass');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}
async function idbGet(k){try{const d=await idb();return await new Promise(r=>{const q=d.transaction('bass').objectStore('bass').get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>r(null)})}catch(e){return null}}
async function idbPut(k,v){try{const d=await idb();await new Promise(r=>{const t=d.transaction('bass','readwrite');t.objectStore('bass').put(v,k);t.oncomplete=r;t.onerror=r;t.onabort=r})}catch(e){}}
const toI16=a=>{const o=new Int16Array(a.length);for(let i=0;i<a.length;i++)o[i]=Math.max(-1,Math.min(1,a[i]))*32767;return o};
const XF=2;                                         // seconds of cross-fade between pieces (each piece keeps a 2 s tail)
function assemble(parts,n){const L=new Float32Array(n),R=new Float32Array(n),X=XF*SR;
  parts.forEach((p,k)=>{const s0=k*SEC*SR;for(let i=0;i<p.l.length&&s0+i<n;i++){const t=s0+i,a=p.l[i]/32767,b=p.r[i]/32767;
    if(k>0&&i<X){const w=i/X;L[t]=L[t]*(1-w)+a*w;R[t]=R[t]*(1-w)+b*w}else{L[t]=a;R[t]=b}}});return {L,R}}
async function separateBass(left,right,onProgress,fileKey){
  const n=left.length,nSec=Math.ceil(n/(SEC*SR)),parts=new Array(nSec),todo=[];
  for(let k=0;k<nSec;k++){const v=await idbGet(fileKey+'#'+k);if(v&&v.n===n&&v.v===2)parts[k]=v;else todo.push(k)}
  const finish=b=>{const o=assemble(parts,n);return {left:o.L,right:o.R,backend:b}};
  if(!todo.length){onProgress(70,'Bass already separated on this device');return finish('saved')}
  let w;try{w=new Worker('separate-worker.js')}catch(e){throw new Error('Bass separation needs the app to be opened from a web address (it does not work from a local file).')}
  const t0=performance.now(),doneBefore=nSec-todo.length;let backend='wasm',doneNow=0,waiter=null;
  w.onmessage=e=>{const m=e.data;
    if(m.type==='progress'&&m.phase==='model')onProgress(2+18*(m.total?m.done/m.total:0),m.cached?'Separation model ready':`Downloading the separation model (once): ${Math.round(m.done/1048576)} of ${Math.round((m.total||m.done)/1048576)} MB`);
    else if(m.type==='progress'){const f=(doneBefore+doneNow+(m.total?m.done/m.total:0))/nSec,fNew=(doneNow+(m.total?m.done/m.total:0))/todo.length,el=(performance.now()-t0)/1000,rest=fNew>0.03?Math.round(el/fNew-el):null;
      onProgress(20+50*f,`Separating the bass from the song${m.backend==='webgpu'?' (GPU)':''}: ${Math.round(f*100)}%${rest!=null?` · about ${rest>90?Math.round(rest/60)+' min':rest+' s'} left`:''}`)}
    else if(waiter)waiter(m)};
  w.onerror=e=>waiter&&waiter({type:'error',message:e.message||'Bass separation failed in this browser.'});
  const ask=(msg,tr)=>new Promise(r=>{waiter=m=>{if(m.type!=='progress'){waiter=null;r(m)}};w.postMessage(msg,tr||[])});
  try{
    let r=await ask({cmd:'init',modelUrl:new URL(MODEL_URL,location.href).href,cpuOnly:/[?&]cpu=1/.test(location.search)});
    if(r.type==='error')throw new Error(r.message);backend=r.backend;
    for(const k of todo){
      const s0=k*SEC*SR,e=Math.min(n,s0+SEC*SR+XF*SR),a=Math.max(0,s0-CTX*SR),b=Math.min(n,e+CTX*SR);
      const l=left.slice(a,b),rr=right===left?l.slice():right.slice(a,b);
      r=await ask({cmd:'section',id:k,left:l,right:rr},[l.buffer,rr.buffer]);
      if(r.type==='error')throw new Error(r.message);
      parts[k]={v:2,n,l:toI16(r.left.subarray(s0-a,e-a)),r:toI16(r.right.subarray(s0-a,e-a))};
      await idbPut(fileKey+'#'+k,parts[k]);doneNow++;
    }
  }finally{w.terminate()}
  return finish(backend);
}
function wavBlob(ch,rate){const n=ch[0].length,b=new ArrayBuffer(44+n*2),v=new DataView(b),s=(o,t)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i))};
  s(0,'RIFF');v.setUint32(4,36+n*2,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,n*2,true);
  const L=ch[0],R=ch[1]||ch[0];for(let i=0;i<n;i++){const x=Math.max(-1,Math.min(1,(L[i]+R[i])*0.5));v.setInt16(44+i*2,x*32767,true)}return new Blob([b],{type:'audio/wav'})}
function setSource(){const t=nowTime()||0,was=playing;if(was)pause();curPos=t;audio.src=hearBass&&bassUrl?bassUrl:objectUrl;audio.load();audio.preservesPitch=true;
  const go=()=>{try{audio.currentTime=t}catch(e){}if(was)play()};if(audio.readyState>=1)go();else audio.addEventListener('loadedmetadata',go,{once:true})}
function setBassSwitch(show){const sw=document.getElementById('mixSwitch');sw.hidden=!show;sw.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',(b.dataset.mix==='bass')===hearBass))}
document.querySelectorAll('[data-mix]').forEach(b=>b.onclick=()=>{hearBass=b.dataset.mix==='bass';setBassSwitch(true);setSource()});

// ---- if the page died in the middle of a song last time, say where (usually: out of memory on this device) ----
(()=>{let r=null;try{r=JSON.parse(localStorage.getItem('lowlineRun')||'null');localStorage.removeItem('lowlineRun')}catch(e){}
  if(!r||Date.now()-r.t>3600e3)return;
  const msg=`Last time the page restarted at ${r.pct}% ("${r.label}"). This usually means the browser ran out of memory. Device memory: ${r.mem?r.mem+' GB':'unknown'}, WebGPU: ${r.gpu?'yes':'no'}.`;
  document.getElementById('statusText').textContent=msg;window.lowlineLastCrash=r;console.warn(msg,r)})();
