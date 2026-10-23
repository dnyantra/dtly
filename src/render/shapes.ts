// Shape layers: builds the vector path, then fills/strokes it with trims, dashes, gradients and repeaters.
import {val} from '../core/anim.js';
import type {Gradient, ShapeLayer, Vec2} from '../core/model.js';
import {flatten, parsePath, tracePath, trimPolylines, type Path} from '../core/path.js';

type Ctx = CanvasRenderingContext2D;
const K = 0.5522847498; // circle → cubic handle length

const parsedCache = new Map<string, Path>();
const parse = (d: string) => {
  let p = parsedCache.get(d);
  if (!p) { p = parsePath(d); if (parsedCache.size > 300) parsedCache.clear(); parsedCache.set(d, p); }
  return p;
};

// The shape's outline as a path in layer space (centred on the origin for rect/ellipse/polygon/star).
export const shapePath = (s: ShapeLayer, t: number): Path => {
  switch (s.shape) {
    case 'rect': {
      const [w, h] = val(s.size, t, [200, 200] as Vec2);
      const r = Math.min(val(s.radius, t, 0), Math.abs(w) / 2, Math.abs(h) / 2);
      const x = -w / 2, y = -h / 2, k = r * (1 - K);
      if (r <= 0) return [{kind: 'M', p: [x, y]}, {kind: 'L', p: [x + w, y]}, {kind: 'L', p: [x + w, y + h]}, {kind: 'L', p: [x, y + h]}, {kind: 'Z'}];
      return [
        {kind: 'M', p: [x + r, y]}, {kind: 'L', p: [x + w - r, y]}, {kind: 'C', c1: [x + w - k, y], c2: [x + w, y + k], p: [x + w, y + r]},
        {kind: 'L', p: [x + w, y + h - r]}, {kind: 'C', c1: [x + w, y + h - k], c2: [x + w - k, y + h], p: [x + w - r, y + h]},
        {kind: 'L', p: [x + r, y + h]}, {kind: 'C', c1: [x + k, y + h], c2: [x, y + h - k], p: [x, y + h - r]},
        {kind: 'L', p: [x, y + r]}, {kind: 'C', c1: [x, y + k], c2: [x + k, y], p: [x + r, y]}, {kind: 'Z'},
      ];
    }
    case 'ellipse': {
      const [w, h] = val(s.size, t, [200, 200] as Vec2);
      const a = w / 2, b = h / 2;
      // Starts at the top and runs clockwise, so trim paths draw on like a clock hand (as in AE).
      return [
        {kind: 'M', p: [0, -b]},
        {kind: 'C', c1: [a * K, -b], c2: [a, -b * K], p: [a, 0]},
        {kind: 'C', c1: [a, b * K], c2: [a * K, b], p: [0, b]},
        {kind: 'C', c1: [-a * K, b], c2: [-a, b * K], p: [-a, 0]},
        {kind: 'C', c1: [-a, -b * K], c2: [-a * K, -b], p: [0, -b]},
        {kind: 'Z'},
      ];
    }
    case 'polygon': case 'star': {
      const n = Math.max(3, s.sides ?? (s.shape === 'star' ? 5 : 6));
      const ro = val(s.radius, t, 100), ri = val(s.innerRadius, t, ro * 0.45);
      const count = s.shape === 'star' ? n * 2 : n;
      const out: Path = [];
      for (let i = 0; i < count; i++) {
        const r = s.shape === 'star' && i % 2 ? ri : ro;
        const a = (i / count) * Math.PI * 2 - Math.PI / 2;
        out.push({kind: i ? 'L' : 'M', p: [Math.cos(a) * r, Math.sin(a) * r]});
      }
      out.push({kind: 'Z'});
      return out;
    }
    default: {
      if (s.path !== undefined) return parse(val(s.path, t, ''));
      const pts = s.points ?? [];
      const out: Path = pts.map((p, i) => ({kind: i ? 'L' : 'M', p}));
      if (s.closed ?? s.shape === 'path') out.push({kind: 'Z'});
      return out;
    }
  }
};

const gradient = (ctx: Ctx, g: Gradient) => {
  const grad = 'linear' in g
    ? ctx.createLinearGradient(...g.linear.from, ...g.linear.to)
    : ctx.createRadialGradient(...g.radial.center, 0, ...g.radial.center, g.radial.radius);
  for (const [o, c] of 'linear' in g ? g.linear.stops : g.radial.stops) grad.addColorStop(o, c);
  return grad;
};

const drawOnce = (ctx: Ctx, s: ShapeLayer, path: Path, t: number) => {
  const start = val(s.trim?.start, t, 0) / 100, end = val(s.trim?.end, t, 100) / 100, offset = val(s.trim?.offset, t, 0) / 100;
  const trimmed = !!s.trim && (start > 0 || end < 1 || offset !== 0);
  if (trimmed && Math.abs(end - start) < 1e-4) return;
  ctx.beginPath();
  if (trimmed) {
    for (const line of trimPolylines(flatten(path), start, end, offset)) line.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
  } else tracePath(ctx, path);
  if (s.fill && !trimmed && s.shape !== 'line') {
    ctx.fillStyle = typeof s.fill === 'object' && ('linear' in s.fill || 'radial' in s.fill) ? gradient(ctx, s.fill as Gradient) : val(s.fill as string, t, '#fff');
    ctx.fill(s.fillRule ?? 'nonzero');
  }
  if (s.stroke) {
    ctx.strokeStyle = val(s.stroke, t, '#fff');
    ctx.lineWidth = val(s.strokeWidth, t, 4);
    ctx.lineCap = s.lineCap ?? 'round';
    ctx.lineJoin = s.lineJoin ?? 'round';
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.stroke();
    if (s.dash) ctx.setLineDash([]);
  }
};

export const drawShape = (ctx: Ctx, s: ShapeLayer, t: number) => {
  const path = shapePath(s, t);
  const rep = s.repeater;
  if (!rep) return drawOnce(ctx, s, path, t);
  const copies = Math.max(1, Math.round(val(rep.copies, t, 3)));
  const [dx, dy] = rep.position ?? [100, 0];
  const [sx, sy] = rep.scale ?? [100, 100];
  const [ax, ay] = rep.anchor ?? [0, 0];
  const o0 = (rep.startOpacity ?? 100) / 100, o1 = (rep.endOpacity ?? 100) / 100;
  const base = ctx.globalAlpha;
  for (let i = 0; i < copies; i++) {
    const k = i + (rep.offset ?? 0);
    ctx.save();
    ctx.translate(dx * k + ax, dy * k + ay);
    ctx.rotate(((rep.rotation ?? 0) * k * Math.PI) / 180);
    ctx.scale(Math.pow(sx / 100, k), Math.pow(sy / 100, k));
    ctx.translate(-ax, -ay);
    ctx.globalAlpha = base * (copies > 1 ? o0 + ((o1 - o0) * i) / (copies - 1) : o0);
    drawOnce(ctx, s, path, t);
    ctx.restore();
  }
};
