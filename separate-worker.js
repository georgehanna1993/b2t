/* Lowline bass separation worker: HTDemucs (ONNX) on WebGPU, falling back to WebAssembly.
 * in:  {cmd:'init', modelUrl, cpuOnly} -> {type:'ready', backend}
 *      {cmd:'section', id, left, right (Float32Array @44.1 kHz)} -> {type:'progress', ...} ... {type:'section-done', id, left, right}
 * errors: {type:'error', message}
 * The model is cached with the Cache API, so it downloads only once per browser. */
'use strict';
importScripts('vendor/ort/ort.webgpu.min.js', 'vendor/demucs.js');
const base = self.location.href.replace(/[^/]*$/, '');
ort.env.wasm.wasmPaths = base + 'vendor/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;

async function fetchModel(url) {
  let cache = null;
  try { cache = await caches.open('lowline-models-v1'); const hit = await cache.match(url); if (hit) { postMessage({ type: 'progress', phase: 'model', done: 1, total: 1, cached: true }); return new Uint8Array(await hit.arrayBuffer()); } } catch (e) { cache = null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the separation model (' + res.status + ').');
  const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), parts = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length;
    if (got - last > 1 << 20) { last = got; postMessage({ type: 'progress', phase: 'model', done: got, total }); }
  }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(buf.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { /* storage full: fine, just not cached */ } }
  return buf;
}

let model = null, backend = 'wasm';
onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.cmd === 'init') {             // load (or reuse) the model once
      if (!model) {
        let weights = await fetchModel(m.modelUrl);
        if (self.navigator.gpu && !m.cpuOnly) { try { model = await LowlineDemucs.ONNXHTDemucs.init(weights, ['webgpu']); backend = 'webgpu'; } catch (e) { model = null; } }
        if (!model) { model = await LowlineDemucs.ONNXHTDemucs.init(weights, ['wasm']); backend = 'wasm'; }
        weights = null; // the session holds its own copy
      }
      postMessage({ type: 'ready', backend });
    } else if (m.cmd === 'section') {   // separate one piece of the song (the page saves each piece, so a reload can resume)
      const [left, right] = await LowlineDemucs.separateOne(model, [m.left, m.right], 'bass', (d, t) => postMessage({ type: 'progress', phase: 'separate', id: m.id, done: d, total: t, backend }));
      const l = left.slice(), r = right.slice();
      postMessage({ type: 'section-done', id: m.id, left: l, right: r }, [l.buffer, r.buffer]);
    }
  } catch (e) { postMessage({ type: 'error', message: (e && e.message) || String(e) }); }
};
