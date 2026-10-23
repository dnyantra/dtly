// A Lottie (Bodymovin) player on Canvas2D, so Lottie files render inside DT.ly in Node and in the browser.
// Supports shape, solid, image, null, precomp and simple text layers; groups, paths, rects, ellipses,
// polystars, fills, strokes (dashes), gradient fills/strokes, trim paths, repeaters; parenting,
// masks (add/subtract/intersect), track mattes (alpha and luma), time stretch and time remap.
// Not supported: expressions, layer effects, merge paths, round corners, 3D layers.
import {applyEase} from '../core/ease.js';

type Ctx = CanvasRenderingContext2D;
type V = number[];
type M = [number, number, number, number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export interface LottieHost { createCanvas(w: number, h: number): {width: number; height: number; getContext(t: '2d'): Ctx}; image(src: string): Promise<{width: number; height: number}> }

const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---- property evaluation ---------------------------------------------------------------------
const first = (v: V | number | undefined, d = 0) => (Array.isArray(v) ? v[0] ?? d : v ?? d);
const lerpAny = (a: J, b: J, p: number): J => {
  if (typeof a === 'number') return a + (b - a) * p;
  if (Array.isArray(a)) return a.map((x, i) => lerpAny(x, b?.[i] ?? x, p));
  if (a && typeof a === 'object' && a.v) return {c: a.c, i: lerpAny(a.i, b.i, p), o: lerpAny(a.o, b.o, p), v: lerpAny(a.v, b.v, p)}; // shape
  return p < 1 ? a : b;
};

const evalProp = (prop: J, f: number): J => {
  if (!prop) return undefined;
  const k = prop.k;
  const animated = prop.a === 1 || (Array.isArray(k) && k.length && typeof k[0] === 'object' && k[0] !== null && 't' in k[0]);
  if (!animated) return k;
  const kfs = k as J[];
  if (f <= kfs[0].t) return kfs[0].s ?? kfs[0].e;
  let i = 0;
  while (i < kfs.length - 1 && f >= kfs[i + 1].t) i++;
  const a = kfs[i], b = kfs[i + 1];
  if (!b || a.s === undefined) return a.s ?? kfs[i - 1]?.e ?? kfs[i - 1]?.s;
  const start = a.s, end = a.e ?? b.s;
  if (a.h === 1 || end === undefined) return start;
  const x = (f - a.t) / (b.t - a.t);
  const ox = first(a.o?.x, 0), oy = first(a.o?.y, 0), ix = first(a.i?.x, 1), iy = first(a.i?.y, 1);
  const p = applyEase([ox, oy, ix, iy], Math.max(0, Math.min(1, x)));
  // Spatial bezier for positions (motion paths).
  if (a.to && a.ti && Array.isArray(start) && start.length >= 2 && (a.to.some((v: number) => v) || a.ti.some((v: number) => v))) {
    const c1 = start.map((v: number, d: number) => v + (a.to[d] ?? 0)), c2 = end.map((v: number, d: number) => v + (a.ti[d] ?? 0)), u = 1 - p;
    return start.map((v: number, d: number) => u * u * u * v + 3 * u * u * p * c1[d] + 3 * u * p * p * c2[d] + p * p * p * end[d]);
  }
  return lerpAny(start, end, p);
};
const num = (prop: J, f: number, d = 0): number => { const v = evalProp(prop, f); return v === undefined ? d : first(v, d); };
const vec = (prop: J, f: number, d: V): V => { const v = evalProp(prop, f); return v === undefined ? d : Array.isArray(v) ? v : [v, v]; };

// Colours are 0..1 in current Lottie files, 0..255 in files from Bodymovin 4.x and older.
const rgba = (c: V, alpha: number) => {
  const k = (c[0] ?? 0) > 1 || (c[1] ?? 0) > 1 || (c[2] ?? 0) > 1 || (c[3] ?? 0) > 1 ? 1 / 255 : 1;
  return `rgba(${Math.round((c[0] ?? 0) * k * 255)},${Math.round((c[1] ?? 0) * k * 255)},${Math.round((c[2] ?? 0) * k * 255)},${Math.max(0, Math.min(1, (c[3] ?? 1 / k) * k * alpha)).toFixed(4)})`;
};

// ---- transforms ------------------------------------------------------------------------------
const transformMatrix = (tr: J, f: number): M => {
  if (!tr) return I;
  const a = vec(tr.a, f, [0, 0]);
  let p: V;
  if (tr.p?.s) p = [num(tr.p.x, f), num(tr.p.y, f)];
  else p = vec(tr.p, f, [0, 0]);
  const s = vec(tr.s, f, [100, 100]);
  const r = ((tr.r ? num(tr.r, f) : num(tr.rz, f)) * Math.PI) / 180;
  const sk = (num(tr.sk, f) * Math.PI) / 180, sa = (num(tr.sa, f) * Math.PI) / 180;
  let m: M = [1, 0, 0, 1, p[0] ?? 0, p[1] ?? 0];
  m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
  if (sk) {
    const c = Math.cos(sa), si = Math.sin(sa);
    m = mul(m, mul(mul([c, si, -si, c, 0, 0], [1, 0, Math.tan(-sk), 1, 0, 0]), [c, -si, si, c, 0, 0]));
  }
  m = mul(m, [(s[0] ?? 100) / 100, 0, 0, (s[1] ?? 100) / 100, 0, 0]);
  return mul(m, [1, 0, 0, 1, -(a[0] ?? 0), -(a[1] ?? 0)]);
};
const opacityOf = (tr: J, f: number) => (tr?.o ? num(tr.o, f, 100) / 100 : 1);

// ---- geometry --------------------------------------------------------------------------------
type Sub = {pts: [number, number][]; segs: ([number, number] | null)[][]; closed: boolean}; // cubic segments in matrix space
type Geo = {subs: {start: [number, number]; cubics: [number, number, number, number, number, number][]; closed: boolean}[]};

const shapeToGeo = (sh: J, m: M, reverse = false): Geo => {
  if (Array.isArray(sh)) sh = sh[0]; // animated shapes keep their value wrapped in an array
  if (!sh?.v?.length) return {subs: []};
  let v: V[] = sh.v, ii: V[] = sh.i ?? [], oo: V[] = sh.o ?? [];
  if (reverse) { v = [...v].reverse(); const ni = [...oo].reverse(), no = [...ii].reverse(); ii = ni; oo = no; }
  const n = v.length, cubics: Geo['subs'][0]['cubics'] = [];
  const P = (j: number) => apply(m, v[j][0], v[j][1]);
  const segCount = sh.c ? n : n - 1;
  for (let j = 0; j < segCount; j++) {
    const k = (j + 1) % n;
    const c1 = apply(m, v[j][0] + (oo[j]?.[0] ?? 0), v[j][1] + (oo[j]?.[1] ?? 0));
    const c2 = apply(m, v[k][0] + (ii[k]?.[0] ?? 0), v[k][1] + (ii[k]?.[1] ?? 0));
    const e = P(k);
    cubics.push([c1[0], c1[1], c2[0], c2[1], e[0], e[1]]);
  }
  return {subs: [{start: P(0), cubics, closed: !!sh.c}]};
};

const K = 0.5522847498;
const ellipseGeo = (it: J, f: number, m: M): Geo => {
  const [cx, cy] = vec(it.p, f, [0, 0]), [w, h] = vec(it.s, f, [0, 0]);
  const a = w / 2, b = h / 2;
  const sh = {c: true, v: [[cx, cy - b], [cx + a, cy], [cx, cy + b], [cx - a, cy]], o: [[a * K, 0], [0, b * K], [-a * K, 0], [0, -b * K]], i: [[-a * K, 0], [0, -b * K], [a * K, 0], [0, b * K]]};
  return shapeToGeo(sh, m, it.d === 3);
};
const rectGeo = (it: J, f: number, m: M): Geo => {
  const [cx, cy] = vec(it.p, f, [0, 0]), [w, h] = vec(it.s, f, [0, 0]);
  const r = Math.min(num(it.r, f), w / 2, h / 2), x = cx - w / 2, y = cy - h / 2, k = r * K;
  const sh = r > 0
    ? {c: true, v: [[x + w, y + r], [x + w, y + h - r], [x + w - r, y + h], [x + r, y + h], [x, y + h - r], [x, y + r], [x + r, y], [x + w - r, y]], i: [[0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0]], o: [[0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k], [0, 0], [k, 0]]}
    : {c: true, v: [[x + w, y], [x + w, y + h], [x, y + h], [x, y]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]]};
  return shapeToGeo(sh, m, it.d === 3);
};
const starGeo = (it: J, f: number, m: M): Geo => {
  const pts = Math.max(3, Math.round(num(it.pt, f, 5))), [cx, cy] = vec(it.p, f, [0, 0]);
  const rot = ((num(it.r, f) - 90) * Math.PI) / 180, or = num(it.or, f, 100), ir = num(it.ir, f, 50);
  const count = it.sy === 1 ? pts * 2 : pts, v: V[] = [];
  for (let i = 0; i < count; i++) { const rr = it.sy === 1 && i % 2 ? ir : or; const a = rot + (i / count) * Math.PI * 2; v.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return shapeToGeo({c: true, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0])}, m, it.d === 3);
};

