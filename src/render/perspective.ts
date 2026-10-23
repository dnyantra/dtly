// True perspective (corner pin) on Canvas2D: a homography sampled on a triangle mesh.
import type {Vec2} from '../core/model.js';

type Ctx = CanvasRenderingContext2D;

// Homography mapping the unit square (0,0)-(1,1) to the quad tl, tr, br, bl.
const squareToQuad = ([x0, y0]: Vec2, [x1, y1]: Vec2, [x2, y2]: Vec2, [x3, y3]: Vec2) => {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a13 = 0, a23 = 0;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) > 1e-12) {
    a13 = (dx3 * dy2 - dx2 * dy3) / den;
    a23 = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a11 = x1 - x0 + a13 * x1, a21 = x3 - x0 + a23 * x3, a31 = x0;
  const a12 = y1 - y0 + a13 * y1, a22 = y3 - y0 + a23 * y3, a32 = y0;
  return (u: number, v: number): Vec2 => {
    const w = a13 * u + a23 * v + 1;
    return [(a11 * u + a21 * v + a31) / w, (a12 * u + a22 * v + a32) / w];
  };
};

// Draws `src` (w×h) so its corners land on the quad. `n` subdivisions per side (16 is seamless at 1080p).
export const drawPerspective = (ctx: Ctx, src: CanvasImageSource, w: number, h: number, quad: [Vec2, Vec2, Vec2, Vec2], n = 16) => {
  const map = squareToQuad(...quad);
  const tri = (s0: Vec2, s1: Vec2, s2: Vec2) => {
    const d0 = map(s0[0] / w, s0[1] / h), d1 = map(s1[0] / w, s1[1] / h), d2 = map(s2[0] / w, s2[1] / h);
    // Affine map taking the source triangle onto the destination triangle.
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
    const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
    const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const e = d0[0] - a * s0[0] - c * s0[1], f = d0[1] - b * s0[0] - d * s0[1];
    // Grow the clip triangle slightly so neighbouring triangles overlap and leave no hairline seams.
    const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p: Vec2): Vec2 => { const vx = p[0] - cx, vy = p[1] - cy, l = Math.hypot(vx, vy) || 1; return [p[0] + (vx / l) * 0.6, p[1] + (vy / l) * 0.6]; };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(...grow(d0)); ctx.lineTo(...grow(d1)); ctx.lineTo(...grow(d2));
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = (w * i) / n, x1 = (w * (i + 1)) / n, y0 = (h * j) / n, y1 = (h * (j + 1)) / n;
      tri([x0, y0], [x1, y0], [x0, y1]);
      tri([x1, y0], [x1, y1], [x0, y1]);
    }
  }
};

// Corners of a w×h rectangle rotated in 3D about its centre and projected (for device tilts).
export const tiltCorners = (w: number, h: number, rotX: number, rotY: number, rotZ = 0, perspective = 2000): [Vec2, Vec2, Vec2, Vec2] => {
  const rx = (rotX * Math.PI) / 180, ry = (rotY * Math.PI) / 180, rz = (rotZ * Math.PI) / 180;
  const pts: [number, number][] = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return pts.map(([x, y]) => {
    // rotate Z, then X, then Y
    let X = x * Math.cos(rz) - y * Math.sin(rz), Y = x * Math.sin(rz) + y * Math.cos(rz), Z = 0;
    const y1 = Y * Math.cos(rx) - Z * Math.sin(rx), z1 = Y * Math.sin(rx) + Z * Math.cos(rx);
    Y = y1; Z = z1;
    const x2 = X * Math.cos(ry) + Z * Math.sin(ry), z2 = -X * Math.sin(ry) + Z * Math.cos(ry);
    X = x2; Z = z2;
    const k = perspective / (perspective + Z);
    return [X * k + w / 2, Y * k + h / 2] as Vec2;
  }) as [Vec2, Vec2, Vec2, Vec2];
};
