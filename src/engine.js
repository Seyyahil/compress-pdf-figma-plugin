import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream, degrees } from 'pdf-lib';
import pako from 'pako';

export const LIMITS = { bytes: 200 * 1024 * 1024, pages: 300, pixels: 40_000_000, objects: 200_000 };
export const PRESETS = {
  smallest: { dpi: 96, quality: 0.65, lossy: true },
  balanced: { dpi: 144, quality: 0.82, lossy: true },
  print: { dpi: 300, quality: 0.94, lossy: true },
  lossless: { dpi: 0, quality: 1, lossy: false },
};
const N = (s) => PDFName.of(s);
const tick = () => new Promise((r) => setTimeout(r, 0));
const num = (d, k, fallback = 0) => { const v = d.lookup(N(k)); return v instanceof PDFNumber ? v.asNumber() : fallback; };
const named = (d, k) => { const v = d.lookup(N(k)); return v instanceof PDFName ? v.decodeText() : ''; };
const isImage = (o) => o instanceof PDFRawStream && named(o.dict, 'Subtype') === 'Image';
const cloneDict = (d) => d.clone(d.context);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function check(signal) { if (signal?.aborted) throw new Error('Cancelled'); }
function filterName(s) {
  const f = s.dict.lookup(N('Filter'));
  if (!f) return '';
  if (f instanceof PDFName) return f.decodeText();
  if (f instanceof PDFArray && f.size() === 1) { const x = f.lookup(0); return x instanceof PDFName ? x.decodeText() : '?'; }
  return '?';
}
function params(s) {
  let p = s.dict.lookup(N('DecodeParms'));
  if (p instanceof PDFArray && p.size() === 1) p = p.lookup(0);
  return p instanceof PDFDict ? p : null;
}
function canvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
async function jpegBytes(c, quality) {
  const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality }) : await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Image encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}
