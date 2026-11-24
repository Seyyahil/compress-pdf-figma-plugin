import { PDFName, PDFDict, PDFRawStream } from 'pdf-lib';
import pako from 'pako';

// Figma writes text as outlines, so one letter can repeat thousands of times.
// Store each repeated outline once and place it by reference. The artwork stays
// vector, colors and effects are inherited, and an outline only leaves its fill
// when it touches no other outline there, so nothing can paint twice.
export const PATH_OPERANDS = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, h: 0 };
export const PATH_PAINT = new Set(['f','F','f*','S','s','B','B*','b','b*','n']);
export const PATH_VALUES = 4_000_000;
const SHAPE_CHARACTERS = 12_000, KEY_CHARACTERS = 24_000_000, STORED_SHAPES = 20_000, COMPARISONS = 5_000_000, PLACED_TOGETHER = 64;
// Viewers clip a form to its bounds and soften that edge. A margin in page points
// keeps it away from the outline, so text does not fade when zoomed out.
const MARGIN = 256, MAX_MARGIN = 32_000;
const N = s => PDFName.of(s);

export const decimal = (value, precision) => value.toFixed(precision).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
export function createPath(precision, scale, plain) { return { precision, scale, plain, ops: [], values: [], contours: [] }; }
export function addSegment(path, op, numbers) {
  const contour = path.contours[path.contours.length - 1];
  if (op === 'm') path.contours.push({ op: path.ops.length, value: path.values.length, x0: numbers[0], y0: numbers[1], x1: numbers[0], y1: numbers[1], segments: 0, curved: false });
  else if (contour && (op === 'l' || op === 'c')) {
    contour.segments++; contour.curved ||= op === 'c';
    for (let i = 0; i < numbers.length; i += 2) {
      contour.x0 = Math.min(contour.x0, numbers[i]); contour.x1 = Math.max(contour.x1, numbers[i]);
      contour.y0 = Math.min(contour.y0, numbers[i+1]); contour.y1 = Math.max(contour.y1, numbers[i+1]);
    }
  } else if (op !== 'h' || !contour) path.plain = false;
  path.ops.push(op);
  for (const value of numbers) path.values.push(value);
}
export function pathText(path) {
  let text = '', v = 0;
  for (const op of path.ops) {
    for (let i = 0; i < PATH_OPERANDS[op]; i++) text += decimal(path.values[v++], path.precision) + ' ';
    text += op + '\n';
  }
  return text;
}
function eachSegment(path, index, visit) {
  const { ops, values, contours } = path, end = contours[index + 1]?.op ?? ops.length;
  for (let o = contours[index].op, v = contours[index].value; o < end; o++) {
    const count = PATH_OPERANDS[ops[o]];
    visit(ops[o], values, v, count); v += count;
  }
}
function contourText(path, index) {
  let text = '';
  eachSegment(path, index, (op, values, v, count) => {
    for (let i = 0; i < count; i++) text += decimal(values[v+i], path.precision) + ' ';
    text += op + '\n';
  });
  return text;
}
// Outlines whose bounds touch stay together: a hole belongs to its letter. Bounds
// of separate groups never meet, so painting them separately gives the same fill.
function touchingGroups(contours) {
  const parent = contours.map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  let extent = 0, comparisons = 0;
  for (const c of contours) extent += Math.max(c.x1 - c.x0, c.y1 - c.y0);
  const cell = 2 * extent / contours.length || 1, grid = new Map(), large = [];
  const join = (i, j) => {
    const a = contours[i], b = contours[j]; comparisons++;
    if (a.x0 > b.x1 || b.x0 > a.x1 || a.y0 > b.y1 || b.y0 > a.y1) return;
    const x = find(i), y = find(j);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i], x0 = Math.floor(c.x0 / cell), x1 = Math.floor(c.x1 / cell), y0 = Math.floor(c.y0 / cell), y1 = Math.floor(c.y1 / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { large.push(i); continue; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = x + ',' + y, members = grid.get(key);
      if (!members) { grid.set(key, [i]); continue; }
      for (const j of members) join(i, j);
      if (comparisons > COMPARISONS) return null;
      members.push(i);
    }
  }
  if (large.length * contours.length > COMPARISONS) return null;
  for (const i of large) for (let j = 0; j < contours.length; j++) if (j !== i) join(i, j);
  const groups = new Map();
  for (let i = 0; i < contours.length; i++) { const root = find(i), group = groups.get(root); if (group) group.push(i); else groups.set(root, [i]); }
  return [...groups.values()];
}
const isPoint = c => c.x0 === c.x1 && c.y0 === c.y1;
// Viewers may snap a rectangle that is painted alone to whole pixels, so plain
// four-sided outlines remain in the fill they came from.
const isQuad = c => !c.curved && c.segments <= 5;
// Coordinates are relative to the first point and rounded to the path's grid.
// Rounding that point as well keeps every coordinate within one grid step.
function describe(path, group, rule) {
  const unit = 10 ** path.precision, first = path.contours[group[0]], x = path.values[first.value], y = path.values[first.value + 1];
  let key = path.precision + rule;
  for (const index of group) eachSegment(path, index, (op, values, v, count) => {
    key += op;
    for (let i = 0; i < count; i += 2) key += Math.round((values[v+i] - x) * unit) + ' ' + Math.round((values[v+i+1] - y) * unit) + ' ';
  });
  return { group, key, x: Math.round(x * unit), y: Math.round(y * unit) };
}
function splitFill(path, paint) {
  if (!path.plain || (paint !== 'f' && paint !== 'F' && paint !== 'f*') || !path.contours.length) return null;
  const groups = touchingGroups(path.contours);
  if (!groups) return null;
  const rule = paint === 'f*' ? 'f*' : 'f', parts = [];
  for (const group of groups) {
    const only = group.length === 1 ? path.contours[group[0]] : null;
    if (only && isPoint(only)) continue;
    parts.push(only && isQuad(only) ? { group } : describe(path, group, rule));
  }
  return { rule, parts };
}
export function shapeStore(context) {
  const seen = new Map(); let characters = 0, stored = 0;
  const worthStoring = shape => shape.uses > 1 && (shape.uses - 1) * (shape.length * 0.3 - 10) > 220;
  function store(path, part, rule) {
    const unit = 10 ** path.precision; let text = '', x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    const at = value => decimal(value / unit, path.precision);
    const x = path.values[path.contours[part.group[0]].value], y = path.values[path.contours[part.group[0]].value + 1];
    for (const index of part.group) eachSegment(path, index, (op, values, v, count) => {
      for (let i = 0; i < count; i += 2) {
        const px = Math.round((values[v+i] - x) * unit), py = Math.round((values[v+i+1] - y) * unit);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        text += at(px) + ' ' + at(py) + ' ';
      }
      text += op + '\n';
    });
    text += rule;
    const margin = Math.min(MAX_MARGIN, Math.ceil(MARGIN / path.scale));
    const packed = pako.deflate(text, { level: 9 }), smaller = packed.length < text.length;
    const dict = context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [Math.floor(x0/unit)-margin, Math.floor(y0/unit)-margin, Math.ceil(x1/unit)+margin, Math.ceil(y1/unit)+margin], Resources: {}, ...(smaller ? { Filter: 'FlateDecode' } : {}) });
    return context.register(PDFRawStream.of(dict, smaller ? packed : Uint8Array.from(text, c => c.charCodeAt(0))));
  }
  return {
    placed: 0,
    count(path, paint) {
      const fill = splitFill(path, paint);
      if (fill) for (const { key } of fill.parts) if (key) {
        const shape = seen.get(key);
        if (shape) shape.uses++;
        else if (key.length <= SHAPE_CHARACTERS && characters < KEY_CHARACTERS) { characters += key.length; seen.set(key, { uses: 1, length: key.length }); }
      }
    },
    // Writes the fill with its repeated outlines placed by reference, or returns
    // false when it has none and must be written unchanged.
    write(path, paint, output, names) {
      const fill = splitFill(path, paint);
      if (!fill) return false;
      const kept = [], placed = [];
      for (const part of fill.parts) {
        const shape = part.key && seen.get(part.key);
        if (shape && !shape.ref && stored < STORED_SHAPES && worthStoring(shape)) { shape.ref = store(path, part, fill.rule); shape.id = (stored++).toString(36); }
        if (shape?.ref) placed.push({ ...part, shape }); else kept.push(part);
      }
      if (!placed.length) return false;
      // A lone rectangle could be snapped to pixels; leave it company in its fill.
      if (kept.length === 1 && kept[0].group.length === 1) kept.push(placed.pop());
      if (kept.length) {
        for (const index of kept.flatMap(part => part.group).sort((a, b) => a - b)) output(contourText(path, index));
        output(paint + '\n');
      }
      const unit = 10 ** path.precision, at = value => decimal(value / unit, path.precision);
      for (let i = 0; i < placed.length; i += PLACED_TOGETHER) {
        const { x, y } = placed[i];
        let text = `q 1 0 0 1 ${at(x)} ${at(y)} cm\n`;
        for (let j = i; j < Math.min(i + PLACED_TOGETHER, placed.length); j++) {
          const { shape, x: px, y: py } = placed[j], name = names.prefix + shape.id;
          names.used.set(name, shape.ref);
          text += j === i ? `/${name} Do\n` : `q 1 0 0 1 ${at(px - x)} ${at(py - y)} cm/${name} Do Q\n`;
        }
        output(text + 'Q\n');
      }
      this.placed += placed.length;
      return true;
    },
  };
}
// Shapes need names in the stream's own resources. Choose a prefix that cannot
// collide with the names already there.
export function shapeNames(resources) {
  const existing = resources.lookup(N('XObject')), taken = existing instanceof PDFDict ? existing.keys().map(k => k.decodeText()) : [];
  let prefix = 's';
  while (taken.some(name => name.startsWith(prefix))) prefix += 's';
  return { prefix, used: new Map() };
}
export function resourcesWithShapes(context, resources, used) {
  const copy = resources.clone(context), existing = resources.lookup(N('XObject'));
  const objects = existing instanceof PDFDict ? existing.clone(context) : context.obj({});
  for (const [name, ref] of used) objects.set(N(name), ref);
  copy.set(N('XObject'), context.register(objects));
  return context.register(copy);
}
