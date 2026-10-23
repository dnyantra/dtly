// Layer bounds for selection outlines and click-to-select in the viewer.
import {val} from '../../core/anim.js';
import type {Composition, Layer, Vec2} from '../../core/model.js';
import {displayText, fontString, layoutText} from '../../core/text.js';
import type {Renderer} from '../../render/renderer.js';
import {pathBounds} from '../../core/path.js';
import {shapePath} from '../../render/shapes.js';

type M = [number, number, number, number, number, number];
export const apply = (m: M, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const invert = (m: M): M | null => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

// Content rectangle [x, y, w, h] in layer space.
export const layerRect = (layer: Layer, comp: Composition, t: number, r: Renderer, ctx: CanvasRenderingContext2D): [number, number, number, number] | null => {
  switch (layer.type) {
    case 'solid': case 'image': case 'video': case 'precomp': {
      const [w, h] = r.layerSize(layer, comp, t);
      return [0, 0, w, h];
    }
    case 'shape': {
      const b = pathBounds(shapePath(layer, t));
      if (!b) return null;
      const pad = layer.stroke ? val(layer.strokeWidth, t, 4) / 2 + 2 : 0;
      return [b[0] - pad, b[1] - pad, b[2] + pad * 2, b[3] + pad * 2];
    }
    case 'text': {
      const size = val(layer.size, t, 72);
      const L = layoutText(ctx, {...layer, text: displayText(layer, t)}, size, val(layer.tracking, t, 0), fontString(layer, size, r.host.defaultFont));
      const x0 = Math.min(...L.lines.map((l) => l.x));
      return [x0, L.top, L.width, L.height];
    }
    default: return null;
  }
};

export const layerQuad = (layer: Layer, comp: Composition, t: number, r: Renderer, ctx: CanvasRenderingContext2D): Vec2[] | null => {
  const rect = layerRect(layer, comp, t, r, ctx);
  if (!rect) return null;
  const m = r.matrix(layer, comp, t) as M;
  const [x, y, w, h] = rect;
  return [apply(m, [x, y]), apply(m, [x + w, y]), apply(m, [x + w, y + h]), apply(m, [x, y + h])];
};

// Topmost visible layer under a comp-space point.
export const hitTest = (pt: Vec2, comp: Composition, t: number, r: Renderer, ctx: CanvasRenderingContext2D): string | null => {
  for (const layer of comp.layers) {
    if (layer.hidden || layer.type === 'audio' || layer.type === 'null' || layer.type === 'adjustment' || !r.isActive(layer, comp, t)) continue;
    const rect = layerRect(layer, comp, t, r, ctx);
    const inv = invert(r.matrix(layer, comp, t) as M);
    if (!rect || !inv) continue;
    const [lx, ly] = apply(inv, pt);
    if (lx >= rect[0] && lx <= rect[0] + rect[2] && ly >= rect[1] && ly <= rect[1] + rect[3]) return layer.id;
  }
  return null;
};
