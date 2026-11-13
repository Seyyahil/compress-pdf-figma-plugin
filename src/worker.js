import { createFrameExport } from './engine.js';
let exportJob = null, report = null;
self.onmessage = async ({ data: { id, action, count, options, bytes } }) => {
  try {
    report = progress => self.postMessage({ id, progress });
    if (action === 'start-export') {
      exportJob = createFrameExport(count, options, progress => report?.(progress));
    } else if (action === 'add-frame' && exportJob) {
      await exportJob.add(bytes);
    } else if (action === 'finish-export' && exportJob) {
      const job = exportJob; exportJob = null;
      const result = await job.finish();
      self.postMessage({ id, result }, [result.bytes.buffer]);
      return;
    } else throw new Error('Unknown PDF operation');
    self.postMessage({ id, result: null });
  } catch (error) {
    exportJob = null;
    self.postMessage({ id, error: error.message || String(error) });
  } finally { report = null; }
};
self.postMessage({ ready: true });
