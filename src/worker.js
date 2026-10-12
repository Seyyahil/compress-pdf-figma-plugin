import { compressFrames } from './engine.js';
self.onmessage = async (event) => {
  const { id, action, parts, options } = event.data;
  try {
    if (action === 'compress-frames') {
      const result = await compressFrames(parts, options, progress => self.postMessage({ id, progress }));
      self.postMessage({ id, result }, [result.bytes.buffer]);
    } else throw new Error('Unknown PDF operation');
  } catch (e) { self.postMessage({ id, error: e.message || String(e) }); }
};
self.postMessage({ ready: true });