const traceGeo = (ctx: Ctx, g: Geo) => {
  for (const s of g.subs) {
    ctx.moveTo(...s.start);
    for (const c of s.cubics) ctx.bezierCurveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
    if (s.closed) ctx.closePath();
  }
};

// Trim paths on cubic geometry: flatten, then cut by length.
const trimGeo = (g: Geo, start: number, end: number, offset: number): Geo => {
  const subs = g.subs.map((s) => {
    const pts: [number, number][] = [s.start];
    let last = s.start;
    for (const c of s.cubics) {
      const n = 24;
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        pts.push([u * u * u * last[0] + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * c[4], u * u * u * last[1] + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5]]);
      }
      last = [c[4], c[5]];
    }
    return pts;
  });
  const lens = subs.map((pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0));
  const total = lens.reduce((a, b) => a + b, 0);
  if (!total) return {subs: []};
  let s0 = Math.min(start, end) + offset, s1 = Math.max(start, end) + offset;
  const shift = Math.floor(s0); s0 -= shift; s1 -= shift;
  const ranges: [number, number][] = s1 <= 1 ? [[s0, s1]] : [[s0, 1], [0, s1 - 1]];
  const out: Geo = {subs: []};
  for (const [ra, rb] of ranges) {
    const from = ra * total, to = rb * total;
    let acc = 0;
    subs.forEach((pts) => {
      let line: [number, number][] | null = null;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1], l = Math.hypot(q[0] - p[0], q[1] - p[1]), a0 = acc, a1 = acc + l;
        acc = a1;
        if (a1 < from || a0 > to || !l) continue;
        const at = (d: number): [number, number] => { const k = (d - a0) / l; return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]; };
        if (!line) line = [at(Math.max(from, a0))];
        line.push(at(Math.min(to, a1)));
      }
      if (line && line.length > 1) out.subs.push({start: line[0], cubics: line.slice(1).map((p, i) => { const a = line![i]; return [a[0], a[1], p[0], p[1], p[0], p[1]]; }), closed: false});
    });
  }
  return out;
};

