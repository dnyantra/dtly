// Vector paths: SVG path data → cubic segments → polylines, lengths, trims, morphs.
// Shared by shape layers, SVG import, Lottie and map routes.
import type {Vec2} from './model.js';

export type Seg = {kind: 'M'; p: Vec2} | {kind: 'L'; p: Vec2} | {kind: 'C'; c1: Vec2; c2: Vec2; p: Vec2} | {kind: 'Z'};
export type Path = Seg[];

// Parses SVG path data into absolute M/L/C/Z segments (H, V, S, Q, T and A are converted).
export const parsePath = (d: string): Path => {
  const out: Path = [];
  const tokens = d.match(/[a-df-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0, cmd = '', cur: Vec2 = [0, 0], start: Vec2 = [0, 0], lastC: Vec2 | null = null, lastQ: Vec2 | null = null;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[a-z]$/i.test(tokens[i]);
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const R = (p: Vec2): Vec2 => (rel ? [cur[0] + p[0], cur[1] + p[1]] : p);
    const C = cmd.toUpperCase();
    if (C === 'Z') { out.push({kind: 'Z'}); cur = start; lastC = lastQ = null; if (!isNum()) continue; }
    do {
      if (C === 'M') { cur = R([num(), num()]); start = cur; out.push({kind: 'M', p: cur}); cmd = rel ? 'l' : 'L'; lastC = lastQ = null; break; }
      if (C === 'L') { cur = R([num(), num()]); out.push({kind: 'L', p: cur}); lastC = lastQ = null; }
      else if (C === 'H') { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; out.push({kind: 'L', p: cur}); lastC = lastQ = null; }
      else if (C === 'V') { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; out.push({kind: 'L', p: cur}); lastC = lastQ = null; }
      else if (C === 'C') { const c1 = R([num(), num()]), c2 = R([num(), num()]), p = R([num(), num()]); out.push({kind: 'C', c1, c2, p}); cur = p; lastC = c2; lastQ = null; }
      else if (C === 'S') { const c1: Vec2 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur; const c2 = R([num(), num()]), p = R([num(), num()]); out.push({kind: 'C', c1, c2, p}); cur = p; lastC = c2; lastQ = null; }
      else if (C === 'Q' || C === 'T') {
        const q: Vec2 = C === 'Q' ? R([num(), num()]) : lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = R([num(), num()]);
        out.push({kind: 'C', c1: [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], c2: [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p});
        cur = p; lastQ = q; lastC = null;
      } else if (C === 'A') {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), p = R([num(), num()]);
        for (const s of arcToCubics(cur, p, rx, ry, rot, !!large, !!sweep)) out.push(s);
        cur = p; lastC = lastQ = null;
      } else { i++; break; }
    } while (isNum());
  }
  return out;
};

// SVG elliptical arc → cubic beziers (SVG spec F.6).
const arcToCubics = (p0: Vec2, p1: Vec2, rx: number, ry: number, deg: number, large: boolean, sweep: boolean): Seg[] => {
  if (!rx || !ry) return [{kind: 'L', p: p1}];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (deg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  let t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  if (sweep && dt < 0) dt += Math.PI * 2;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const segs: Seg[] = [];
  const step = dt / n, k = (4 / 3) * Math.tan(step / 4);
  const pt = (a: number): Vec2 => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const der = (a: number): Vec2 => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  for (let j = 0; j < n; j++) {
    const a0 = t1, a1 = t1 + step;
    const s = pt(a0), e = pt(a1), d0 = der(a0), d1 = der(a1);
    segs.push({kind: 'C', c1: [s[0] + k * d0[0], s[1] + k * d0[1]], c2: [e[0] - k * d1[0], e[1] - k * d1[1]], p: j === n - 1 ? p1 : e});
    t1 = a1;
  }
  return segs;
};

export const pathToString = (path: Path) =>
  path.map((s) => {
    const f = (v: Vec2) => `${+v[0].toFixed(2)} ${+v[1].toFixed(2)}`;
    if (s.kind === 'Z') return 'Z';
    if (s.kind === 'C') return `C${f(s.c1)} ${f(s.c2)} ${f(s.p)}`;
    return `${s.kind}${f(s.p)}`;
  }).join(' ');

export const transformPath = (path: Path, m: [number, number, number, number, number, number]): Path => {
  const T = ([x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return path.map((s) => (s.kind === 'Z' ? s : s.kind === 'C' ? {kind: 'C', c1: T(s.c1), c2: T(s.c2), p: T(s.p)} : {kind: s.kind, p: T(s.p)}));
};

export const tracePath = (ctx: CanvasRenderingContext2D, path: Path) => {
  for (const s of path) {
    if (s.kind === 'M') ctx.moveTo(...s.p);
    else if (s.kind === 'L') ctx.lineTo(...s.p);
    else if (s.kind === 'C') ctx.bezierCurveTo(...s.c1, ...s.c2, ...s.p);
    else ctx.closePath();
  }
};

const bez = (a: Vec2, b: Vec2, c: Vec2, d: Vec2, t: number): Vec2 => {
  const u = 1 - t;
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]];
};

// Subpaths flattened into polylines (curves sampled finely enough for trims and morphs).
export const flatten = (path: Path, tolerance = 0.75): {pts: Vec2[]; closed: boolean}[] => {
  const subs: {pts: Vec2[]; closed: boolean}[] = [];
  let cur: {pts: Vec2[]; closed: boolean} | null = null;
  let last: Vec2 = [0, 0], start: Vec2 = [0, 0];
  for (const s of path) {
    if (s.kind === 'M') { cur = {pts: [s.p], closed: false}; subs.push(cur); last = start = s.p; continue; }
    if (!cur) { cur = {pts: [last], closed: false}; subs.push(cur); }
    if (s.kind === 'L') { cur.pts.push(s.p); last = s.p; }
    else if (s.kind === 'C') {
      const len = Math.hypot(s.c1[0] - last[0], s.c1[1] - last[1]) + Math.hypot(s.c2[0] - s.c1[0], s.c2[1] - s.c1[1]) + Math.hypot(s.p[0] - s.c2[0], s.p[1] - s.c2[1]);
      const n = Math.max(4, Math.min(200, Math.ceil(Math.sqrt(len / tolerance) * 2)));
      for (let k = 1; k <= n; k++) cur.pts.push(bez(last, s.c1, s.c2, s.p, k / n));
      last = s.p;
    } else { cur.closed = true; last = start; cur = null; }
  }
  return subs.filter((s) => s.pts.length > 1);
};

const polyLen = (pts: Vec2[], closed: boolean) => {
  let l = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; l += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return l;
};

// Evenly spaced points along a polyline (used for morphing paths with different structures).
export const resample = (pts: Vec2[], closed: boolean, n: number): Vec2[] => {
  const all = closed ? [...pts, pts[0]] : pts;
  const lens = all.slice(1).map((p, i) => Math.hypot(p[0] - all[i][0], p[1] - all[i][1]));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const out: Vec2[] = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const d = (closed ? k / n : k / (n - 1)) * total;
    while (seg < lens.length - 1 && acc + lens[seg] < d) { acc += lens[seg]; seg++; }
    const f = lens[seg] ? (d - acc) / lens[seg] : 0;
    out.push([all[seg][0] + (all[seg + 1][0] - all[seg][0]) * f, all[seg][1] + (all[seg + 1][1] - all[seg][1]) * f]);
  }
  return out;
};

// Trim paths (AE "Trim Paths"): the part of the outline between start% and end%, across subpaths.
export const trimPolylines = (subs: {pts: Vec2[]; closed: boolean}[], start: number, end: number, offset = 0): Vec2[][] => {
  const total = subs.reduce((a, s) => a + polyLen(s.pts, s.closed), 0);
  if (!total) return [];
  let a = Math.min(start, end) + offset, b = Math.max(start, end) + offset;
  const ranges: [number, number][] = [];
  const shift = Math.floor(a);
  a -= shift; b -= shift;
  if (b <= 1) ranges.push([a, b]); else { ranges.push([a, 1]); ranges.push([0, Math.min(1, b - 1)]); }
  const out: Vec2[][] = [];
  for (const [ra, rb] of ranges) {
    const from = ra * total, to = rb * total;
    let acc = 0;
    for (const s of subs) {
      const all = s.closed ? [...s.pts, s.pts[0]] : s.pts;
      let line: Vec2[] | null = null;
      for (let i = 0; i < all.length - 1; i++) {
        const p = all[i], q = all[i + 1];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const s0 = acc, s1 = acc + l;
        acc = s1;
        if (s1 < from || s0 > to || !l) { if (line && s0 > to) break; continue; }
        const at = (d: number): Vec2 => { const f = (d - s0) / l; return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]; };
        if (!line) { line = [at(Math.max(from, s0))]; out.push(line); }
        line.push(at(Math.min(to, s1)));
      }
    }
  }
  return out;
};

