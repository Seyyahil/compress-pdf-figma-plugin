const MAX_FRAMES = 300;
const MAX_BYTES = 200 * 1024 * 1024;
let exporting = false;
let cancelled = false;
let acknowledge: (() => void) | null = null;
let activeRequest: number | undefined;
let pendingIndex = -1;
let sessionPreferences: unknown;
let temporaryExport: FrameNode | null = null;
function clearTemporaryExport() {
  const node = temporaryExport;
  temporaryExport = null;
  if (node && !node.removed) node.remove();
}

figma.showUI(__html__, { width: 440, height: 740, themeColors: true });
// ID-less development imports cannot use Figma's relaunch or persistent storage APIs.
if (figma.pluginId) figma.root.setRelaunchData({ open: 'Export selected frames as a compressed PDF' });

function frames(): FrameNode[] {
  return figma.currentPage.selection.filter((node): node is FrameNode => node.type === 'FRAME' && node !== temporaryExport);
}
function selection() {
  const nodes = frames();
  figma.ui.postMessage({ type: 'selection', frames: nodes.map(n => ({ id: n.id, name: n.name })), ignored: figma.currentPage.selection.length - nodes.length });
}
async function sendSelection() {
  try { await selection(); }
  catch { figma.ui.postMessage({ type: 'selection-error', message: 'Could not read your selection. Select the frames again.' }); }
}
type Message = { type: string; ids?: string[]; requestId?: number; index?: number; preferences?: unknown; width?: number; height?: number };
figma.ui.onmessage = async (msg: Message) => {
  if (msg.type === 'resize') {
    if (typeof msg.width === 'number' && Number.isFinite(msg.width) && typeof msg.height === 'number' && Number.isFinite(msg.height)) {
      figma.ui.resize(Math.max(360, Math.min(2400, Math.round(msg.width))), Math.max(400, Math.min(1600, Math.round(msg.height))));
    }
  } else if (msg.type === 'ready') {
    if (figma.pluginId) {
      try { sessionPreferences = await figma.clientStorage.getAsync('crisp-pdf-v1'); }
      catch { /* Optional preference storage must not block the panel or frame selection. */ }
    }
    figma.ui.postMessage({ type: 'preferences', preferences: sessionPreferences });
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
  } else if (msg.type === 'cancel') { cancelled = true; acknowledge?.(); }
  else if (msg.type === 'ack' && msg.requestId === activeRequest && msg.index === pendingIndex) { acknowledge?.(); }
  else if (msg.type === 'export') {
    if (exporting) return;
    const requestId = msg.requestId;
    activeRequest = requestId;
    exporting = true; cancelled = false;
    try {
      const ids = msg.ids || [];
      if (!ids.length || ids.length > MAX_FRAMES || new Set(ids).size !== ids.length) throw new Error('Choose 1–300 unique frames.');
      const nodes: FrameNode[] = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.type !== 'FRAME' || node.parent?.type === 'DOCUMENT') throw new Error('A selected frame is no longer available. Select the frames again.');
        let ancestor: BaseNode | null = node;
        while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
        if (ancestor !== figma.currentPage) throw new Error('Export frames from the current page.');
        nodes.push(node);
      }
      // Export the complete stack once so Figma can share fonts, images and masks.
      // Independent per-frame PDFs can repeat those resources before compression.
      let bytes: Uint8Array;
      if (nodes.length === 1) {
        figma.ui.postMessage({ type: 'export-progress', requestId, index: 0, count: 1, name: nodes[0].name });
        bytes = await nodes[0].exportAsync({ format: 'PDF', contentsOnly: true, useAbsoluteBounds: true });
      } else {
        const snapshots = nodes.map(node => {
          const bounds = node.absoluteBoundingBox;
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error('A selected frame has invalid bounds.');
          return { node, bounds, transform: node.absoluteTransform, modes: node.resolvedVariableModes };
        });
        const width = Math.max(...snapshots.map(s => s.bounds.width));
        const height = snapshots.reduce((sum, s) => sum + s.bounds.height, 0);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width > 100000 || height > 100000) throw new Error('The combined page exceeds Figma’s frame-size limit. Export fewer frames.');
        const stack = figma.createFrame();
        temporaryExport = stack;
        stack.name = 'Compress PDF · temporary export';
        stack.fills = []; stack.strokes = []; stack.effects = []; stack.clipsContent = true;
        stack.resizeWithoutConstraints(width, height); stack.x = -1000000; stack.y = 0;
        stack.locked = true;
        const collections = new Map<string, VariableCollection>();
        let top = 0;
        for (let i = 0; i < snapshots.length; i++) {
          if (cancelled) throw new Error('Cancelled');
          const { node, bounds, transform, modes } = snapshots[i];
          figma.ui.postMessage({ type: 'export-progress', requestId, index: i, count: nodes.length, name: node.name });
          const viewport = figma.createFrame(); stack.appendChild(viewport);
          viewport.fills = []; viewport.strokes = []; viewport.effects = []; viewport.clipsContent = true;
          viewport.resizeWithoutConstraints(bounds.width, bounds.height); viewport.x = 0; viewport.y = top;
          const copy = node.clone();
          try { viewport.appendChild(copy); }
          catch (error) { copy.remove(); throw error; }
          // Preserve the source's absolute orientation and inherited variable modes.
          copy.relativeTransform = [[transform[0][0], transform[0][1], transform[0][2] - bounds.x], [transform[1][0], transform[1][1], transform[1][2] - bounds.y]];
          for (const [id, mode] of Object.entries(modes)) {
            if (copy.resolvedVariableModes[id] === mode) continue;
            let collection = collections.get(id);
            if (!collection) {
              const found = await figma.variables.getVariableCollectionByIdAsync(id);
              if (!found) throw new Error('A variable collection used by a selected frame is unavailable.');
              collection = found; collections.set(id, collection);
            }
            copy.setExplicitVariableModeForCollection(collection, mode);
          }
          top += bounds.height;
        }
        bytes = await stack.exportAsync({ format: 'PDF', contentsOnly: true, useAbsoluteBounds: true });
      }
      if (cancelled) throw new Error('Cancelled');
      if (bytes.length > MAX_BYTES) throw new Error('The native export exceeds 200 MiB. Export fewer frames.');
      // Remove temporary artwork before delivering the PDF to the panel.
      clearTemporaryExport();
      await new Promise<void>((resolve, reject) => {
        pendingIndex = 0;
        const timeout = setTimeout(() => { acknowledge = null; reject(new Error('The PDF panel stopped responding. Reopen the plugin.')); }, 30000);
        acknowledge = () => { clearTimeout(timeout); acknowledge = null; resolve(); };
        figma.ui.postMessage({ type: 'frame-pdf', requestId, index: 0, count: 1, bytes });
      });
      if (cancelled) throw new Error('Cancelled');
      figma.ui.postMessage({ type: 'export-complete', requestId });
    } catch (error) {
      figma.ui.postMessage({ type: 'export-error', requestId, message: error instanceof Error ? error.message : String(error) });
    } finally { clearTemporaryExport(); exporting = false; acknowledge = null; activeRequest = undefined; pendingIndex = -1; }
  }
};
figma.on('close', clearTemporaryExport);
figma.on('selectionchange', () => { void sendSelection(); });
figma.on('currentpagechange', () => { void sendSelection(); });
// Figma queues this initial snapshot until the UI loads; no ready handshake is required.
void sendSelection();