// ---- shape item tree ---------------------------------------------------------------------------
type Paint = {kind: 'fill' | 'stroke'; it: J; geos: Geo[]; alpha: number; m: M};

const gradientStyle = (ctx: Ctx, it: J, f: number, m: M, alpha: number) => {
  const s = vec(it.s, f, [0, 0]), e = vec(it.e, f, [0, 0]);
  const [x0, y0] = apply(m, s[0], s[1]), [x1, y1] = apply(m, e[0], e[1]);
  const grad = it.t === 2 ? ctx.createRadialGradient(x0, y0, 0, x0, y0, Math.hypot(x1 - x0, y1 - y0)) : ctx.createLinearGradient(x0, y0, x1, y1);
  const n = it.g?.p ?? 0, raw: V = evalProp(it.g?.k, f) ?? [];
  const alphaAt = (pos: number) => {
    const op = raw.slice(n * 4);
    if (op.length < 2) return 1;
    for (let j = 0; j < op.length - 2; j += 2) if (pos >= op[j] && pos <= op[j + 2]) { const k = (pos - op[j]) / ((op[j + 2] - op[j]) || 1); return op[j + 1] + (op[j + 3] - op[j + 1]) * k; }
    return pos < op[0] ? op[1] : op[op.length - 1];
  };
  for (let j = 0; j < n; j++) { const pos = raw[j * 4]; grad.addColorStop(Math.max(0, Math.min(1, pos)), rgba([raw[j * 4 + 1], raw[j * 4 + 2], raw[j * 4 + 3], alphaAt(pos)], alpha)); }
  return grad;
};

