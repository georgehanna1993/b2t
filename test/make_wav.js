// node test/make_wav.js out.wav  -> a short mixed bassline for manual/browser testing
const fs=require('fs'),SR=44100,hz=m=>440*Math.pow(2,(m-69)/12);
let seed=3;const rand=()=>(seed=(seed*1664525+1013904223)>>>0)/4294967296;
const total=9,out=new Float32Array(total*SR);
// {t,d,m,to,sa,sl,leg:[at,midi],slap}
const ev=[{t:.3,d:.4,m:40},{t:.8,d:.4,m:40},{t:1.3,d:.4,m:43},{t:1.8,d:.4,m:45},{t:2.3,d:.45,m:47},{t:2.8,d:.9,m:45,to:50,sa:.3,sl:.25},
 {t:4,d:.8,m:52,leg:[.3,50]},{t:5,d:.4,m:40,slap:1},{t:5.5,d:.4,m:40,slap:1},{t:6,d:.4,m:47},{t:6.5,d:.4,m:45},{t:7,d:.9,m:43},{t:8,d:.6,m:38}];
ev.forEach((e,k)=>{const nx=ev[k+1],end=Math.min(e.t+e.d,nx?nx.t+.008:99),i0=Math.floor(e.t*SR),i1=Math.floor(end*SR);let ph=0;
 for(let i=i0;i<i1;i++){const t=(i-i0)/SR;let f=hz(e.m);if(e.to!=null){const u=Math.min(1,Math.max(0,(t-e.sa)/e.sl));f=hz(e.m+(e.to-e.m)*u)}if(e.leg&&t>=e.leg[0])f=hz(e.leg[1]);
 ph+=2*Math.PI*f/SR;const env=Math.min(1,t/.004)*Math.min(1,(end-e.t-t)/.01)*Math.exp(-t*2.6);let v=Math.sin(ph)*.55+Math.sin(2*ph)*.28+Math.sin(3*ph)*.14;
 if(e.slap){const th=Math.exp(-t*180);v+=(rand()*2-1)*.9*th+Math.sin(7*ph)*.5*th}out[i]+=v*env*.7}});
const b=Buffer.alloc(44+out.length*2);b.write('RIFF',0);b.writeUInt32LE(36+out.length*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(SR,24);b.writeUInt32LE(SR*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(out.length*2,40);
for(let i=0;i<out.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,out[i]))*32767),44+i*2);fs.writeFileSync(process.argv[2]||'mixed.wav',b);
