// SVG import: turns an SVG (logo, icon, illustration) into editable DT.ly shape layers.
// Handles path/rect/circle/ellipse/line/polyline/polygon, nested <g> transforms, viewBox,
// fill/stroke/opacity from attributes, inline style and simple <style> class rules,
// and linear/radial gradients (approximated in user space).
import type {Gradient, NewLayer, Vec2} from './model.js';
import {parseColor, rgbaString} from './color.js';
import {flatten, parsePath, pathBounds, pathToString, transformPath, type Path} from './path.js';

type M = [number, number, number, number, number, number];
interface El { tag: string; attrs: Record<string, string>; children: El[]; text: string }

const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const I: M = [1, 0, 0, 1, 0, 0];

// A small, forgiving XML parser (SVGs from design tools and icon sets).
export const parseXml = (src: string): El => {
  const root: El = {tag: '#root', attrs: {}, children: [], text: ''};
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = (a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const el: El = {tag: m[3].replace(/^svg:/, ''), attrs, children: [], text: ''};
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += m[6];
  }
  return root;
};

const parseTransform = (s: string | undefined): M => {
  if (!s) return I;
  let m = I;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let n: M = I;
    if (fn === 'matrix') n = a as M;
    else if (fn === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') n = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s2 = Math.sin(r);
      n = [c, s2, -s2, c, 0, 0];
      if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
    } else if (fn === 'skewX') n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
};

const num = (v: string | undefined, d = 0) => (v === undefined || v === '' ? d : v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));

