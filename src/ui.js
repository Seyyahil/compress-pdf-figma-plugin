import { compressPdf, PRESETS, LIMITS } from './engine.js';
const $ = id => document.getElementById(id);
const post = msg => parent.postMessage({ pluginMessage: msg }, '*');
const size = n => n < 1_000_000 ? `${(n/1000).toFixed(0)} KB` : `${(n/1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)} MB`;
let frames = [], output = null, busy = false, job = 0, parts = [], worker = null, sequence = 0, abort = null, workerUnavailable = false, exportFrames = [];
let settingsTouched = false;
const pending = new Map();
function stopWorker(error = new Error('Cancelled')) {
  const previous = worker; worker = null;
  if (previous) { previous.onmessage = null; previous.onerror = null; previous.terminate(); }
  for (const p of pending.values()) p.reject(error);
  pending.clear(); abort?.abort();
}
function getWorker() {
  if (workerUnavailable) return null;
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
  try {
    const currentWorker = new Worker(url);
    worker = currentWorker;
    let started = false;
    currentWorker.onmessage = e => {
      if (worker !== currentWorker) return;
      if (e.data.ready) { started = true; return; }
      const { id, progress, result, error } = e.data, request = pending.get(id);
      if (!request) return;
      if (progress) request.progress?.(progress);
      else { pending.delete(id); error ? request.reject(new Error(error)) : request.resolve(result); }
    };
    currentWorker.onerror = () => {
      if (worker !== currentWorker) return;
      const error = new Error(started ? 'The local PDF worker stopped. Retry with fewer pages.' : 'WORKER_UNAVAILABLE');
      if (!started) workerUnavailable = true;
      stopWorker(error);
    };
    return worker;
  } finally { URL.revokeObjectURL(url); }
}
async function call(action, data, progress, current) {
  if (current !== job) throw new Error('Cancelled');
  let w; try { w = getWorker(); } catch { /* Hosts that block blob workers can still process locally. */ }
  if (!w) {
    const controller = new AbortController(); abort = controller;
    try { return await compressPdf(data.bytes, data.options, progress, controller.signal); }
    finally { if (abort === controller) abort = null; }
  }
  try {
    return await new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject, progress });
      try { w.postMessage({ id, action, ...data }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  catch (e) { if (e.message === 'WORKER_UNAVAILABLE') return call(action,data,progress,current); throw e; }
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function controls() {
  $('run').disabled = busy || !frames.length || frames.length > LIMITS.pages;
  for (const id of ['preset','filename','dpi','quality']) $(id).disabled = busy;
  $('cancel').hidden = !busy; $('progress').hidden = !busy; $('run').hidden = busy;
  const lossless = $('preset').value === 'lossless'; $('dpi').disabled = busy || lossless; $('quality').disabled = busy || lossless;
  document.querySelectorAll('.frame button').forEach(el => { el.disabled = busy || el.dataset.boundary === 'true'; });
  document.querySelectorAll('.frame').forEach(el => { el.draggable = !busy; });
}
function clearResult() { output = null; $('result-section').hidden = true; }
function drawFrames() {
  const list = $('frame-list'); list.replaceChildren(); $('frame-count').textContent = frames.length;
  $('frames-empty').hidden = frames.length > 0; list.hidden = !frames.length;
  $('reorder-help').hidden = frames.length < 2;
  frames.forEach((f, i) => {
    const row = document.createElement('div'); row.className = 'frame'; row.draggable = !busy; row.dataset.id = f.id; row.setAttribute('role','listitem');
    const handle = document.createElement('span'); handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.setAttribute('aria-hidden','true'); row.append(handle);
    const content = document.createElement('div'); content.className = 'grow frame-content';
    const title = document.createElement('div'); title.className = 'frame-name'; title.textContent = `${i+1}. ${f.name}`; title.title = f.name;
    content.append(title); row.append(content);
    for (const [delta, text, label] of [[-1,'↑','Move frame up'],[1,'↓','Move frame down']]) {
      const b = document.createElement('button'); b.className = 'icon'; b.textContent = text; b.setAttribute('aria-label', `${label}: ${f.name}`); b.dataset.boundary = String(delta < 0 ? i === 0 : i === frames.length-1); b.disabled = busy || b.dataset.boundary === 'true';
      b.onclick = () => { if (busy) return; moveFrame(i,i+delta); }; row.append(b);
    }
    row.ondragstart = e => { if (busy) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
    const clearDrop = () => document.querySelectorAll('.frame').forEach(el=>el.classList.remove('drop-before','drop-after'));
    row.ondragend = () => { row.classList.remove('dragging'); clearDrop(); };
    row.ondragover = e => { if (!busy) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clearDrop(); const box=row.getBoundingClientRect(); row.classList.add(e.clientY < box.top+box.height/2 ? 'drop-before':'drop-after'); } };
    row.ondragleave = e => { if (!row.contains(e.relatedTarget)) clearDrop(); };
    row.ondrop = e => { e.preventDefault(); clearDrop(); if (busy) return; const id=e.dataTransfer.getData('text/plain'),from=frames.findIndex(x=>x.id===id); if(from<0||id===f.id)return; const box=row.getBoundingClientRect(); let to=i+(e.clientY>=box.top+box.height/2?1:0); if(from<to)to--; moveFrame(from,to); };
    list.append(row);
  }); controls();
}
function moveFrame(from,to) {
  if (from===to || from<0 || to<0 || to>=frames.length) return;
  const [item]=frames.splice(from,1); frames.splice(to,0,item); clearResult(); drawFrames();
}
function preset() {
  const p = PRESETS[$('preset').value]; $('dpi').value = p.dpi || 144; $('quality').value = Math.round(p.quality * 100);
  const descriptions = { balanced:'144 DPI images · 82% quality. A starting point for screen viewing.', smallest:'96 DPI images · 65% quality. Smaller files with more image compression.', print:'300 DPI images · 94% quality. Retains more image detail for printing.', lossless:'Recompresses streams and reuses resources without resizing or lossy image encoding.' };
  $('preset-help').textContent = descriptions[$('preset').value]; clearResult(); controls();
}
function options() {
  const p = $('preset').value;
  if (p !== 'lossless' && (!Number.isFinite(Number($('dpi').value)) || Number($('dpi').value) < 72 || Number($('dpi').value) > 600)) throw new Error('Image resolution must be 72–600 DPI.');
  if (p !== 'lossless' && (!Number.isFinite(Number($('quality').value)) || Number($('quality').value) < 40 || Number($('quality').value) > 100)) throw new Error('Image quality must be 40–100%.');
  return { preset: p, ...(p !== 'lossless' ? { dpi:Number($('dpi').value), quality:Number($('quality').value)/100 } : {}) };
}
async function compress(bytes, current) {
  const result = await call('compress', { bytes, options: options() }, p => { if (current !== job) return; $('progress').value = p.value; status(`${p.phase}${p.attempts > 1 ? ` · pass ${p.attempt}` : ''}`); }, current);
  if (current !== job) return;
  output = result;
  $('sizes').textContent = `${size(result.originalBytes)} → ${size(result.outputBytes)}`;
  $('savings').textContent = result.originalRetained ? 'Already optimized · native export retained' : `${result.savedPercent.toFixed(1)}% smaller`;
  $('details').textContent = `${exportFrames.length} ${exportFrames.length===1?'frame':'frames'} stacked · ${result.pages} ${result.pages===1?'page':'pages'} · ${result.optimized} images optimized · ${result.duplicates} identical resources reused`;
  const notes = [];
  if (result.skipped) notes.push(`${result.skipped} images kept at their current encoding, including masks, unsupported color spaces, and images already smaller.`);
  notes.push('Frame text remains sharp vector artwork. Searchability depends on Figma’s export.');
  $('result-note').textContent = notes.join(' '); $('result-section').hidden = false;
  status('Ready to download your PDF.');
  busy = false; parts = []; controls();
  post({ type: 'preferences', preferences: { preset: $('preset').value, filename: $('filename').value } });
}
async function run() {
  if (busy || !frames.length || frames.length > LIMITS.pages) return;
  try { options(); } catch (e) { status(e.message, true); return; }
  settingsTouched = true; clearResult(); busy = true; const current = ++job; $('progress').value = 0; controls();
  try {
    parts = []; exportFrames = frames.slice(); post({ type:'export', ids:exportFrames.map(f=>f.id), requestId:current }); status('Exporting frames…');
  } catch (e) { if (current !== job) return; busy = false; status(e.message, true); controls(); }
}
function filename() { let n = $('filename').value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-') || 'compressed.pdf'; if (!/\.pdf$/i.test(n)) n += '.pdf'; return n; }
function download() {
  if (!output) return; const url = URL.createObjectURL(new Blob([output.bytes], { type:'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = filename(); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
window.addEventListener('message', async e => {
  // Figma's desktop sandbox can relay messages with a different or null source.
  // Receive its documented pluginMessage envelope rather than assuming a direct parent sender.
  if (!e.data?.pluginMessage || typeof e.data.pluginMessage !== 'object') return; const msg = e.data.pluginMessage;
  if (msg.type === 'selection') {
    const old = frames.map(f=>f.id).join('|'), selected = msg.frames || [], byId=new Map(selected.map(f=>[f.id,f]));
    // Refresh metadata while preserving the user's manual order for frames still selected.
    frames = [...frames.filter(f=>byId.has(f.id)).map(f=>byId.get(f.id)), ...selected.filter(f=>!frames.some(old=>old.id===f.id))];
    if (!busy && old !== frames.map(f=>f.id).join('|')) clearResult();
    $('ignored').hidden = !msg.ignored; $('ignored').textContent = `${msg.ignored} selected layers skipped. Select frames to export.`; drawFrames();
    if (!busy) status(frames.length > LIMITS.pages ? 'Select no more than 300 frames.' : frames.length ? `${frames.length} ${frames.length===1?'frame':'frames'} ready.` : 'Select frames in Figma.');
  } else if (msg.type === 'selection-error') {
    if (!busy) status(msg.message,true);
  } else if (msg.type === 'preferences' && msg.preferences && !busy && !settingsTouched) {
    const p = msg.preferences; if (Object.hasOwn(PRESETS, p.preset)) { $('preset').value = p.preset; preset(); } if (typeof p.filename === 'string') $('filename').value = p.filename;
  } else if (msg.requestId === job && busy) {
    if (msg.type === 'export-waiting') status('Finishing the cancelled export…');
    if (msg.type === 'export-progress') { status(`Exporting ${msg.index+1} / ${msg.count}: ${msg.name}`); $('progress').value = .3 * msg.index/msg.count; }
    if (msg.type === 'frame-pdf') { parts.push(new Uint8Array(msg.bytes)); post({type:'ack', requestId:job, index:msg.index}); }
    if (msg.type === 'export-complete') {
      const current = job;
      try { if (parts.length !== 1) throw new Error('Expected one native PDF export. Reopen the plugin.'); const bytes = parts[0]; parts=[]; await compress(bytes,current); }
      catch (e) { if (current !== job) return; busy=false; parts=[]; status(e.message,true); controls(); }
    }
    if (msg.type === 'export-error') { busy=false; parts=[]; status(msg.message,true); controls(); }
  }
});
$('preset').onchange = () => { settingsTouched = true; preset(); };
$('filename').oninput = () => { settingsTouched = true; };
for (const id of ['dpi','quality']) $(id).onchange = () => { settingsTouched = true; clearResult(); $('preset-help').textContent = `Custom image settings · ${$('dpi').value} DPI · ${$('quality').value}% quality.`; };
$('run').onclick = run;
$('cancel').onclick = () => { const requestId = job++; post({type:'cancel',requestId}); stopWorker(); parts=[]; busy=false; status('Cancelled. Your source is unchanged.'); controls(); };
$('download').onclick = download;
const resizeHandle = $('resize-handle');
let resizeDrag = null, resizeFrame = 0, resizeSize = null;
function resizeWindow(width, height) {
  resizeSize = { type:'resize', width:Math.max(360,Math.min(2400,Math.round(width))), height:Math.max(400,Math.min(1600,Math.round(height))) };
  if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; post(resizeSize); });
}
resizeHandle.onpointerdown = e => {
  if (e.button !== 0) return;
  e.preventDefault(); resizeHandle.focus();
  resizeDrag = { id:e.pointerId, x:e.screenX, y:e.screenY, width:innerWidth, height:innerHeight };
  resizeHandle.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
};
resizeHandle.onpointermove = e => {
  if (resizeDrag?.id === e.pointerId) resizeWindow(resizeDrag.width+e.screenX-resizeDrag.x,resizeDrag.height+e.screenY-resizeDrag.y);
};
resizeHandle.onpointerup = e => {
  if (resizeDrag?.id !== e.pointerId) return;
  resizeWindow(resizeDrag.width+e.screenX-resizeDrag.x,resizeDrag.height+e.screenY-resizeDrag.y);
  resizeHandle.releasePointerCapture(e.pointerId);
};
const endResize = () => { resizeDrag = null; document.body.classList.remove('resizing'); };
resizeHandle.onpointercancel = endResize; resizeHandle.onlostpointercapture = endResize;
resizeHandle.onkeydown = e => {
  const direction = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] }[e.key];
  if (!direction) return;
  e.preventDefault(); const step = e.shiftKey ? 40 : 10;
  resizeWindow(innerWidth+direction[0]*step,innerHeight+direction[1]*step);
};
preset(); post({type:'ready'});
