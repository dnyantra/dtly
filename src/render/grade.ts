// Colour grading: curves, colour wheels, exposure, temperature and 3D LUTs in one per-pixel pass,
// plus a cheap vignette. Per-channel steps fold into three 256-entry tables; LUTs use a prebuilt
// 33³ table with inline trilinear interpolation. Measured cost at 1080×1920: ~25 ms (tables) and
// ~60–90 ms (3D LUT) per frame on one CPU core.
import {val} from '../core/anim.js';
import type {Effect} from '../core/model.js';

type Ctx = CanvasRenderingContext2D;
type Grade = Extract<Effect, {type: 'curves' | 'colorBalance' | 'exposure' | 'temperature' | 'lut'}>;
export const GRADE_TYPES = new Set<Effect['type']>(['curves', 'colorBalance', 'exposure', 'temperature', 'lut']);

// Monotone cubic interpolation through curve points (0..1), like the curves tool in most editors.
const curveTable = (pts: [number, number][] | undefined): Float32Array | null => {
  if (!pts || pts.length < 2) return null;
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length, dx: number[] = [], m: number[] = [], sl: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0] || 1e-6); sl.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  m.push(sl[0]);
  for (let i = 1; i < n - 1; i++) m.push(sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2);
  m.push(sl[n - 2]);
  const out = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    if (x <= p[0][0]) { out[v] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { out[v] = p[n - 1][1]; continue; }
    const h = dx[i], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
    out[v] = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  }
  return out;
};

// Parses an Adobe/Resolve .cube 3D LUT.
export interface Lut { size: number; data: Float32Array; min: number[]; max: number[] }
const lutCache = new Map<string, Lut>();
export const parseCube = (text: string): Lut => {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^LUT_3D_SIZE/i.test(line)) size = parseInt(line.split(/\s+/)[1]);
    else if (/^DOMAIN_MIN/i.test(line)) min = line.split(/\s+/).slice(1).map(Number);
    else if (/^DOMAIN_MAX/i.test(line)) max = line.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(line)) { const v = line.split(/\s+/).map(Number); if (v.length >= 3) values.push(v[0], v[1], v[2]); }
  }
  if (!size || values.length < size ** 3 * 3) throw new Error('Not a 3D .cube LUT');
  return {size, data: Float32Array.from(values), min, max};
};

export interface GradeContext { loadText(src: string): Promise<string> }

export const preloadLuts = async (effects: Effect[], host: GradeContext) => {
  for (const e of effects) if (e.type === 'lut' && !lutCache.has(e.src)) lutCache.set(e.src, parseCube(await host.loadText(e.src)));
};

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Applies all grade effects to the whole canvas in one pass.
export const applyGrade = (ctx: Ctx, w: number, h: number, effects: Grade[], t: number) => {
  if (!effects.length) return;
  // Per-channel tables: exposure → temperature → colour wheels → curves.
  const tables = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) tables[c][v] = v / 255;
  let lut: Lut | undefined, lutMix = 1;
  for (const e of effects) {
    if (e.type === 'exposure') { const k = Math.pow(2, val(e.stops, t, 0)); for (const tb of tables) for (let v = 0; v < 256; v++) tb[v] *= k; }
    else if (e.type === 'temperature') {
      // -100 (cool) … +100 (warm): red up / blue down, gently.
      const a = val(e.amount, t, 0) / 100;
      for (let v = 0; v < 256; v++) { tables[0][v] *= 1 + 0.18 * a; tables[1][v] *= 1 + 0.03 * a; tables[2][v] *= 1 - 0.2 * a; }
    } else if (e.type === 'colorBalance') {
      // Lift/gamma/gain style: shift shadows, midtones and highlights per channel (-1..1).
      const sh = e.shadows ?? [0, 0, 0], mid = e.midtones ?? [0, 0, 0], hi = e.highlights ?? [0, 0, 0];
      for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) {
        const x = tables[c][v];
        const ws = Math.max(0, 1 - x * 3), wh = Math.max(0, x * 3 - 2), wm = 1 - Math.abs(x - 0.5) * 2;
        tables[c][v] = x + sh[c] * 0.25 * ws + mid[c] * 0.25 * wm + hi[c] * 0.25 * wh;
      }
    } else if (e.type === 'curves') {
      const master = curveTable(e.master), per = [curveTable(e.r), curveTable(e.g), curveTable(e.b)];
      for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) {
        let x = Math.min(1, Math.max(0, tables[c][v]));
        if (master) x = master[Math.round(x * 255)];
        if (per[c]) x = per[c]![Math.round(Math.min(1, Math.max(0, x)) * 255)];
        tables[c][v] = x;
      }
    } else if (e.type === 'lut') { lut = lutCache.get(e.src); lutMix = val(e.intensity, t, 100) / 100; }
  }
  const R = new Uint8ClampedArray(256), G = new Uint8ClampedArray(256), B = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) { R[v] = tables[0][v] * 255; G[v] = tables[1][v] * 255; B[v] = tables[2][v] * 255; }

  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  if (!lut) {
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) { d[i] = R[d[i]]; d[i + 1] = G[d[i + 1]]; d[i + 2] = B[d[i + 2]]; } }
  } else {
    const S = lut.size, S2 = S * S, L = lut.data, k = (S - 1) / 255, mix = lutMix, inv = 1 - lutMix;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r0v = R[d[i]], g0v = G[d[i + 1]], b0v = B[d[i + 2]];
      const r = r0v * k, g = g0v * k, b = b0v * k;
      const ri = r | 0, gi = g | 0, bi = b | 0;
      const r1 = ri < S - 1 ? ri + 1 : ri, g1 = gi < S - 1 ? gi + 1 : gi, b1 = bi < S - 1 ? bi + 1 : bi;
      const fr = r - ri, fg = g - gi, fb = b - bi;
      // .cube order: red changes fastest.
      const i000 = (ri + gi * S + bi * S2) * 3, i100 = (r1 + gi * S + bi * S2) * 3, i010 = (ri + g1 * S + bi * S2) * 3, i110 = (r1 + g1 * S + bi * S2) * 3;
      const i001 = (ri + gi * S + b1 * S2) * 3, i101 = (r1 + gi * S + b1 * S2) * 3, i011 = (ri + g1 * S + b1 * S2) * 3, i111 = (r1 + g1 * S + b1 * S2) * 3;
      for (let c = 0; c < 3; c++) {
        const c00 = L[i000 + c] + (L[i100 + c] - L[i000 + c]) * fr, c10 = L[i010 + c] + (L[i110 + c] - L[i010 + c]) * fr;
        const c01 = L[i001 + c] + (L[i101 + c] - L[i001 + c]) * fr, c11 = L[i011 + c] + (L[i111 + c] - L[i011 + c]) * fr;
        const out = ((c00 + (c10 - c00) * fg) * (1 - fb) + (c01 + (c11 - c01) * fg) * fb) * 255;
        const before = c === 0 ? r0v : c === 1 ? g0v : b0v;
        d[i + c] = clamp255(out * mix + before * inv);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
};

// Vignette as a radial-gradient overlay (no per-pixel work).
export const drawVignette = (ctx: Ctx, w: number, h: number, amount: number, softness = 0.5, color = '#000') => {
  if (amount <= 0) return;
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * (1 - softness) * 0.75, w / 2, h / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, color.startsWith('#') && color.length === 7 ? `${color}${Math.round(Math.min(1, amount / 100) * 255).toString(16).padStart(2, '0')}` : color);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
};