const paintAll = (ctx: Ctx, paints: Paint[], f: number) => {
  // Lower items render first (AE stacking): paints were collected top-down.
  for (let i = paints.length - 1; i >= 0; i--) {
    const {kind, it, geos, alpha, m} = paints[i];
    if (!geos.length || it.hd) continue;
    ctx.beginPath();
    for (const g of geos) traceGeo(ctx, g);
    const o = num(it.o, f, 100) / 100 * alpha;
    if (kind === 'fill') {
      ctx.fillStyle = it.ty === 'gf' ? gradientStyle(ctx, it, f, m, o) : rgba(vec(it.c, f, [0, 0, 0, 1]), o);
      ctx.fill(it.r === 2 ? 'evenodd' : 'nonzero');
    } else {
      ctx.strokeStyle = it.ty === 'gs' ? gradientStyle(ctx, it, f, m, o) : rgba(vec(it.c, f, [0, 0, 0, 1]), o);
      ctx.lineWidth = num(it.w, f, 1) * (paintScale.get(it) ?? 1);
      ctx.lineCap = (['butt', 'butt', 'round', 'square'] as const)[it.lc ?? 2] ?? 'round';
      ctx.lineJoin = (['miter', 'miter', 'round', 'bevel'] as const)[it.lj ?? 2] ?? 'round';
      ctx.miterLimit = it.ml ?? 4;
      if (it.d?.length) {
        const d = it.d.filter((x: J) => x.n !== 'o').map((x: J) => num(x.v, f) * (paintScale.get(it) ?? 1));
        ctx.setLineDash(d);
        const off = it.d.find((x: J) => x.n === 'o');
        ctx.lineDashOffset = off ? num(off.v, f) : 0;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
};
// Stroke widths and gradients are in shape space; geometry is already in layer pixels, so remember the scale.
const paintScale = new WeakMap<object, number>();

const collect = (items: J[], f: number, m: M, alpha: number, paints: Paint[], geos: Geo[]) => {
  const tr = items.find((it) => it.ty === 'tr');
  const gm = tr ? mul(m, transformMatrix(tr, f)) : m;
  const ga = alpha * (tr ? opacityOf(tr, f) : 1);
  const scale = Math.sqrt(Math.abs(gm[0] * gm[3] - gm[1] * gm[2]));
  const local: Geo[] = [];
  const localPaints: Paint[] = [];
  for (const it of items) {
    if (it.hd) continue;
    switch (it.ty) {
      case 'sh': local.push(shapeToGeo(evalProp(it.ks, f), gm, it.d === 3)); break;
      case 'el': local.push(ellipseGeo(it, f, gm)); break;
      case 'rc': local.push(rectGeo(it, f, gm)); break;
      case 'sr': local.push(starGeo(it, f, gm)); break;
      case 'gr': collect(it.it ?? [], f, gm, ga, localPaints, local); break;
      case 'fl': case 'gf': localPaints.push({kind: 'fill', it, geos: [...local], alpha: ga, m: gm}); break;
      case 'st': case 'gs': paintScale.set(it, scale); localPaints.push({kind: 'stroke', it, geos: [...local], alpha: ga, m: gm}); break;
      case 'tm': {
        const s = num(it.s, f) / 100, e = num(it.e, f, 100) / 100, o = num(it.o, f) / 360;
        const trimmed = local.map((g) => trimGeo(g, s, e, o));
        local.splice(0, local.length, ...trimmed);
        break;
      }
      case 'rp': {
        const copies = Math.round(num(it.c, f, 1)), off = num(it.o, f), rtr = it.tr;
        const base = [...local];
        const so = rtr?.so ? num(rtr.so, f, 100) / 100 : 1, eo = rtr?.eo ? num(rtr.eo, f, 100) / 100 : 1;
        local.length = 0;
        const step = transformMatrix(rtr, f);
        for (let c = 0; c < copies; c++) {
          let rm: M = I;
          for (let k = 0; k < c + off; k++) rm = mul(rm, step);
          const inv = invert(gm);
          const toGroup = inv ? mul(gm, mul(rm, inv)) : I;
          for (const g of base) local.push({subs: g.subs.map((s) => ({start: apply(toGroup, ...s.start), cubics: s.cubics.map((c3) => { const a = apply(toGroup, c3[0], c3[1]), b = apply(toGroup, c3[2], c3[3]), e = apply(toGroup, c3[4], c3[5]); return [a[0], a[1], b[0], b[1], e[0], e[1]] as [number, number, number, number, number, number]; }), closed: s.closed}))});
          void so; void eo;
        }
        break;
      }
      default: break; // tr handled above; mm/rd/op ignored
    }
  }
  // Paints apply to geometry above them in their group (and nested groups' geometry).
  paints.push(...localPaints);
  geos.push(...local);
};
const invert = (m: M): M | null => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

// ---- player ----------------------------------------------------------------------------------
export class LottiePlayer {
  readonly w: number; readonly h: number; readonly fr: number; readonly ip: number; readonly op: number;
  private assets = new Map<string, J>();
  private images = new Map<string, {width: number; height: number}>();
  private pool: {width: number; height: number; getContext(t: '2d'): Ctx}[] = [];

  constructor(public data: J, private host: LottieHost) {
    this.w = data.w; this.h = data.h; this.fr = data.fr || 30; this.ip = data.ip ?? 0; this.op = data.op ?? 60;
    for (const a of data.assets ?? []) this.assets.set(a.id, a);
  }
  get duration() { return (this.op - this.ip) / this.fr; }

  async preload() {
    for (const a of this.data.assets ?? []) {
      if (!a.p || a.layers) continue;
      const src = a.e === 1 || String(a.p).startsWith('data:') ? a.p : `${a.u ?? ''}${a.p}`;
      try { this.images.set(a.id, await this.host.image(src)); } catch { /* missing image: skip */ }
    }
  }

  private buf(w: number, h: number) {
    const c = this.pool.find((x) => x.width === w && x.height === h);
    if (c) { this.pool.splice(this.pool.indexOf(c), 1); const ctx = c.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h); return c; }
    return this.host.createCanvas(w, h);
  }
  private release(c: {width: number; height: number; getContext(t: '2d'): Ctx}) { if (this.pool.length < 8) this.pool.push(c); }

  // Draws frame `f` (Lottie frame number) into ctx, in the animation's own w×h space under the ctx transform.
  draw(ctx: Ctx, f: number) {
    this.drawLayers(ctx, this.data.layers ?? [], f, this.w, this.h);
  }

  private layerMatrix(layer: J, byInd: Map<number, J>, f: number, depth = 0): M {
    let m = transformMatrix(layer.ks, f);
    if (layer.parent !== undefined && depth < 30) {
      const p = byInd.get(layer.parent);
      if (p) m = mul(this.layerMatrix(p, byInd, f, depth + 1), m);
    }
    return m;
  }

  private drawLayers(ctx: Ctx, layers: J[], f: number, w: number, h: number) {
    const byInd = new Map<number, J>();
    for (const l of layers) if (l.ind !== undefined) byInd.set(l.ind, l);
    const base = ctx.getTransform();
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.td || layer.hd) continue; // matte sources draw only through the layer below them
      if (f < (layer.ip ?? -Infinity) || f >= (layer.op ?? Infinity)) continue;
      const matte = layer.tt ? layers[i - 1] : null;
      if (!layer.masksProperties?.length && !matte) {
        ctx.save();
        this.drawLayer(ctx, layer, byInd, f, base);
        ctx.restore();
        continue;
      }
      // Masks and mattes: render into full-size buffers in the current device space.
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const b = this.buf(W, H), bc = b.getContext('2d');
      bc.setTransform(base);
      this.drawLayer(bc, layer, byInd, f, base);
      if (layer.masksProperties?.length) this.applyMasks(bc, layer, byInd, f, base, W, H);
      if (matte) {
        const mb = this.buf(W, H), mc = mb.getContext('2d');
        mc.setTransform(base);
        this.drawLayer(mc, matte, byInd, f, base);
        if (layer.tt === 3 || layer.tt === 4) lumaToAlpha(mc, W, H, layer.tt === 4);
        bc.setTransform(1, 0, 0, 1, 0, 0);
        bc.globalCompositeOperation = layer.tt === 2 ? 'destination-out' : 'destination-in';
        bc.drawImage(mb as unknown as CanvasImageSource, 0, 0);
        this.release(mb);
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(b as unknown as CanvasImageSource, 0, 0);
      ctx.restore();
      this.release(b);
    }
    void w; void h;
  }

  private applyMasks(bc: Ctx, layer: J, byInd: Map<number, J>, f: number, base: DOMMatrix, W: number, H: number) {
    const m = this.layerMatrix(layer, byInd, f);
    const mk = this.buf(W, H), mc = mk.getContext('2d');
    const masks = layer.masksProperties.filter((x: J) => x.mode !== 'n');
    if (!masks.length) { this.release(mk); return; }
    if (masks[0].mode === 's') { mc.fillStyle = '#000'; mc.fillRect(0, 0, W, H); }
    for (const mask of masks) {
      mc.setTransform(base);
      mc.transform(...m);
      mc.beginPath();
      traceGeo(mc, shapeToGeo(evalProp(mask.pt, f), I));
      const o = num(mask.o, f, 100) / 100;
      mc.fillStyle = `rgba(0,0,0,${o})`;
      if (mask.inv) { mc.rect(-1e5, -1e5, 2e5, 2e5); }
      mc.globalCompositeOperation = mask.mode === 's' ? 'destination-out' : mask.mode === 'i' ? 'destination-in' : 'source-over';
      mc.fill(mask.inv ? 'evenodd' : 'nonzero');
    }
    bc.save();
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = 'destination-in';
    bc.drawImage(mk as unknown as CanvasImageSource, 0, 0);
    bc.restore();
    this.release(mk);
  }

  private drawLayer(ctx: Ctx, layer: J, byInd: Map<number, J>, f: number, base: DOMMatrix) {
    const m = this.layerMatrix(layer, byInd, f);
    const alpha = opacityOf(layer.ks, f);
    if (alpha <= 0) return;
    ctx.setTransform(base);
    ctx.globalAlpha *= alpha;
    const lf = (f - (layer.st ?? 0)) / (layer.sr ?? 1);
    switch (layer.ty) {
      case 4: {
        const paints: Paint[] = [];
        collect(layer.shapes ?? [], lf, m, 1, paints, []);
        ctx.setTransform(base);
        paintAll(ctx, paints, lf);
        break;
      }
      case 1: {
        ctx.transform(...m);
        ctx.fillStyle = layer.sc ?? '#000';
        ctx.fillRect(0, 0, layer.sw ?? 0, layer.sh ?? 0);
        break;
      }
      case 2: {
        const img = this.images.get(layer.refId);
        if (img) { ctx.transform(...m); ctx.drawImage(img as unknown as CanvasImageSource, 0, 0); }
        break;
      }
      case 0: {
        const asset = this.assets.get(layer.refId);
        if (!asset?.layers) break;
        ctx.transform(...m);
        ctx.beginPath();
        ctx.rect(0, 0, layer.w ?? this.w, layer.h ?? this.h);
        ctx.clip();
        const tf = layer.tm ? num(layer.tm, lf) * this.fr : lf;
        this.drawLayers(ctx, asset.layers, tf, layer.w, layer.h);
        break;
      }
      case 5: {
        const v = evalProp(layer.t?.d, lf);
        const doc = v?.t !== undefined && typeof v.t === 'string' ? v : v?.s ?? layer.t?.d?.k?.[0]?.s;
        if (!doc?.t) break;
        ctx.transform(...m);
        const font = (this.data.fonts?.list ?? []).find((x: J) => x.fName === doc.f);
        ctx.font = `${font?.fWeight ?? (/bold/i.test(doc.f ?? '') ? 700 : 400)} ${doc.s ?? 24}px "${font?.fFamily ?? 'Mukta'}", "Baloo 2", sans-serif`;
        ctx.fillStyle = rgba(doc.fc ?? [0, 0, 0], 1);
        ctx.textAlign = (['left', 'right', 'center'] as const)[doc.j ?? 0] ?? 'left';
        // Tracking is in thousandths of an em.
        if ('letterSpacing' in ctx) (ctx as unknown as {letterSpacing: string}).letterSpacing = `${((doc.tr ?? 0) / 1000) * (doc.s ?? 24)}px`;
        const lh = doc.lh ?? (doc.s ?? 24) * 1.2;
        String(doc.t).split(/\r|\n/).forEach((line: string, i: number) => ctx.fillText(line, 0, i * lh));
        break;
      }
      default: break;
    }
  }
}

const lumaToAlpha = (ctx: Ctx, w: number, h: number, invert: boolean) => {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255) * (d[i + 3] / 255);
    d[i + 3] = Math.round((invert ? 1 - l : l) * 255);
  }
  ctx.putImageData(img, 0, 0);
};