const area = (pts: Vec2[]) => pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// Shape morphing: both paths resampled to the same point count, rotated to the best start point, blended.
const MORPH_POINTS = 160;
export const morph = (a: Path, b: Path, p: number): Path => {
  const sa = flatten(a), sb = flatten(b);
  const n = Math.max(sa.length, sb.length);
  const out: Path = [];
  for (let k = 0; k < n; k++) {
    const A = sa[k] ?? sa[sa.length - 1], B = sb[k] ?? sb[sb.length - 1];
    if (!A || !B) continue;
    const closed = A.closed || B.closed;
    const pa = resample(A.pts, closed, MORPH_POINTS);
    let pb = resample(B.pts, closed, MORPH_POINTS);
    if (closed) {
      // Same winding direction, then the rotation that pairs points with the least travel.
      if (Math.sign(area(pa)) !== Math.sign(area(pb))) pb = pb.reverse();
      let best = 0, bestD = Infinity;
      for (let r = 0; r < MORPH_POINTS; r++) {
        let d = 0;
        for (let i = 0; i < MORPH_POINTS; i += 4) { const q = pb[(i + r) % MORPH_POINTS]; d += (pa[i][0] - q[0]) ** 2 + (pa[i][1] - q[1]) ** 2; }
        if (d < bestD) { bestD = d; best = r; }
      }
      const rotated = pb;
      pb = rotated.map((_, i) => rotated[(i + best) % MORPH_POINTS]);
    }
    pa.forEach((q, i) => out.push({kind: i ? 'L' : 'M', p: [q[0] + (pb[i][0] - q[0]) * p, q[1] + (pb[i][1] - q[1]) * p]}));
    if (closed) out.push({kind: 'Z'});
  }
  return out;
};

export const pathBounds = (path: Path): [number, number, number, number] | null => {
  const pts = flatten(path).flatMap((s) => s.pts);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
};

// Point and direction at a fraction of the path's length (motion along a path, map markers).
export const pointAt = (path: Path, f: number): {p: Vec2; angle: number} => {
  const pts = flatten(path).flatMap((s) => s.pts);
  if (pts.length < 2) return {p: pts[0] ?? [0, 0], angle: 0};
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let d = Math.max(0, Math.min(1, f)) * total, i = 0;
  while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
  const a = pts[i], b = pts[i + 1], k = lens[i] ? d / lens[i] : 0;
  return {p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI};
};

