const audio=document.getElementById('audioPlayer'),fileInput=document.getElementById('fileInput'),dropzone=document.getElementById('dropzone'),waveform=document.getElementById('waveform'),canvas=document.getElementById('waveCanvas'),ctx=canvas.getContext('2d');
const tuningSelect=document.getElementById('tuningSelect');
let notes=[],notePositions=[],rowLabels=[],duration=8,currentIndex=-1,playing=false,speed=1,raf=0,objectUrl=null,demoUrl=null,decoded=null,customDuration=8,loopOn=false,loopStart=0,loopEnd=0,showNames=false,showBars=true,toastTimer;
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
let noteEnds=[],tabInfo=null,showRhythm=true,showFingers=false;
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
    opts:{rhythm:showRhythm,bars:showBars,names:showNames,fingers:showFingers},midiName,fmt,onSeek:seek});
  notePositions=tabInfo.xs;noteEnds=tabInfo.ends;
  document.getElementById('noteCount').textContent=`· ${notes.length} NOTES`;
  document.getElementById('tabTuning').textContent=stringNames().join(' ');
  highlight(-1);
  if(typeof duration==='number'&&audio)syncTab(audio.currentTime||0);
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
function drawWave(data){let rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);let count=Math.max(1,Math.floor(rect.width/3)),step=Math.max(1,Math.floor(data.length/count)),mid=rect.height/2;for(let i=0;i<count;i++){let a=0;for(let j=0;j<step;j++)a=Math.max(a,Math.abs(data[i*step+j]||0));let h=Math.max(2,a*rect.height*.92);ctx.fillStyle=i/count<(audio.currentTime/duration)?'#E00000':'#FFA97B';ctx.globalAlpha=i/count<(audio.currentTime/duration)?.95:.8;ctx.fillRect(i*rect.width/count,mid-h/2,Math.max(1,rect.width/count-1),h)}ctx.globalAlpha=1}
function demoWave(){let n=2200;let a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=Math.abs(Math.sin(i*.078)*Math.sin(i*.021)*.82+Math.sin(i*.018)*.16);return a}
function setWave(data){if(canvas.getBoundingClientRect().width)drawWave(data);else requestAnimationFrame(()=>drawWave(data));document.getElementById('durationLabel').textContent=fmt(duration);}
function highlight(i){currentIndex=i;document.querySelectorAll('.tab-note').forEach(el=>el.classList.toggle('current',+el.dataset.index===i));let n=notes[i];document.querySelector('#mobileCurrent b').textContent=n?`${midiName(n.midi)} · ${n.fret}`:'—';if(n){let el=document.querySelector(`.tab-note[data-index="${i}"]`);}}
function nowTime(){return audio.currentTime}
function syncTab(t){const view=document.getElementById('tabScroll'),maxScroll=Math.max(0,view.scrollWidth-view.clientWidth),x=playheadX(t);if(tabInfo&&tabInfo.cursor)tabInfo.cursor.style.left=x+'px';view.scrollLeft=Math.max(0,Math.min(maxScroll,x-view.clientWidth*.45))}
function updateTime(){if(!playing)return;let t=nowTime();if(loopOn&&t>=loopEnd&&loopEnd>loopStart){audio.currentTime=loopStart;t=loopStart}if(t>=duration){pause();audio.currentTime=0;return}let pct=Math.min(1,t/duration)*100;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);syncTab(t);let idx=-1;for(let i=0;i<notes.length;i++){if(notes[i].time<=t)idx=i;else break}if(idx!==currentIndex)highlight(idx);raf=requestAnimationFrame(updateTime)}
function pause(){playing=false;cancelAnimationFrame(raf);audio.pause();document.body.classList.remove('playing');document.getElementById('playBtn').innerHTML='<span>▶</span>'}
async function play(){if(playing)return;if(!audio.src)return toast('Choose the demo or upload a WAV first.');audio.playbackRate=speed;audio.preservesPitch=true;try{await audio.play()}catch{toast('Could not start audio. Try pressing play again.');return}playing=true;document.body.classList.add('playing');document.getElementById('playBtn').innerHTML='<span>Ⅱ</span>';raf=requestAnimationFrame(updateTime)}
function setPosition(t){t=Math.max(0,Math.min(duration,t));audio.currentTime=t;if(!audio.src)window.lastDemoNote=-1;const pct=duration?t/duration*100:0;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);let i=-1;for(let j=0;j<notes.length;j++)if(notes[j].time<=t)i=j;if(i!==currentIndex)highlight(i);syncTab(t)}
function seek(t){setPosition(t);if(playing){pause();play()}}
function buildDemoWav(){const sr=44100,count=Math.ceil(duration*sr),samples=new Float32Array(count);demoTimes.forEach((n,k)=>{const from=Math.floor(n.time*sr),next=demoTimes[k+1]?.time??duration,to=Math.min(count,Math.floor(next*sr)),f=440*Math.pow(2,(n.midi-69)/12);for(let i=from;i<to;i++){const t=(i-from)/sr,attack=Math.min(1,t/.004),env=attack*Math.exp(-t*4.1),tone=Math.sin(2*Math.PI*f*t)*.58+Math.sin(4*Math.PI*f*t)*.25+Math.sin(6*Math.PI*f*t)*.11+Math.sin(8*Math.PI*f*t)*.045;samples[i]+=tone*env*.72}});const ab=new ArrayBuffer(44+count*2),v=new DataView(ab),write=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};write(0,'RIFF');v.setUint32(4,36+count*2,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);return new Blob([ab],{type:'audio/wav'})}
function makeDemo(){pause();decoded=null;duration=16;notes=demoTimes.map(x=>({...x}));octaveApplied=0;loopStart=2;loopEnd=6;if(demoUrl)URL.revokeObjectURL(demoUrl);demoUrl=URL.createObjectURL(buildDemoWav());audio.src=demoUrl;audio.load();audio.currentTime=0;audio.preservesPitch=true;document.getElementById('trackName').innerHTML='Pocket groove <span>—</span> Lowline session';document.getElementById('trackSub').textContent='Demo bass · E standard tuning';document.getElementById('demoPill').style.display='';document.getElementById('playerSection').classList.add('visible');setWave(demoWave());autoRhythm();buildTab();seek(0);}
function toast(s){let t=document.getElementById('toast');t.textContent=s;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
function updateAnalysis(pct,label){document.getElementById('analysisBar').style.width=`${pct}%`;document.getElementById('progressPct').textContent=`${Math.round(pct)}%`;document.getElementById('analysisText').textContent=label}
async function analyze(file){
  if(file.size>25*1024*1024)return toast('That file exceeds the 25 MB limit.');
  if(!/\.wav$/i.test(file.name)&&file.type!=='audio/wav')return toast('Please choose a WAV audio file.');
  pause();
  const sl=document.getElementById('statusText'),progress=document.getElementById('analysisProgress');
  progress.hidden=false;updateAnalysis(2,'Opening WAV…');sl.textContent='Analysis runs locally on your device.';
  document.getElementById('dropzone').disabled=true;document.getElementById('demoBtn').disabled=true;
  await new Promise(r=>setTimeout(r,0));
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)throw new Error('Audio decoding is not supported in this browser.');
    const arr=await file.arrayBuffer(),ac=window.audioContext||(window.audioContext=new AC()),buf=await ac.decodeAudioData(arr.slice(0));
    if(buf.duration>300)throw new Error('Please use a WAV shorter than five minutes.');
    decoded=buf;duration=buf.duration;customDuration=duration;loopStart=duration*.2;loopEnd=Math.min(duration,loopStart+4);
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    objectUrl=URL.createObjectURL(file);audio.src=objectUrl;audio.load();audio.preservesPitch=true;
    updateAnalysis(8,'Listening for note attacks and pitch…');
    const channels=[];for(let c=0;c<buf.numberOfChannels;c++)channels.push(buf.getChannelData(c));
    const result=await LowlineAnalysis.analyze(channels,buf.sampleRate,{onProgress:p=>updateAnalysis(Math.min(92,p),'Listening for note attacks and pitch…')});
    notes=result.notes;octaveApplied=0;window.lowlineDebug=result; // inspect in the console: lowlineDebug.notes
    if(!notes.length)throw new Error('No stable bass pitch found. Try a cleaner isolated bass WAV.');
    updateAnalysis(94,'Drawing the waveform and laying out the tab…');
    await new Promise(r=>setTimeout(r,0));
    const src=buf.getChannelData(0),peaks=new Float32Array(1800),bucket=Math.ceil(src.length/peaks.length);let max=0;
    for(let i=0;i<peaks.length;i++){let p=0,sum=0,n=0;const start=i*bucket,end=Math.min(src.length,start+bucket);for(let j=start;j<end;j++){const v=Math.abs(src[j]);if(v>p)p=v;sum+=v*v;n++}peaks[i]=n?Math.max(p*.82,Math.sqrt(sum/n)*1.4):0;if(peaks[i]>max)max=peaks[i]}
    if(max>0)for(let i=0;i<peaks.length;i++)peaks[i]=Math.pow(peaks[i]/max,.72);
    document.getElementById('trackName').innerHTML=`${file.name.replace(/</g,'&lt;')} <span>—</span> your bassline`;
    document.getElementById('trackSub').textContent='Estimated tab · original audio playback · see LEGEND below the tab for every mark';
    document.getElementById('demoPill').style.display='none';
    setWave(peaks);autoRhythm();buildTab();seek(0);updateAnalysis(100,'Analysis complete');
    sl.textContent=`Found ${notes.length} notes. Technique marks are best guesses; review them by ear.`;
    document.getElementById('playerSection').classList.add('visible');progress.hidden=true;
    document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){sl.textContent=e.message||'This file could not be analyzed. Try an uncompressed PCM WAV.';progress.hidden=true;toast(e.message||'Could not analyze this WAV.')}
  finally{document.getElementById('dropzone').disabled=false;document.getElementById('demoBtn').disabled=false}
}
document.getElementById('demoBtn').onclick=()=>{makeDemo();document.getElementById('statusText').textContent='Demo groove ready. Press play to hear the bass and follow along.';document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'})};dropzone.onclick=e=>{if(e.target!==fileInput)fileInput.click()};fileInput.onchange=e=>{if(e.target.files[0])analyze(e.target.files[0]);fileInput.value=''};dropzone.ondragover=e=>{e.preventDefault();dropzone.classList.add('dragover')};dropzone.ondragleave=()=>dropzone.classList.remove('dragover');dropzone.ondrop=e=>{e.preventDefault();dropzone.classList.remove('dragover');let f=e.dataTransfer.files[0];if(f)analyze(f)};
document.getElementById('playBtn').onclick=()=>playing?pause():play();document.getElementById('pauseBtn').onclick=pause;document.getElementById('restartBtn').onclick=()=>{pause();seek(0)};audio.ontimeupdate=()=>{if(!playing){document.getElementById('currentTime').textContent=fmt(audio.currentTime)}};audio.onended=()=>{pause();seek(0)};
(()=>{let dragging=false,resume=false;waveform.style.touchAction='none';
const at=e=>{const r=waveform.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*duration};
waveform.addEventListener('pointerdown',e=>{if(!duration)return;dragging=true;resume=playing;if(playing)pause();try{waveform.setPointerCapture(e.pointerId)}catch{}setPosition(at(e));e.preventDefault()});
waveform.addEventListener('pointermove',e=>{if(dragging)setPosition(at(e))});
const end=e=>{if(!dragging)return;dragging=false;try{waveform.releasePointerCapture(e.pointerId)}catch{}if(resume){resume=false;play()}};
waveform.addEventListener('pointerup',end);waveform.addEventListener('pointercancel',end)})();waveform.onkeydown=e=>{if(e.key==='ArrowRight')seek(audio.currentTime+1);if(e.key==='ArrowLeft')seek(audio.currentTime-1);if(e.key==='Home')seek(0);if(e.key==='End')seek(duration)};
document.getElementById('speedSelect').onchange=e=>{speed=+e.target.value;if(audio.src)audio.playbackRate=speed;if(playing&&!audio.src){pause();play()}};
document.getElementById('loopBtn').onclick=e=>{loopOn=!loopOn;e.currentTarget.setAttribute('aria-pressed',loopOn)};tuningSelect.onchange=buildTab;document.getElementById('octaveSelect').onchange=buildTab;document.getElementById('noteNamesBtn').onclick=e=>{showNames=!showNames;e.currentTarget.setAttribute('aria-pressed',showNames);buildTab()};document.getElementById('barsBtn').onclick=e=>{showBars=!showBars;e.currentTarget.setAttribute('aria-pressed',showBars);buildTab()};document.getElementById('rhythmBtn').onclick=e=>{showRhythm=!showRhythm;e.currentTarget.setAttribute('aria-pressed',showRhythm);buildTab()};
document.getElementById('fingersBtn').onclick=e=>{showFingers=!showFingers;e.currentTarget.setAttribute('aria-pressed',showFingers);buildTab()};
document.getElementById('bpmInput').onchange=e=>{const v=parseFloat(e.target.value);if(v>=30&&v<=300){const keepBar1=rhythmState.origin;rhythmState.bpm=v;rhythmState.origin=keepBar1;rhythmState.auto=false;syncRhythmControls();buildTab()}else syncRhythmControls()};
document.getElementById('sigSelect').onchange=e=>{rhythmState.sig=e.target.value;buildTab()};
document.getElementById('autoTempoBtn').onclick=()=>{autoRhythm();buildTab()};
document.getElementById('barPrevBtn').onclick=()=>{rhythmState.shiftBeats-=1;buildTab()};
document.getElementById('barNextBtn').onclick=()=>{rhythmState.shiftBeats+=1;buildTab()};
document.getElementById('dismissStatus').onclick=()=>document.getElementById('statusLine').style.display='none';document.getElementById('futureLink').onclick=e=>{e.preventDefault();toast('Automatic bass extraction from full songs is planned for a future version.')};window.addEventListener('resize',()=>{if(notes.length){let peaks=decoded?decoded.getChannelData(0):demoWave();setWave(peaks)}});