function undoPredictor(bytes, w, h, channels, p) {
  const predictor = p ? num(p, 'Predictor', 1) : 1;
  const row = w * channels;
  if (p && (num(p, 'Colors', channels) !== channels || num(p, 'Columns', w) !== w || num(p, 'BitsPerComponent', 8) !== 8)) throw new Error('Unsupported image predictor');
  if (predictor === 1) { if (bytes.length !== row * h) throw new Error('Unexpected image length'); return bytes; }
  if (predictor === 2) {
    if (bytes.length !== row * h) throw new Error('Unexpected TIFF predictor length');
    const out = bytes.slice();
    for (let y = 0; y < h; y++) for (let x = channels; x < row; x++) out[y * row + x] = (out[y * row + x] + out[y * row + x - channels]) & 255;
    return out;
  }
  if (predictor < 10 || predictor > 15 || bytes.length !== (row + 1) * h) throw new Error('Unsupported PNG predictor');
  const out = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    const f = bytes[y * (row + 1)];
    if (f > 4) throw new Error('Invalid PNG predictor');
    for (let x = 0; x < row; x++) {
      const a = x >= channels ? out[y * row + x - channels] : 0, b = y ? out[(y - 1) * row + x] : 0;
      const c = y && x >= channels ? out[(y - 1) * row + x - channels] : 0;
      let v = 0;
      if (f === 1) v = a;
      if (f === 2) v = b;
      if (f === 3) v = Math.floor((a + b) / 2);
      if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * row + x] = (bytes[y * (row + 1) + x + 1] + v) & 255;
    }
  }
  return out;
}
function rawPixels(s, channels) {
  const w = num(s.dict, 'Width'), h = num(s.dict, 'Height');
  if (w < 1 || h < 1 || w * h > LIMITS.pixels || num(s.dict, 'BitsPerComponent') !== 8) throw new Error('Unsupported image dimensions or bit depth');
  if (!['', 'FlateDecode'].includes(filterName(s))) throw new Error('Unsupported image encoding');
  if (s.dict.has(N('Decode'))) throw new Error('Custom image decode preserved');
  const data = filterName(s) ? pako.inflate(s.getContents()) : s.getContents();
  return undoPredictor(data, w, h, channels, params(s));
}
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
// Tokenize content streams without treating literal strings or hex strings as operators.
function* tokens(text) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue; }
    if (c === '(') { let depth = 1; i++; while (i < text.length && depth) { if (text[i] === '\\') i += 2; else { if (text[i] === '(') depth++; if (text[i] === ')') depth--; i++; } } yield '(string)'; continue; }
    if (c === '<' && text[i + 1] !== '<') { while (i < text.length && text[i] !== '>') i++; i++; yield '<hex>'; continue; }
    if ('[]<>'.includes(c)) { i++; yield c; continue; }
    const start = i++;
    while (i < text.length && !/[\s()[\]<>/%]/.test(text[i])) i++;
    yield text.slice(start, i);
  }
}
function decodedContent(context, object) {
  object = context.lookup(object);
  if (!object) return '';
  if (object instanceof PDFArray) return object.asArray().map(o => decodedContent(context, o)).join('\n');
  if (!(object instanceof PDFRawStream) || object.getContentsSize() > 16_000_000 || params(object)) throw new Error('Unsupported content stream');
  const b = decodePDFRawStream(object).decode();
  if (b.length > 32_000_000) throw new Error('Content stream too large');
  return new TextDecoder('latin1').decode(b);
}
function placements(doc) {
  const usage = new Map(); let operations = 0;
  const context = doc.context;
  function containsImage(root) {
    const visited = new Set(), pending = [root];
    while (pending.length) {
      const object = context.lookup(pending.pop());
      if (!object || visited.has(object)) continue;
      visited.add(object);
      if (isImage(object)) return true;
      if (object instanceof PDFRawStream) pending.push(object.dict);
      else if (object instanceof PDFDict) for (const [,value] of object.entries()) pending.push(value);
      else if (object instanceof PDFArray) pending.push(...object.asArray());
    }
    return false;
  }
  function scan(text, resources, initial, path, depth) {
    if (!(resources instanceof PDFDict) || depth > 16) return;
    const xobjects = resources.lookup(N('XObject'));
    if (!(xobjects instanceof PDFDict)) return;
    const stack = [], operands = []; let matrix = initial.slice();
    for (const t of tokens(text)) {
      if (++operations > 16_000_000) throw new Error('Placement scan limit');
      if (t === 'BI') throw new Error('Inline images have untracked placements');
      if (t[0] === '/' || /^[-+]?\d*\.?\d+$/.test(t)) { operands.push(t); if (operands.length > 64) operands.shift(); continue; }
      if (t === 'q') stack.push(matrix.slice());
      else if (t === 'Q') matrix = stack.pop() || initial.slice();
      else if (t === 'cm' && operands.length >= 6) { const m = operands.slice(-6).map(Number); if (m.every(Number.isFinite)) matrix = mul(matrix, m); }
      else if (t === 'Do' && operands.length) {
        const key = operands.at(-1);
        if (key[0] === '/') {
          const ref = xobjects.get(N(key.slice(1).replace(/#([\da-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))));
          const object = context.lookup(ref);
          if (isImage(object)) {
            const id = ref instanceof PDFRef ? ref.toString() : object;
            const old = usage.get(id) || { width: 0, height: 0 };
            old.width = Math.max(old.width, Math.hypot(matrix[0], matrix[1]));
            old.height = Math.max(old.height, Math.hypot(matrix[2], matrix[3]));
            usage.set(id, old);
          } else if (object instanceof PDFRawStream && named(object.dict, 'Subtype') === 'Form' && !path.has(object)) {
            const fm = object.dict.lookup(N('Matrix'));
            const formMatrix = fm instanceof PDFArray ? fm.asArray().map(n => context.lookup(n)).map(n => n instanceof PDFNumber ? n.asNumber() : NaN) : [1,0,0,1,0,0];
            if (formMatrix.length === 6 && formMatrix.every(Number.isFinite)) {
              path.add(object);
              try { scan(decodedContent(context, object), object.dict.lookup(N('Resources')) || resources, mul(matrix, formMatrix), path, depth + 1); } finally { path.delete(object); }
            }
          }
        }
      }
      operands.length = 0;
    }
  }
  // Figma's vector glyph fonts are Type 3. They do not invalidate unrelated
  // image placements unless their glyph resources actually contain images.
  let complete = !doc.context.enumerateIndirectObjects().some(([,o]) => o instanceof PDFDict && (
    (o.has(N('Pattern')) && containsImage(o.get(N('Pattern')))) ||
    (o.has(N('AP')) && containsImage(o.get(N('AP')))) ||
    (named(o, 'Subtype') === 'Type3' && (containsImage(o.get(N('Resources'))) || containsImage(o.get(N('CharProcs')))))
  ));
  for (const page of doc.getPages()) {
    const unit = num(page.node, 'UserUnit', 1);
    try { scan(decodedContent(context, page.node.get(N('Contents'))), page.node.Resources(), [unit,0,0,unit,0,0], new Set(), 0); } catch { complete = false; }
  }
  // Failed scans cannot establish the largest use of a shared image. Keep its resolution.
  return complete ? usage : new Map();
}
function photoLike(data) {
  const colors = new Set(), step = Math.max(4, Math.floor(data.length / 4096 / 4) * 4);
  for (let i = 0; i < data.length; i += step) { colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)); if (colors.size > 128) return true; }
  return false;
}
async function optimizeImage(doc, ref, s, setting, use) {
  const d = s.dict, w = num(d, 'Width'), h = num(d, 'Height');
  let cs = named(d, 'ColorSpace'); const filter = filterName(s), colorSpace = d.lookup(N('ColorSpace'));
  let preserveProfile = false;
  if (colorSpace instanceof PDFArray && colorSpace.size() === 2 && colorSpace.lookup(0)?.toString() === '/ICCBased') {
    const profile = colorSpace.lookup(1);
    if (profile instanceof PDFRawStream && num(profile.dict, 'N') === 3) { cs = 'DeviceRGB'; preserveProfile = true; }
  }
  if (!['DeviceRGB', 'DeviceGray'].includes(cs) || !['DCTDecode', 'FlateDecode', ''].includes(filter) || num(d, 'BitsPerComponent') !== 8 || w*h > LIMITS.pixels || w < 1 || h < 1 || d.has(N('Decode')) || d.has(N('Mask')) || d.has(N('ImageMask')) || d.has(N('Alternates')) || d.has(N('SMaskInData'))) return false;
  let scale = 1;
  if (setting.dpi && use && use.width > 0 && use.height > 0) scale = Math.min(1, Math.max(Math.max(1, Math.ceil(use.width * setting.dpi / 72)) / w, Math.max(1, Math.ceil(use.height * setting.dpi / 72)) / h));
  const nw = Math.max(1, Math.ceil(w * scale)), nh = Math.max(1, Math.ceil(h * scale));
  if (!setting.lossy && scale === 1 && filter === 'DCTDecode') return false;
  const softMask = d.lookup(N('SMask'));
  let alpha;
  if (softMask) {
    if (!(softMask instanceof PDFRawStream) || named(softMask.dict, 'ColorSpace') !== 'DeviceGray' || num(softMask.dict, 'Width') !== w || num(softMask.dict, 'Height') !== h || softMask.dict.has(N('Matte'))) return false;
    alpha = rawPixels(softMask, 1);
  }
  const source = canvas(w, h), ctx = source.getContext('2d', { willReadFrequently: true });
  if (filter === 'DCTDecode') {
    const bitmap = await createImageBitmap(new Blob([s.getContents()], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
    if (bitmap.width !== w || bitmap.height !== h) { bitmap.close(); return false; }
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
  } else {
    const channels = cs === 'DeviceRGB' ? 3 : 1, pixels = rawPixels(s, channels), image = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < w*h; i++, j += 4) { image.data[j] = pixels[i*channels]; image.data[j+1] = pixels[i*channels+(channels === 3 ? 1 : 0)]; image.data[j+2] = pixels[i*channels+(channels === 3 ? 2 : 0)]; image.data[j+3] = 255; }
    ctx.putImageData(image, 0, 0);
  }
  const resized = canvas(nw, nh), rctx = resized.getContext('2d', { willReadFrequently: true });
  rctx.imageSmoothingEnabled = true; rctx.imageSmoothingQuality = 'high'; rctx.drawImage(source, 0, 0, nw, nh);
  source.width = source.height = 1;
  const rgb = rctx.getImageData(0, 0, nw, nh).data;
  const raw = new Uint8Array(nw*nh*3);
  for (let i = 0, j = 0; i < rgb.length; i += 4) { raw[j++] = rgb[i]; raw[j++] = rgb[i+1]; raw[j++] = rgb[i+2]; }
  let best = pako.deflate(raw, { level: 9 }), bestFilter = 'FlateDecode';
  if (setting.lossy && (filter === 'DCTDecode' || photoLike(rgb))) { const jpg = await jpegBytes(resized, setting.quality); if (jpg.length < best.length) { best = jpg; bestFilter = 'DCTDecode'; } }
  resized.width = resized.height = 1;
  let newAlpha = null;
  if (alpha && (nw !== w || nh !== h)) {
    const ac = canvas(w, h), actx = ac.getContext('2d'), ai = actx.createImageData(w, h);
    for (let i = 0; i < alpha.length; i++) { ai.data[i*4] = ai.data[i*4+1] = ai.data[i*4+2] = alpha[i]; ai.data[i*4+3] = 255; }
    actx.putImageData(ai, 0, 0);
    const bc = canvas(nw, nh), bctx = bc.getContext('2d', { willReadFrequently: true }); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(ac, 0, 0, nw, nh);
    const arr = bctx.getImageData(0, 0, nw, nh).data, gray = new Uint8Array(nw*nh);
    for (let i = 0; i < gray.length; i++) gray[i] = arr[i*4];
    newAlpha = pako.deflate(gray, { level: 9 }); ac.width = ac.height = bc.width = bc.height = 1;
  }
  const before = s.getContentsSize() + (newAlpha ? softMask.getContentsSize() : 0);
  const after = best.length + (newAlpha ? newAlpha.length + 150 : 0);
  if (after >= before - 64) return false;
  const dict = cloneDict(d); dict.delete(N('DecodeParms')); dict.delete(N('Length'));
  dict.set(N('Width'), PDFNumber.of(nw)); dict.set(N('Height'), PDFNumber.of(nh)); if (!preserveProfile) dict.set(N('ColorSpace'), N('DeviceRGB')); dict.set(N('BitsPerComponent'), PDFNumber.of(8)); dict.set(N('Filter'), N(bestFilter));
  if (newAlpha) {
    const md = cloneDict(softMask.dict); md.delete(N('DecodeParms')); md.delete(N('Length')); md.set(N('Width'), PDFNumber.of(nw)); md.set(N('Height'), PDFNumber.of(nh)); md.set(N('Filter'), N('FlateDecode'));
    dict.set(N('SMask'), doc.context.register(PDFRawStream.of(md, newAlpha)));
  }
  doc.context.assign(ref, PDFRawStream.of(dict, best));
  return true;
}
function hasSignature(doc) {
  return doc.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFDict && o.has(N('ByteRange')));
}
async function loadPdf(bytes) {
  if (bytes.length > LIMITS.bytes) throw new Error('The frame export exceeds the 200 MiB processing limit. Export fewer frames.');
  let doc;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); } catch (e) { if (/encrypt/i.test(String(e))) throw new Error('Could not process a password-protected frame export.'); throw new Error('Could not read this PDF. ' + e.message); }
  if (doc.getPageCount() < 1 || doc.getPageCount() > LIMITS.pages) throw new Error('The frame export has an unsupported page count.');
  if (doc.context.enumerateIndirectObjects().length > LIMITS.objects) throw new Error('This PDF has too many objects for local processing.');
  if (hasSignature(doc)) throw new Error('Could not process a digitally signed frame export.');
  return doc;
}
async function reflate(doc, signal) {
  let count = 0, i = 0;
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    check(signal);
    if (o instanceof PDFRawStream && !isImage(o) && !params(o) && ['', 'FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode'].includes(filterName(o)) && o.getContentsSize() < 16_000_000) {
      try { const decoded = decodePDFRawStream(o).decode(); if (decoded.length <= 32_000_000) { const data = pako.deflate(decoded, { level: 9 }); if (data.length < o.getContentsSize() - 32) { const d = cloneDict(o.dict); d.delete(N('DecodeParms')); d.delete(N('Length')); d.set(N('Filter'), N('FlateDecode')); doc.context.assign(ref, PDFRawStream.of(d, data)); count++; } } } catch { /* Unknown encodings stay intact. */ }
    }
    if (++i % 50 === 0) await tick();
  }
  return count;
}
function hash(bytes) { let h = 2166136261; for (const v of bytes) { h ^= v; h = Math.imul(h, 16777619); } return h >>> 0; }
async function deduplicate(doc, signal) {
  const discarded = new Set();
  // First share identical masks/profiles, then compare images using those
  // canonical references. A single pass misses duplicated composite resources.
  for (let round = 0; round < 8; round++) {
    const seen = new Map(), redirects = new Map(); let i = 0;
    for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
      check(signal);
      if (o instanceof PDFRawStream && !discarded.has(ref.toString())) {
        const key = o.dict.entries().filter(([k]) => k.decodeText() !== 'Length').sort(([a], [b]) => a.toString().localeCompare(b.toString())).map(([k,v]) => k.toString() + ':' + v.toString()).join('|') + '|' + o.getContentsSize() + '|' + hash(o.getContents());
        const matches = seen.get(key) || [], match = matches.find(x => sameBytes(x.object.getContents(), o.getContents()));
        if (match) { redirects.set(ref.toString(), match.ref); discarded.add(ref.toString()); }
        else { matches.push({ ref, object: o }); seen.set(key, matches); }
      }
      if (++i % 50 === 0) await tick();
    }
    if (!redirects.size) break;
    const visited = new Set();
    function rewrite(o) {
      if (!o || visited.has(o)) return; visited.add(o);
      if (o instanceof PDFRawStream) rewrite(o.dict);
      else if (o instanceof PDFDict) for (const [k,v] of o.entries()) { if (v instanceof PDFRef && redirects.has(v.toString())) o.set(k, redirects.get(v.toString())); else if (!(v instanceof PDFRef)) rewrite(v); }
      else if (o instanceof PDFArray) for (let j = 0; j < o.size(); j++) { const v = o.get(j); if (v instanceof PDFRef && redirects.has(v.toString())) o.set(j, redirects.get(v.toString())); else if (!(v instanceof PDFRef)) rewrite(v); }
    }
    for (const [,o] of doc.context.enumerateIndirectObjects()) rewrite(o);
  }
  return discarded.size;
}
function prune(doc) {
  const live = new Set(), visited = new Set(), stack = Object.values(doc.context.trailerInfo);
  while (stack.length) {
    const o = stack.pop(); if (!o) continue;
    if (o instanceof PDFRef) { const id = o.toString(); if (!live.has(id)) { live.add(id); stack.push(doc.context.lookup(o)); } continue; }
    if (visited.has(o)) continue; visited.add(o);
    if (o instanceof PDFRawStream) stack.push(o.dict);
    else if (o instanceof PDFDict) for (const [,v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v);
  }
  let count = 0;
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!live.has(ref.toString())) { doc.context.delete(ref); count++; }
  return count;
}
async function pass(bytes, settings, progress, signal) {
  check(signal); progress({ phase: 'Reading PDF', value: 0.04 });
  const doc = await loadPdf(bytes);
  const sizes = doc.getPages().map(p => JSON.stringify([p.getMediaBox(), p.getCropBox(), p.getRotation().angle]));
  progress({ phase: 'Sharing repeated images and masks', value: 0.06 });
  const shared = await deduplicate(doc, signal), unused = prune(doc);
  // Alpha masks are image streams too, but rewriting them as RGB images makes
  // their parent images invalid. Only the parent can resize a mask with its image.
  const masks = new Set();
  for (const [, object] of doc.context.enumerateIndirectObjects()) if (isImage(object)) {
    for (const key of ['SMask', 'Mask']) {
      const mask = object.dict.lookup(N(key));
      if (isImage(mask)) masks.add(mask);
    }
  }
  progress({ phase: 'Inspecting image resolution', value: 0.09 }); await tick();
  const use = placements(doc), images = doc.context.enumerateIndirectObjects().filter(([,o]) => isImage(o) && !masks.has(o));
  let optimized = 0, skipped = 0;
  for (let i = 0; i < images.length; i++) {
    check(signal); const [ref,o] = images[i];
    progress({ phase: `Optimizing image ${i + 1} of ${images.length}`, value: 0.1 + 0.66 * i / Math.max(1, images.length) });
    try { if (await optimizeImage(doc, ref, o, settings, use.get(ref.toString()))) optimized++; else skipped++; } catch { skipped++; }
    await tick();
  }
  progress({ phase: 'Compressing PDF streams', value: 0.78 }); const streams = await reflate(doc, signal);
  progress({ phase: 'Reusing identical resources', value: 0.85 }); const duplicates = shared + await deduplicate(doc, signal), removed = unused + prune(doc);
  check(signal); progress({ phase: 'Writing optimized PDF', value: 0.92 });
  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 40 });
  check(signal);
  const verify = await PDFDocument.load(out, { updateMetadata: false });
  if (verify.getPageCount() !== sizes.length || verify.getPages().some((p,i) => JSON.stringify([p.getMediaBox(),p.getCropBox(),p.getRotation().angle]) !== sizes[i])) throw new Error('PDF page validation failed. Original retained.');
  return { bytes: out, pages: sizes.length, optimized, skipped, streams, duplicates, removed, settings };
}
export async function compressPdf(bytes, options = {}, progress = () => {}, signal) {
  const preset = PRESETS[options.preset || 'balanced']; if (!preset) throw new Error('Unknown compression preset');
  const settings = { ...preset };
  if (options.dpi != null && settings.lossy) { if (!Number.isFinite(options.dpi) || options.dpi < 72 || options.dpi > 600) throw new Error('Image resolution must be 72–600 DPI.'); settings.dpi = options.dpi; }
  if (options.quality != null && settings.lossy) { if (!Number.isFinite(options.quality) || options.quality < 0.4 || options.quality > 1) throw new Error('Image quality must be 40–100%.'); settings.quality = options.quality; }
  if (options.targetMB != null && (!Number.isFinite(options.targetMB) || options.targetMB < 0 || options.targetMB > 200)) throw new Error('Target must be between 0 and 200 MB.');
  const target = (options.targetMB || 0) * 1_000_000;
  let best = { bytes, pages: 0, originalRetained: true, optimized: 0, skipped: 0, streams: 0, duplicates: 0, removed: 0, settings };
  const attempts = target && settings.lossy && options.preset !== 'print' ? 4 : 1;
  for (let i = 0; i < attempts; i++) {
    const setting = { ...settings, dpi: Math.max(72, Math.round(settings.dpi * Math.pow(0.8, i))), quality: Math.max(Math.min(0.5, settings.quality), settings.quality - i * 0.1) };
    if (!settings.lossy) setting.dpi = 0;
    const result = await pass(bytes, setting, p => progress({ ...p, attempt: i + 1, attempts }), signal);
    if (result.bytes.length < best.bytes.length) best = { ...result, originalRetained: false };
    else if (!best.pages) { best.pages = result.pages; best.skipped = result.skipped; }
    if (!target || best.bytes.length <= target) break;
    await tick();
  }
  progress({ phase: 'Ready to download', value: 1 });
  return { ...best, originalBytes: bytes.length, outputBytes: best.bytes.length, savedPercent: Math.max(0, 100 * (1 - best.bytes.length / bytes.length)), targetMet: !target || best.bytes.length <= target };
}
export async function mergeFrames(parts) {
  if (!parts.length || parts.length > LIMITS.pages) throw new Error('Choose 1–300 frames.');
  const out = await PDFDocument.create(), frames = []; let total = 0, width = 0, height = 0;
  for (const part of parts) {
    total += part.length; if (total > LIMITS.bytes) throw new Error('Frame exports exceed the 200 MiB local processing limit. Export fewer frames.');
    const doc = await loadPdf(part);
    if (doc.getPageCount() !== 1) throw new Error('A frame export must contain exactly one page.');
    const [source] = await out.copyPages(doc, [0]), box = source.getCropBox(), unit = num(source.node, 'UserUnit', 1);
    const rotation = ((source.getRotation().angle % 360) + 360) % 360;
    if (![0,90,180,270].includes(rotation) || ![box.x,box.y,box.width,box.height,unit].every(Number.isFinite) || box.width<=0 || box.height<=0 || unit<=0) throw new Error('A frame export has invalid page dimensions.');
    const w = box.width * unit, h = box.height * unit, frameWidth = rotation%180 ? h:w, frameHeight = rotation%180 ? w:h;
    // An empty frame still needs a content stream for PDF page embedding.
    if (!source.node.Contents()) source.pushOperators();
    const embedded = await out.embedPage(source, {left:box.x,bottom:box.y,right:box.x+box.width,top:box.y+box.height});
    frames.push({source,embedded,box,unit,rotation,w,h,width:frameWidth,height:frameHeight});
    width = Math.max(width, frameWidth); height += frameHeight;
  }
  // Keep tall stacks within PDF's 14,400-unit page box without changing their physical size.
  const pageUnit = Math.max(1, Math.max(width,height)/14400);
  if (!Number.isFinite(pageUnit) || pageUnit>75000) throw new Error('The combined page is too large. Export fewer frames.');
  const page = out.addPage([width/pageUnit,height/pageUnit]);
  if (pageUnit>1) page.node.set(N('UserUnit'), PDFNumber.of(pageUnit));
  let top = height;
  for (const f of frames) {
    const bottom = top-f.height, x = f.rotation===180 ? f.w : f.rotation===270 ? f.h : 0;
    const y = bottom + (f.rotation===90 ? f.w : f.rotation===180 ? f.h : 0);
    page.drawPage(f.embedded, {x:x/pageUnit,y:y/pageUnit,xScale:f.unit/pageUnit,yScale:f.unit/pageUnit,rotate:degrees(-f.rotation)});
    // Preserve clickable URI links while translating their hit areas into the combined page.
    const point = (x,y) => {
      x=(x-f.box.x)*f.unit; y=(y-f.box.y)*f.unit;
      const rotated = f.rotation===90 ? [y,f.w-x] : f.rotation===180 ? [f.w-x,f.h-y] : f.rotation===270 ? [f.h-y,x] : [x,y];
      return [rotated[0]/pageUnit,(rotated[1]+bottom)/pageUnit];
    };
    const annotations = f.source.node.Annots();
    if (annotations instanceof PDFArray) for (const ref of annotations.asArray()) {
      const original = out.context.lookup(ref), action = original instanceof PDFDict ? original.lookup(N('A')) : null;
      if (!(original instanceof PDFDict) || named(original,'Subtype')!=='Link' || !(action instanceof PDFDict) || named(action,'S')!=='URI') continue;
      const rect=original.lookup(N('Rect')); if (!(rect instanceof PDFArray) || rect.size()!==4) continue;
      const values=rect.asArray().map(v=>out.context.lookup(v)).map(v=>v instanceof PDFNumber?v.asNumber():NaN); if (!values.every(Number.isFinite)) continue;
      const corners=[point(values[0],values[1]),point(values[2],values[3]),point(values[0],values[3]),point(values[2],values[1])];
      const link=original.clone(out.context); link.set(N('P'),page.ref); link.delete(N('QuadPoints'));
      link.set(N('Rect'),out.context.obj([Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))]));
      page.node.addAnnot(out.context.register(link));
    }
    top = bottom;
  }
  out.setProducer('Compress PDF');
  return out.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}
