import {applyEase} from './ease.js';
import {parseColor, rgbaString} from './color.js';
import {morph, parsePath, pathToString, type Path} from './path.js';

const pathCache = new Map<string, Path>();
const parsed = (d: string) => {
  let p = pathCache.get(d);
  if (!p) { p = parsePath(d); if (pathCache.size > 200) pathCache.clear(); pathCache.set(d, p); }
  return p;
};
import {isAnimated, type Keyframe, type Prop, type Wiggle} from './model.js';

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

const interpolate = (a: unknown, b: unknown, p: number): unknown => {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, p);
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => lerp(v as number, (b[i] as number) ?? (v as number), p));
  if (typeof a === 'string' && typeof b === 'string') {
    const ca = parseColor(a), cb = parseColor(b);
    if (ca && cb) return rgbaString(ca.map((v, i) => lerp(v, cb[i], p)) as [number, number, number, number]);
    // Two SVG paths: morph between them.
    if (/^\s*[Mm]/.test(a) && /^\s*[Mm]/.test(b)) {
      if (p <= 0) return a;
      if (p >= 1) return b;
      return pathToString(morph(parsed(a), parsed(b), p));
    }
  }
  return p < 1 ? a : b;
};

// Smooth 1D value noise for wiggle(); deterministic per seed so renders are repeatable.
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const noise = (x: number, seed: number) => {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i + seed * 1000) * 2 - 1, hash(i + 1 + seed * 1000) * 2 - 1, u);
};
const wiggle = (value: unknown, t: number, w: Wiggle): unknown => {
  const off = (dim: number) => noise(t * w.freq, (w.seed ?? 1) + dim * 17.3) * w.amp;
  if (typeof value === 'number') return value + off(0);
  if (Array.isArray(value)) return value.map((v, i) => (v as number) + off(i));
  return value;
};

export const evalKeyframes = <T>(kfs: Keyframe<T>[], t: number): T => {
  if (kfs.length === 0) throw new Error('empty keyframes');
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < kfs.length - 2 && t >= kfs[i + 1].t) i++;
  const a = kfs[i], b = kfs[i + 1];
  const seg = b.t - a.t;
  const p = applyEase(a.ease, seg <= 0 ? 1 : (t - a.t) / seg, seg);
  return interpolate(a.v, b.v, p) as T;
};

// Evaluate any property at time t (seconds, in the layer's composition time).
export function val<T>(p: Prop<T> | undefined, t: number, fallback: T): T {
  if (p === undefined || p === null) return fallback;
  if (!isAnimated(p)) return p as T;
  const sorted = [...p.keyframes].sort((a, b) => a.t - b.t);
  const v = evalKeyframes(sorted, t);
  return (p.wiggle ? wiggle(v, t, p.wiggle) : v) as T;
}
