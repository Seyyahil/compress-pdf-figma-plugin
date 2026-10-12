type ExportableNode = FrameNode | ComponentNode | InstanceNode;
function isExportable(node: BaseNode): node is ExportableNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}
const MAX_FRAMES = 300;
const MAX_BYTES = 200 * 1024 * 1024;
let exporting = false;
let cancelled = false;
let acknowledge: (() => void) | null = null;
let activeRequest: number | undefined;
let pendingIndex = -1;
let sessionPreferences: unknown;
let queuedExport: Message | null = null;
let closed = false;

function post(message: unknown) {
  if (!closed) figma.ui.postMessage(message);
}
function checkExport() {
  if (cancelled || closed) throw new Error('Cancelled');
}

figma.showUI(__html__, { width: 440, height: 740, themeColors: true });
// ID-less development imports cannot use Figma's relaunch or persistent storage APIs.
if (figma.pluginId) figma.root.setRelaunchData({ open: 'Export selected frames as a compressed PDF' });

function frames(): ExportableNode[] {
  return figma.currentPage.selection.filter((node): node is ExportableNode => isExportable(node));
}

function selection() {
  const nodes = frames();
  post({ type: 'selection', frames: nodes.map(n => ({ id: n.id, name: n.name })), ignored: figma.currentPage.selection.length - nodes.length });
}
async function sendSelection() {
  try { selection(); }
  catch { post({ type: 'selection-error', message: 'Could not read your selection. Select the frames again.' }); }
}
type Message = { type: string; ids?: string[]; requestId?: number; index?: number; preferences?: unknown; width?: number; height?: number };
async function onMessage(msg: Message) {
  if (closed || !msg || typeof msg !== 'object') return;
  if (msg.type === 'resize') {
    if (typeof msg.width === 'number' && Number.isFinite(msg.width) && typeof msg.height === 'number' && Number.isFinite(msg.height)) {
      figma.ui.resize(Math.max(360, Math.min(2400, Math.round(msg.width))), Math.max(400, Math.min(1600, Math.round(msg.height))));
    }
  } else if (msg.type === 'ready') {
    if (figma.pluginId) {
      try { sessionPreferences = await figma.clientStorage.getAsync('crisp-pdf-v1'); }
      catch { /* Optional preference storage must not block the panel or frame selection. */ }
    }
    post({ type: 'preferences', preferences: sessionPreferences });
    await sendSelection();
  } else if (msg.type === 'preferences' && msg.preferences && typeof msg.preferences === 'object') {
    const p = msg.preferences as { preset?: string; filename?: string };
    if (['smallest','balanced','print','lossless'].includes(p.preset || '') && typeof p.filename === 'string') {
      sessionPreferences = { preset: p.preset, filename: p.filename.slice(0,100) };
      if (figma.pluginId) {
        try { await figma.clientStorage.setAsync('crisp-pdf-v1', sessionPreferences); }
        catch { /* Keep preferences for this session when persistent storage is unavailable. */ }
      }
    }
  } else if (msg.type === 'cancel') {
    if (queuedExport && (msg.requestId == null || msg.requestId === queuedExport.requestId)) queuedExport = null;
    if (msg.requestId == null || msg.requestId === activeRequest) { cancelled = true; acknowledge?.(); }
  }
  else if (msg.type === 'ack' && msg.requestId === activeRequest && msg.index === pendingIndex) { acknowledge?.(); }
  else if (msg.type === 'export') {
    if (exporting) {
      if (cancelled) {
        // Native export cannot be interrupted. Start the replacement once it finishes.
        queuedExport = msg;
        post({ type: 'export-waiting', requestId: msg.requestId });
      } else if (msg.requestId !== activeRequest) {
        post({ type: 'export-error', requestId: msg.requestId, message: 'A PDF export is already in progress.' });
      }
      return;
    }
    const requestId = msg.requestId;
    activeRequest = requestId;
    exporting = true; cancelled = false;
    try {
      const ids = msg.ids || [];
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FRAMES || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Choose 1–300 unique frames.');
      const nodes: ExportableNode[] = [];
      for (const id of ids) {
        checkExport();
        const node = await figma.getNodeByIdAsync(id);
        checkExport();
        if (!node || !isExportable(node) || node.parent?.type === 'DOCUMENT') throw new Error('A selected frame is no longer available. Select the frames again.');
        let ancestor: BaseNode | null = node;
        while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
        if (ancestor !== figma.currentPage) throw new Error('Export frames from the current page.');
        nodes.push(node);
      }
      let totalBytes = 0;
      for (let i = 0; i < nodes.length; i++) {
        checkExport();
        const node = nodes[i];
        post({ type: 'export-progress', requestId, index: i, count: nodes.length, name: node.name });
        // Each native export is one page. Export originals directly to preserve
        // their fonts, variables, dimensions and orientation without cloning.
        const bytes = await node.exportAsync({ format: 'PDF', contentsOnly: true, useAbsoluteBounds: true });
        checkExport();
        totalBytes += bytes.length;
        if (totalBytes > MAX_BYTES) throw new Error('The native exports exceed 200 MiB. Export fewer frames.');
        await new Promise<void>((resolve, reject) => {
          pendingIndex = i;
          const timeout = setTimeout(() => { acknowledge = null; reject(new Error('The PDF panel stopped responding. Reopen the plugin.')); }, 30000);
          acknowledge = () => { clearTimeout(timeout); acknowledge = null; resolve(); };
          try { post({ type: 'frame-pdf', requestId, index: i, count: nodes.length, bytes }); }
          catch (error) { clearTimeout(timeout); acknowledge = null; reject(error); }
        });
        checkExport();
      }
      post({ type: 'export-complete', requestId });
    } catch (error) {
      post({ type: 'export-error', requestId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      exporting = false; acknowledge = null; activeRequest = undefined; pendingIndex = -1;
      const next = queuedExport; queuedExport = null;
      if (next && !closed) void onMessage(next);
    }
  }
}
figma.ui.onmessage = onMessage;
figma.on('close', () => {
  closed = true; cancelled = true; queuedExport = null; acknowledge?.();
});
figma.on('selectionchange', () => { void sendSelection(); });
figma.on('currentpagechange', () => { void sendSelection(); });
// Figma queues this initial snapshot until the UI loads; no ready handshake is required.
void sendSelection();
