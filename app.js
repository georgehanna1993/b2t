const audio=document.getElementById('audioPlayer'),fileInput=document.getElementById('fileInput'),dropzone=document.getElementById('dropzone'),waveform=document.getElementById('waveform'),canvas=document.getElementById('waveCanvas'),ctx=canvas.getContext('2d');
const tuningSelect=document.getElementById('tuningSelect');
let notes=[],notePositions=[],rowLabels=[],duration=8,currentIndex=-1,playing=false,speed=1,raf=0,objectUrl=null,demoUrl=null,decoded=null,customDuration=8,loopOn=false,loopStart=0,loopEnd=0,showNames=false,showBars=true,toastTimer;
const noteNames=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const demoMidi=[40,40,43,45,47,45,43,40,40,40,43,45,47,50,47,45,43,43,45,47,45,43,40,38,40,40,43,45,47,45,43,40];
const demoTimes=demoMidi.map((m,i)=>({time:i*.5,midi:m,dur:.43,confidence:i%7===5?.66:.91}));
function midiName(m){return noteNames[((m%12)+12)%12]+(Math.floor(m/12)-1)}
function fmt(t){if(!isFinite(t))t=0;return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`}
function strings(){return tuningSelect.value==='D'?[26,31,36,41]:tuningSelect.value==='dropD'?[26,33,38,43]:[28,33,38,43]}
function findFret(midi){const ss=strings();let opts=[];ss.forEach((open,s)=>{let f=midi-open;if(f>=0&&f<=24)opts.push({s,f})});opts.sort((a,b)=>a.f-b.f);return opts[0]||{s:0,f:0,unplayable:true}}
function buildTab(){
  LowlineAnalysis.assignFrets(notes,strings());
  const grid=document.getElementById('tabGrid');
  grid.innerHTML='';rowLabels=[];
  const pad=42,minGap=34,slideCount=notes.filter(n=>n.slideTo).length,w=Math.max(820,notes.length*42+slideCount*82+120);
  grid.style.width=w+'px';
  for(let s=0;s<4;s++){
    const y=s*28+14,line=document.createElement('div'),label=document.createElement('span');
    line.className='string-line';line.style.top=y+'px';grid.append(line);
    label.className='string-label';label.style.top=y+'px';label.style.left='1px';label.textContent=['G','D','A','E'][s];grid.append(label);rowLabels.push(label);
  }
  if(showBars){
    for(let t=0;t<duration;t+=2){const x=pad+(t/duration)*(w-pad-20),marker=document.createElement('div'),label=document.createElement('span');marker.className='bar-marker';marker.style.left=x+'px';label.className='bar-label';label.textContent=''+(Math.floor(t/2)+1);marker.append(label);grid.append(marker)}
  }
  let cursor=pad-minGap;const layout=[];
  notePositions=[];
  for(let i=0;i<notes.length;i++){
    const n=notes[i];let p={s:n.string,f:n.fret};
    const row=3-p.s,y=row*28+14,timeX=pad+(n.time/duration)*(w-pad-20);
    const x=Math.max(timeX,cursor+minGap),slideSpan=n.slideTo?Math.max(82,(n.dur/duration)*(w-pad-20)):0;
    notePositions[i]=x;layout.push({n,p,x,y,slideSpan});cursor=x+Math.max(minGap,slideSpan+18);
  }
  layout.forEach(({n,p,x,y,slideSpan},i)=>{
    const note=document.createElement('button');
    note.className='tab-note'+(n.confidence<.75?' uncertain':'')+(n.mute?' muted':'');
    note.style.left=x+'px';note.style.top=(y-13)+'px';note.textContent=n.mute?'×':p.f;note.dataset.index=i;
    note.title=`${n.mute?'Muted note':midiName(n.midi)} · ${fmt(n.time)}${n.confidence<.75?' · uncertain':''}${n.slap?' · possible slap':''}${n.technique==='legato'?' · hammer-on/pull-off':''}${n.feat?` · brightness ${n.feat.bright.toFixed(2)}`:''}`;
    note.setAttribute('aria-label',n.mute?`Muted note at ${fmt(n.time)}`:`Note ${midiName(n.midi)}, string ${['E','A','D','G'][p.s]}, fret ${p.f}, ${fmt(n.time)}`);
    note.onclick=()=>seek(n.time);grid.append(note);
    if(n.slideTo){
      const fret=n.slideTo-strings()[p.s],endX=x+slideSpan,end=document.createElement('button');
      if(fret>=0&&fret<=24){
        const lineWidth=Math.max(34,endX-x-26),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox',`0 0 ${lineWidth} 24`);svg.setAttribute('class','slide-vector '+(n.slideTo>n.midi?'slide-up':'slide-down'));svg.setAttribute('aria-hidden','true');svg.style.left=(x+13)+'px';svg.style.top=(y-31)+'px';svg.style.width=lineWidth+'px';svg.style.height='24px';
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',n.slideTo>n.midi?`M 0 18 L ${lineWidth} 6`:`M 0 6 L ${lineWidth} 18`);path.setAttribute('fill','none');path.setAttribute('stroke','#E00000');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linecap','round');path.setAttribute('marker-end',`url(#slide-arrow-${i})`);
        const defs=document.createElementNS('http://www.w3.org/2000/svg','defs'),marker=document.createElementNS('http://www.w3.org/2000/svg','marker'),tip=document.createElementNS('http://www.w3.org/2000/svg','path');marker.setAttribute('id',`slide-arrow-${i}`);marker.setAttribute('markerWidth','7');marker.setAttribute('markerHeight','7');marker.setAttribute('refX','6');marker.setAttribute('refY','3.5');marker.setAttribute('orient','auto');marker.setAttribute('markerUnits','strokeWidth');tip.setAttribute('d','M0,0 L7,3.5 L0,7');tip.setAttribute('fill','none');tip.setAttribute('stroke','#E00000');tip.setAttribute('stroke-width','1.5');marker.append(tip);defs.append(marker);svg.append(defs,path);grid.append(svg);
        end.className='tab-note slide-end';end.style.left=endX+'px';end.style.top=(y-25)+'px';end.textContent=fret;end.title=`Slide destination ${midiName(n.slideTo)}`;end.setAttribute('aria-label',`Slide destination ${midiName(n.slideTo)}, fret ${fret}`);end.onclick=()=>seek(n.time+n.dur);grid.append(end);
      }
    }
    if(n.technique==='legato'&&i>0&&!n.mute){const mark=document.createElement('span');mark.className='tech-mark slap';mark.style.left=(x-17)+'px';mark.style.top=(y-3)+'px';mark.textContent=n.midi>notes[i-1].midi?'h':'p';mark.title=n.midi>notes[i-1].midi?'Hammer-on':'Pull-off';grid.append(mark)}
    if(n.slap){const mark=document.createElement('span');mark.className='tech-mark slap';mark.style.left=x+'px';mark.style.top=(y-3)+'px';mark.textContent='S';mark.title='Possible slap attack';grid.append(mark)}
    if(showNames){const name=document.createElement('span');name.className='tab-note-name';name.style.left=x+'px';name.style.top=y+'px';name.textContent=midiName(n.midi);grid.append(name)}
  });
  document.getElementById('noteCount').textContent=`· ${notes.length} NOTES`;
  grid.classList.toggle('show-names',showNames);
  document.getElementById('tabTuning').textContent=tuningSelect.value==='E'?'E A D G':tuningSelect.value==='D'?'D G C F':'D A D G';
  highlight(-1);
}
function playheadX(t){
  if(!notes.length)return 42;
  let i=-1;for(let j=0;j<notes.length;j++){if(notes[j].time<=t)i=j;else break}
  if(i<0)return notePositions[0]||42;
  const n=notes[i],x=notePositions[i]||42;
  const endX=n.slideTo?x+Math.max(62,(n.dur/duration)*(document.getElementById('tabGrid').scrollWidth-62)):x;
  if(n.slideTo&&t<n.time+n.dur&&n.dur>0)return x+(endX-x)*Math.max(0,(t-n.time)/n.dur);
  if(i>=notes.length-1)return endX;
  const next=notes[i+1],nextX=notePositions[i+1]||endX,f=Math.max(0,Math.min(1,(t-n.time)/Math.max(.001,next.time-n.time)));
  return endX+(nextX-endX)*f;
}
function drawWave(data){let rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);let count=Math.max(1,Math.floor(rect.width/3)),step=Math.max(1,Math.floor(data.length/count)),mid=rect.height/2;for(let i=0;i<count;i++){let a=0;for(let j=0;j<step;j++)a=Math.max(a,Math.abs(data[i*step+j]||0));let h=Math.max(2,a*rect.height*.92);ctx.fillStyle=i/count<(audio.currentTime/duration)?'#E00000':'#FFA97B';ctx.globalAlpha=i/count<(audio.currentTime/duration)?.95:.8;ctx.fillRect(i*rect.width/count,mid-h/2,Math.max(1,rect.width/count-1),h)}ctx.globalAlpha=1}
function demoWave(){let n=2200;let a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=Math.abs(Math.sin(i*.078)*Math.sin(i*.021)*.82+Math.sin(i*.018)*.16);return a}
function setWave(data){if(canvas.getBoundingClientRect().width)drawWave(data);else requestAnimationFrame(()=>drawWave(data));document.getElementById('durationLabel').textContent=fmt(duration);}
function highlight(i){currentIndex=i;document.querySelectorAll('.tab-note').forEach(el=>el.classList.toggle('current',+el.dataset.index===i));let n=notes[i];document.querySelector('#mobileCurrent b').textContent=n?`${midiName(n.midi)} · ${n.fret}`:'—';if(n){let el=document.querySelector(`.tab-note[data-index="${i}"]`);}}
function nowTime(){return audio.currentTime}
function updateTime(){if(!playing)return;let t=nowTime();if(loopOn&&t>=loopEnd&&loopEnd>loopStart){audio.currentTime=loopStart;t=loopStart}if(t>=duration){pause();audio.currentTime=0;return}let pct=Math.min(1,t/duration)*100;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);const view=document.getElementById('tabScroll'),grid=document.getElementById('tabGrid'),noteX=playheadX(t),maxScroll=Math.max(0,view.scrollWidth-view.clientWidth);view.scrollLeft=Math.max(0,Math.min(maxScroll,noteX-view.clientWidth*.45));rowLabels.forEach(label=>label.style.left=(view.scrollLeft+1)+'px');let idx=-1;for(let i=0;i<notes.length;i++){if(notes[i].time<=t)idx=i;else break}if(idx!==currentIndex)highlight(idx);raf=requestAnimationFrame(updateTime)}
function pause(){playing=false;cancelAnimationFrame(raf);audio.pause();document.body.classList.remove('playing');document.getElementById('playBtn').innerHTML='<span>▶</span>'}
async function play(){if(playing)return;if(!audio.src)return toast('Choose the demo or upload a WAV first.');audio.playbackRate=speed;audio.preservesPitch=true;try{await audio.play()}catch{toast('Could not start audio. Try pressing play again.');return}playing=true;document.body.classList.add('playing');document.getElementById('playBtn').innerHTML='<span>Ⅱ</span>';raf=requestAnimationFrame(updateTime)}
function seek(t){t=Math.max(0,Math.min(duration,t));if(audio.src)audio.currentTime=t;else{audio.currentTime=t;window.lastDemoNote=-1}let pct=t/duration*100;document.getElementById('waveCursor').style.left=pct+'%';document.getElementById('waveProgress').style.width=pct+'%';document.getElementById('currentTime').textContent=fmt(t);let i=-1;for(let j=0;j<notes.length;j++)if(notes[j].time<=t)i=j;highlight(i);if(playing){pause();play()}}
function buildDemoWav(){const sr=44100,count=Math.ceil(duration*sr),samples=new Float32Array(count);demoTimes.forEach((n,k)=>{const from=Math.floor(n.time*sr),next=demoTimes[k+1]?.time??duration,to=Math.min(count,Math.floor(next*sr)),f=440*Math.pow(2,(n.midi-69)/12);for(let i=from;i<to;i++){const t=(i-from)/sr,attack=Math.min(1,t/.004),env=attack*Math.exp(-t*4.1),tone=Math.sin(2*Math.PI*f*t)*.58+Math.sin(4*Math.PI*f*t)*.25+Math.sin(6*Math.PI*f*t)*.11+Math.sin(8*Math.PI*f*t)*.045;samples[i]+=tone*env*.72}});const ab=new ArrayBuffer(44+count*2),v=new DataView(ab),write=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};write(0,'RIFF');v.setUint32(4,36+count*2,true);write(8,'WAVE');write(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,count*2,true);for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);return new Blob([ab],{type:'audio/wav'})}
function makeDemo(){pause();decoded=null;duration=16;notes=demoTimes.map(x=>({...x}));loopStart=2;loopEnd=6;if(demoUrl)URL.revokeObjectURL(demoUrl);demoUrl=URL.createObjectURL(buildDemoWav());audio.src=demoUrl;audio.load();audio.currentTime=0;audio.preservesPitch=true;document.getElementById('trackName').innerHTML='Pocket groove <span>—</span> Lowline session';document.getElementById('trackSub').textContent='Demo bass · E standard tuning';document.getElementById('demoPill').style.display='';document.getElementById('playerSection').classList.add('visible');setWave(demoWave());buildTab();seek(0);}
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
    notes=result.notes;window.lowlineDebug=result; // inspect in the console: lowlineDebug.notes
    if(!notes.length)throw new Error('No stable bass pitch found. Try a cleaner isolated bass WAV.');
    updateAnalysis(94,'Drawing the waveform and laying out the tab…');
    await new Promise(r=>setTimeout(r,0));
    const src=buf.getChannelData(0),peaks=new Float32Array(1800),bucket=Math.ceil(src.length/peaks.length);let max=0;
    for(let i=0;i<peaks.length;i++){let p=0,sum=0,n=0;const start=i*bucket,end=Math.min(src.length,start+bucket);for(let j=start;j<end;j++){const v=Math.abs(src[j]);if(v>p)p=v;sum+=v*v;n++}peaks[i]=n?Math.max(p*.82,Math.sqrt(sum/n)*1.4):0;if(peaks[i]>max)max=peaks[i]}
    if(max>0)for(let i=0;i<peaks.length;i++)peaks[i]=Math.pow(peaks[i]/max,.72);
    document.getElementById('trackName').innerHTML=`${file.name.replace(/</g,'&lt;')} <span>—</span> your bassline`;
    document.getElementById('trackSub').textContent='Estimated tab · original audio playback · S = slap · h/p = hammer-on/pull-off · arrow = slide';
    document.getElementById('demoPill').style.display='none';
    setWave(peaks);buildTab();seek(0);updateAnalysis(100,'Analysis complete');
    sl.textContent=`Found ${notes.length} notes. Technique marks are best guesses; review them by ear.`;
    document.getElementById('playerSection').classList.add('visible');progress.hidden=true;
    document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){sl.textContent=e.message||'This file could not be analyzed. Try an uncompressed PCM WAV.';progress.hidden=true;toast(e.message||'Could not analyze this WAV.')}
  finally{document.getElementById('dropzone').disabled=false;document.getElementById('demoBtn').disabled=false}
}
document.getElementById('demoBtn').onclick=()=>{makeDemo();document.getElementById('statusText').textContent='Demo groove ready. Press play to hear the bass and follow along.';document.getElementById('playerSection').scrollIntoView({behavior:'smooth',block:'nearest'})};dropzone.onclick=e=>{if(e.target!==fileInput)fileInput.click()};fileInput.onchange=e=>{if(e.target.files[0])analyze(e.target.files[0]);fileInput.value=''};dropzone.ondragover=e=>{e.preventDefault();dropzone.classList.add('dragover')};dropzone.ondragleave=()=>dropzone.classList.remove('dragover');dropzone.ondrop=e=>{e.preventDefault();dropzone.classList.remove('dragover');let f=e.dataTransfer.files[0];if(f)analyze(f)};
document.getElementById('playBtn').onclick=()=>playing?pause():play();document.getElementById('pauseBtn').onclick=pause;document.getElementById('restartBtn').onclick=()=>{pause();seek(0)};audio.ontimeupdate=()=>{if(!playing){document.getElementById('currentTime').textContent=fmt(audio.currentTime)}};audio.onended=()=>{pause();seek(0)};
waveform.onclick=e=>{let r=waveform.getBoundingClientRect();seek((e.clientX-r.left)/r.width*duration)};waveform.onkeydown=e=>{if(e.key==='ArrowRight')seek(audio.currentTime+1);if(e.key==='ArrowLeft')seek(audio.currentTime-1);if(e.key==='Home')seek(0);if(e.key==='End')seek(duration)};
document.getElementById('speedSelect').onchange=e=>{speed=+e.target.value;if(audio.src)audio.playbackRate=speed;if(playing&&!audio.src){pause();play()}};
document.getElementById('loopBtn').onclick=e=>{loopOn=!loopOn;e.currentTarget.setAttribute('aria-pressed',loopOn)};tuningSelect.onchange=buildTab;document.getElementById('noteNamesBtn').onclick=e=>{showNames=!showNames;e.currentTarget.setAttribute('aria-pressed',showNames);buildTab()};document.getElementById('barsBtn').onclick=e=>{showBars=!showBars;e.currentTarget.setAttribute('aria-pressed',showBars);buildTab()};document.getElementById('dismissStatus').onclick=()=>document.getElementById('statusLine').style.display='none';document.getElementById('futureLink').onclick=e=>{e.preventDefault();toast('Automatic bass extraction from full songs is planned for a future version.')};window.addEventListener('resize',()=>{if(notes.length){let peaks=decoded?decoded.getChannelData(0):demoWave();setWave(peaks)}});










document.getElementById('tabScroll').addEventListener('scroll',()=>rowLabels.forEach(label=>label.style.left=(document.getElementById('tabScroll').scrollLeft+1)+'px'));