const elementPath = (el: El): Path | null => {
  const a = el.attrs;
  switch (el.tag) {
    case 'path': return a.d ? parsePath(a.d) : null;
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      let rx = num(a.rx, NaN), ry = num(a.ry, NaN);
      if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
      if (isNaN(ry)) ry = rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx) return parsePath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
      return parsePath(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`);
    }
    case 'circle': case 'ellipse': {
      const cx = num(a.cx), cy = num(a.cy), rx = el.tag === 'circle' ? num(a.r) : num(a.rx), ry = el.tag === 'circle' ? num(a.r) : num(a.ry);
      return parsePath(`M${cx} ${cy - ry}A${rx} ${ry} 0 1 1 ${cx} ${cy + ry}A${rx} ${ry} 0 1 1 ${cx} ${cy - ry}Z`);
    }
    case 'line': return parsePath(`M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`);
    case 'polyline': case 'polygon': {
      const n = (a.points ?? '').trim().split(/[\s,]+/).map(Number);
      if (n.length < 4) return null;
      return parsePath(`M${n[0]} ${n[1]}${Array.from({length: n.length / 2 - 1}, (_, i) => `L${n[2 * i + 2]} ${n[2 * i + 3]}`).join('')}${el.tag === 'polygon' ? 'Z' : ''}`);
    }
    default: return null;
  }
};

interface Style { fill: string; stroke: string; strokeWidth: number; opacity: number; fillOpacity: number; strokeOpacity: number; fillRule?: string; lineCap?: string; lineJoin?: string; display?: string }

const PAINT_PROPS = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'display', 'visibility'];

export interface SvgImportOptions { name?: string; width?: number; position?: Vec2; color?: string; inPoint?: number }

export interface SvgImportResult { layers: NewLayer[]; size: Vec2; parts: number }

// Converts SVG text into layers: one null "group" layer plus one shape layer per drawable element.
export const importSvg = (svg: string, opts: SvgImportOptions = {}): SvgImportResult => {
  const root = parseXml(svg).children.find((c) => c.tag === 'svg');
  if (!root) throw new Error('Not an SVG file');
  const vb = (root.attrs.viewBox ?? '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 ? vb[2] : num(root.attrs.width, 100), vbH = vb.length === 4 ? vb[3] : num(root.attrs.height, 100);
  const vbX = vb.length === 4 ? vb[0] : 0, vbY = vb.length === 4 ? vb[1] : 0;
  const targetW = opts.width ?? 600;
  const k = targetW / vbW;
  const size: Vec2 = [targetW, vbH * k];
  // viewBox → layer space centred on the group's origin.
  const base: M = [k, 0, 0, k, -vbX * k - size[0] / 2, -vbY * k - size[1] / 2];

  // Class rules from <style> blocks (".a{fill:#f00}" / ".a,.b{...}").
  const classes: Record<string, Record<string, string>> = {};
  const gradients: Record<string, El> = {};
  const walkDefs = (el: El) => {
    if (el.tag === 'style') for (const [, sel, body] of el.text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decl = Object.fromEntries(body.split(';').map((d) => d.split(':').map((x) => x.trim())).filter((d) => d.length === 2 && d[0]));
      for (const s of sel.split(',')) { const c = s.trim().match(/^\.([\w-]+)$/); if (c) classes[c[1]] = {...classes[c[1]], ...decl}; }
    }
    if ((el.tag === 'linearGradient' || el.tag === 'radialGradient') && el.attrs.id) gradients[el.attrs.id] = el;
    el.children.forEach(walkDefs);
  };
  walkDefs(root);

  const props = (el: El) => {
    const out: Record<string, string> = {};
    for (const c of (el.attrs.class ?? '').split(/\s+/)) Object.assign(out, classes[c] ?? {});
    for (const p of PAINT_PROPS) if (el.attrs[p] !== undefined) out[p] = el.attrs[p];
    for (const d of (el.attrs.style ?? '').split(';')) { const [kk, v] = d.split(':').map((x) => x?.trim()); if (kk && v) out[kk] = v; }
    return out;
  };

  const color = (v: string, opacity: number, m: M, bbox: [number, number, number, number] | null): string | Gradient | undefined => {
    if (!v || v === 'none' || v === 'transparent') return undefined;
    if (v === 'currentColor') v = opts.color ?? '#000000';
    const ref = v.match(/url\(#([^)]+)\)/);
    if (ref) {
      const g = gradients[ref[1]];
      const stops: [number, string][] = (g?.children ?? []).filter((c) => c.tag === 'stop').map((st) => {
        const sp = {...Object.fromEntries((st.attrs.style ?? '').split(';').map((d) => d.split(':').map((x) => x.trim())).filter((d) => d.length === 2)), ...st.attrs};
        const off = sp.offset?.endsWith('%') ? parseFloat(sp.offset) / 100 : num(sp.offset);
        const c = parseColor(sp['stop-color'] ?? '#000') ?? [0, 0, 0, 1];
        return [off, rgbaString([c[0], c[1], c[2], c[3] * num(sp['stop-opacity'], 1) * opacity])];
      });
      if (!g || !stops.length) return undefined;
      // Default gradientUnits is objectBoundingBox: 0..1 across the shape's own bounds.
      const box = g.attrs.gradientUnits === 'userSpaceOnUse' ? null : bbox;
      const U = (x: number, y: number): Vec2 => (box ? [box[0] + x * box[2], box[1] + y * box[3]] : [x, y]);
      const gt = parseTransform(g.attrs.gradientTransform);
      const T = (x: number, y: number): Vec2 => { const [ux, uy] = U(x, y); const gx = gt[0] * ux + gt[2] * uy + gt[4], gy = gt[1] * ux + gt[3] * uy + gt[5]; return [m[0] * gx + m[2] * gy + m[4], m[1] * gx + m[3] * gy + m[5]]; };
      if (g.tag === 'linearGradient') return {linear: {from: T(num(g.attrs.x1), num(g.attrs.y1)), to: T(num(g.attrs.x2, 1), num(g.attrs.y2)), stops}};
      const r = num(g.attrs.r, 0.5) * (box ? Math.max(box[2], box[3]) : 1) * Math.hypot(m[0], m[1]) * Math.hypot(gt[0], gt[1]);
      return {radial: {center: T(num(g.attrs.cx, 0.5), num(g.attrs.cy, 0.5)), radius: r, stops}};
    }
    const c = parseColor(v);
    if (!c) return v;
    return opacity < 1 || c[3] < 1 ? rgbaString([c[0], c[1], c[2], c[3] * opacity]) : v;
  };

  const groupName = opts.name ?? 'svg';
  const layers: NewLayer[] = [];
  const shapes: NewLayer[] = [];
  let index = 0;
  const visit = (el: El, m: M, inherited: Style) => {
    if (['defs', 'style', 'title', 'desc', 'metadata', 'clipPath', 'mask', 'symbol', 'linearGradient', 'radialGradient', 'pattern', 'filter'].includes(el.tag)) return;
    const p = props(el);
    const st: Style = {
      fill: p.fill ?? inherited.fill, stroke: p.stroke ?? inherited.stroke,
      strokeWidth: p['stroke-width'] !== undefined ? parseFloat(p['stroke-width']) : inherited.strokeWidth,
      opacity: inherited.opacity * num(p.opacity, 1), fillOpacity: p['fill-opacity'] !== undefined ? num(p['fill-opacity'], 1) : inherited.fillOpacity,
      strokeOpacity: p['stroke-opacity'] !== undefined ? num(p['stroke-opacity'], 1) : inherited.strokeOpacity,
      fillRule: p['fill-rule'] ?? inherited.fillRule, lineCap: p['stroke-linecap'] ?? inherited.lineCap, lineJoin: p['stroke-linejoin'] ?? inherited.lineJoin,
      display: p.display === 'none' || p.visibility === 'hidden' ? 'none' : inherited.display,
    };
    if (st.display === 'none') return;
    const mm = mul(m, parseTransform(el.attrs.transform));
    const path = elementPath(el);
    if (path && flatten(path).length) {
      const baked = transformPath(path, mm);
      const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      const bbox = pathBounds(path);
      const fill = el.tag === 'line' || el.tag === 'polyline' ? undefined : color(st.fill, st.opacity * st.fillOpacity, mm, bbox);
      const stroke = color(st.stroke, st.opacity * st.strokeOpacity, mm, bbox);
      if (fill || stroke) {
        shapes.push({
          type: 'shape', name: el.attrs.id ?? `${groupName}-part-${++index}`, shape: 'path', path: pathToString(baked), parent: '__group__',
          transform: {anchor: [0, 0], position: [0, 0]},
          ...(fill ? {fill} : {}), ...(typeof stroke === 'string' ? {stroke, strokeWidth: +(st.strokeWidth * scale).toFixed(2)} : {}),
          ...(st.fillRule === 'evenodd' ? {fillRule: 'evenodd'} : {}),
          ...(st.lineCap ? {lineCap: st.lineCap} : {}), ...(st.lineJoin ? {lineJoin: st.lineJoin} : {}),
          ...(opts.inPoint !== undefined ? {inPoint: opts.inPoint} : {}),
        } as NewLayer);
      }
    }
    for (const c of el.children) visit(c, mm, st);
  };
  visit(root, base, {fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1});

  layers.push({type: 'null', name: groupName, transform: {position: opts.position ?? [540, 960]}, ...(opts.inPoint !== undefined ? {inPoint: opts.inPoint} : {})} as NewLayer);
  // Topmost SVG element = top layer (index 0), as in the drawing order of the file.
  layers.push(...shapes.reverse());
  return {layers, size, parts: shapes.length};
};
