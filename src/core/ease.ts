import type {Ease} from './model.js';

// Cubic-bezier solver (same curve definition as CSS / AE's speed graph handles).
const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
};

const CURVES: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easyEase: [0.333, 0, 0.667, 1], // AE "Easy Ease" (33% influence both sides)
  quadOut: [0.25, 0.46, 0.45, 0.94],
  cubicOut: [0.215, 0.61, 0.355, 1],
  expoIn: [0.95, 0.05, 0.795, 0.035],
  expoOut: [0.19, 1, 0.22, 1],
  expoInOut: [1, 0, 0, 1],
  backOut: [0.175, 0.885, 0.32, 1.275],
  backIn: [0.6, -0.28, 0.735, 0.045],
};

const cache = new Map<string, (x: number) => number>();

const elasticOut = (x: number) =>
  x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
const bounceOut = (x: number) => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};

// Damped spring from 0 to 1; `elapsed` in seconds so the motion is physical, not stretched.
export const spring = (elapsed: number, {stiffness = 170, damping = 18, mass = 1} = {}) => {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * elapsed) * (Math.cos(wd * elapsed) + ((zeta * w0) / wd) * Math.sin(wd * elapsed));
  }
  return 1 - Math.exp(-w0 * elapsed) * (1 + w0 * elapsed);
};

// Progress 0..1 (may overshoot) for a segment, given linear progress x and segment length in seconds.
export const applyEase = (ease: Ease | undefined, x: number, segSeconds = 1): number => {
  if (!ease || ease === 'linear') return x;
  if (ease === 'hold') return x >= 1 ? 1 : 0;
  if (ease === 'elasticOut') return elasticOut(x);
  if (ease === 'bounceOut') return bounceOut(x);
  if (typeof ease === 'object' && !Array.isArray(ease)) return x >= 1 ? 1 : spring(x * segSeconds, ease.spring);
  const pts = Array.isArray(ease) ? ease : CURVES[ease];
  if (!pts) return x;
  const key = pts.join(',');
  let fn = cache.get(key);
  if (!fn) cache.set(key, (fn = bezier(...pts)));
  return fn(x);
};

export const EASE_NAMES = ['linear', 'hold', ...Object.keys(CURVES), 'elasticOut', 'bounceOut'];
