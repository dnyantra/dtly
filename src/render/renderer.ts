// Environment-agnostic compositor: draws a composition at time t onto any Canvas2D context.
// The same code runs in Node (skia-canvas) for export and in the browser for preview.
import {val} from '../core/anim.js';
import {parseColor, rgbaString} from '../core/color.js';
import type {Composition, Effect, Layer, Project, ShapeLayer, Vec2, VideoLayer} from '../core/model.js';
import {drawText} from '../core/text.js';

type Ctx = CanvasRenderingContext2D;
export interface CanvasLike { width: number; height: number; getContext(type: '2d'): Ctx }
export interface Drawable { width: number; height: number }

export interface Host {
  createCanvas(w: number, h: number): CanvasLike;
  image(src: string): Promise<Drawable>;
  videoFrame(layer: VideoLayer, sourceTime: number, w: number, h: number, fps: number): Promise<Drawable>;
  // Effects the host applies while decoding video (e.g. static blur in FFmpeg); the renderer skips them.
  bakedVideoEffects?(layer: VideoLayer): Set<Effect>;
  defaultFont: string;
}

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', add: 'lighter',
  darken: 'darken', lighten: 'lighten', softLight: 'soft-light', difference: 'difference',
};

export class Renderer {
  private pool = new Map<string, CanvasLike[]>();
  constructor(public project: Project, public host: Host) {}

  comp(id: string): Composition {
    const c = this.project.comps.find((c) => c.id === id);
    if (!c) throw new Error(`Unknown composition "${id}"`);
    return c;
  }

  private acquire(w: number, h: number): CanvasLike {
    const list = this.pool.get(`${w}x${h}`);
    const c = list?.pop() ?? this.host.createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return c;
  }
  private release(c: CanvasLike) {
    const k = `${c.width}x${c.height}`;
    if (!this.pool.has(k)) this.pool.set(k, []);
    this.pool.get(k)!.push(c);
  }

  // Natural size of a layer's content in layer space (used for default anchor points).
  layerSize(layer: Layer, comp: Composition, t: number): Vec2 {
    switch (layer.type) {
      case 'solid': return layer.size ?? [comp.width, comp.height];
      case 'image': case 'video': return layer.size ?? [comp.width, comp.height];
      case 'precomp': { const c = this.comp(layer.comp); return [c.width, c.height]; }
      default: return [0, 0];
    }
  }

  // Layer-space → comp-space matrix, including parents (AE parenting: transform only).
  matrix(layer: Layer, comp: Composition, t: number, depth = 0): M {
    const tr = layer.transform ?? {};
    const size = this.layerSize(layer, comp, t);
    const anchor = val(tr.anchor, t, [size[0] / 2, size[1] / 2] as Vec2);
    const pos = val(tr.position, t, [comp.width / 2, comp.height / 2] as Vec2);
    const [sx, sy] = val(tr.scale, t, [100, 100] as Vec2);
    const rot = (val(tr.rotation, t, 0) * Math.PI) / 180;
    const skew = Math.tan((val(tr.skew, t, 0) * Math.PI) / 180);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    let m: M = [1, 0, 0, 1, pos[0], pos[1]];
    m = mul(m, [cos, sin, -sin, cos, 0, 0]);
    m = mul(m, [1, 0, skew, 1, 0, 0]);
    m = mul(m, [sx / 100, 0, 0, sy / 100, 0, 0]);
    m = mul(m, [1, 0, 0, 1, -anchor[0], -anchor[1]]);
    if (layer.parent && depth < 20) {
      const p = comp.layers.find((l) => l.id === layer.parent);
      if (p) m = mul(this.matrix(p, comp, t, depth + 1), m);
    }
    return m;
  }

  async renderComp(ctx: Ctx, comp: Composition, t: number, withBackground = true) {
    if (withBackground && comp.background) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = comp.background;
      ctx.fillRect(0, 0, comp.width, comp.height);
      ctx.restore();
    }
    const matteSources = new Set(comp.layers.map((l) => l.matte?.layer).filter(Boolean));
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const layer = comp.layers[i];
      if (layer.hidden || layer.type === 'audio' || layer.type === 'null') continue;
      if (matteSources.has(layer.id)) continue; // mattes only show through the layer that uses them
      await this.renderLayer(ctx, layer, comp, t);
    }
  }

  isActive(layer: Layer, comp: Composition, t: number) {
    return t >= (layer.inPoint ?? 0) && t < (layer.outPoint ?? comp.duration);
  }

  async renderLayer(target: Ctx, layer: Layer, comp: Composition, t: number) {
    if (!this.isActive(layer, comp, t)) return;
    const tr = layer.transform ?? {};
    const opacity = val(tr.opacity, t, 100) / 100;
    if (opacity <= 0) return;
    const baked = layer.type === 'video' ? this.host.bakedVideoEffects?.(layer) : undefined;
    const effects = (layer.effects ?? []).filter((e) => !baked?.has(e));
    // Filters and drop shadows can be applied while drawing; only masks, mattes, motion blur,
    // glow and fill need the layer composited in a full-frame buffer first (much slower).
    const direct = !layer.masks?.length && !layer.matte && !layer.motionBlur && effects.every((e) => DIRECT_EFFECTS.has(e.type));

    if (direct) {
      target.save();
      target.globalAlpha *= opacity;
      target.globalCompositeOperation = BLEND[layer.blendMode ?? 'normal'];
      const filters = filterString(effects, t);
      if (filters) target.filter = filters;
      this.applyShadow(target, effects, t);
      target.setTransform(...this.matrix(layer, comp, t));
      await this.drawContent(target, layer, comp, t);
      target.restore();
      return;
    }

    const buf = this.acquire(comp.width, comp.height);
    const b = buf.getContext('2d');
    if (layer.motionBlur) {
      // Average sub-frame samples across the shutter (AE: 180° shutter, ~8-16 samples).
      const n = Math.max(2, layer.motionBlur.samples ?? 8);
      const span = ((layer.motionBlur.shutter ?? 180) / 360) / comp.fps;
      for (let k = 0; k < n; k++) {
        const st = t - span / 2 + (span * k) / (n - 1);
        b.save();
        b.globalAlpha = 1 / (k + 1);
        b.setTransform(...this.matrix(layer, comp, st));
        await this.drawContent(b, layer, comp, st);
        b.restore();
      }
    } else {
      b.save();
      b.setTransform(...this.matrix(layer, comp, t));
      await this.drawContent(b, layer, comp, t);
      b.restore();
    }

    if (layer.masks?.length) {
      const m = this.matrix(layer, comp, t);
      for (const mask of layer.masks) {
        b.save();
        b.setTransform(...m);
        b.globalCompositeOperation = mask.inverted ? 'destination-out' : 'destination-in';
        b.beginPath();
        if (mask.shape === 'path' && mask.points?.length) {
          mask.points.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
          b.closePath();
        } else {
          const [x, y, w, h] = val(mask.rect, t, [0, 0, 0, 0] as [number, number, number, number]);
          if (mask.shape === 'ellipse') b.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
          else b.roundRect(x, y, w, h, mask.radius ?? 0);
        }
        b.fillStyle = '#000';
        b.fill();
        b.restore();
      }
    }

    for (const e of effects) {
      if (e.type === 'fill') {
        b.save();
        b.globalCompositeOperation = 'source-in';
        b.globalAlpha = val(e.opacity, t, 100) / 100;
        b.fillStyle = e.color;
        b.fillRect(0, 0, comp.width, comp.height);
        b.restore();
      }
    }

    if (layer.matte) {
      const src = comp.layers.find((l) => l.id === layer.matte!.layer);
      if (src) {
        const mb = this.acquire(comp.width, comp.height);
        await this.renderLayer(mb.getContext('2d'), {...src, hidden: false, matte: undefined}, comp, t);
        b.save();
        b.globalCompositeOperation = layer.matte.mode === 'alphaInverted' ? 'destination-out' : 'destination-in';
        b.drawImage(mb as unknown as CanvasImageSource, 0, 0);
        b.restore();
        this.release(mb);
      }
    }

    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha *= opacity;
    target.globalCompositeOperation = BLEND[layer.blendMode ?? 'normal'];
    const filters = filterString(effects, t);
    if (filters) target.filter = filters;
    this.applyShadow(target, effects, t);
    const glow = effects.find((e) => e.type === 'glow') as Extract<Effect, {type: 'glow'}> | undefined;
    if (glow) {
      const strength = val(glow.strength, t, 100) / 100;
      target.save();
      target.shadowColor = 'transparent';
      target.filter = `blur(${val(glow.radius, t, 24)}px)`;
      target.globalCompositeOperation = 'lighter';
      target.globalAlpha *= strength;
      if (glow.color) {
        const g = this.acquire(comp.width, comp.height);
        const gc = g.getContext('2d');
        gc.drawImage(buf as unknown as CanvasImageSource, 0, 0);
        gc.globalCompositeOperation = 'source-in';
        gc.fillStyle = glow.color;
        gc.fillRect(0, 0, comp.width, comp.height);
        target.drawImage(g as unknown as CanvasImageSource, 0, 0);
        this.release(g);
      } else target.drawImage(buf as unknown as CanvasImageSource, 0, 0);
      target.restore();
    }
    target.drawImage(buf as unknown as CanvasImageSource, 0, 0);
    target.restore();
    this.release(buf);
  }

  private applyShadow(ctx: Ctx, effects: Effect[], t: number) {
    const shadow = effects.find((e) => e.type === 'dropShadow') as Extract<Effect, {type: 'dropShadow'}> | undefined;
    if (!shadow) return;
    const dist = val(shadow.distance, t, 8), ang = ((shadow.angle ?? 135) * Math.PI) / 180;
    const c = parseColor(shadow.color ?? '#000') ?? [0, 0, 0, 1];
    ctx.shadowColor = rgbaString([c[0], c[1], c[2], c[3] * (val(shadow.opacity, t, 60) / 100)]);
    ctx.shadowBlur = val(shadow.blur, t, 16);
    ctx.shadowOffsetX = Math.sin(ang) * dist;
    ctx.shadowOffsetY = -Math.cos(ang) * dist;
  }

  private async drawContent(ctx: Ctx, layer: Layer, comp: Composition, t: number) {
    const inP = layer.inPoint ?? 0;
    switch (layer.type) {
      case 'solid': {
        const [w, h] = layer.size ?? [comp.width, comp.height];
        ctx.fillStyle = val(layer.color, t, '#000');
        ctx.fillRect(0, 0, w, h);
        return;
      }
      case 'shape': return drawShape(ctx, layer, t);
      case 'text': return drawText(ctx, layer, t, inP, layer.outPoint ?? comp.duration, this.project.fonts ? Object.keys(this.project.fonts)[0] ?? this.host.defaultFont : this.host.defaultFont);
      case 'image': {
        const img = await this.host.image(layer.src);
        const [w, h] = layer.size ?? [comp.width, comp.height];
        drawFitted(ctx, img, w, h, layer.fit ?? 'cover');
        return;
      }
      case 'video': {
        const [w, h] = layer.size ?? [comp.width, comp.height];
        const srcTime = (layer.trimIn ?? 0) + (t - inP) * (layer.speed ?? 1);
        const frame = await this.host.videoFrame(layer, srcTime, w, h, comp.fps);
        ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
        return;
      }
      case 'precomp': {
        const child = this.comp(layer.comp);
        const ct = (t - inP) * (layer.speed ?? 1) + (layer.timeOffset ?? 0);
        const c = this.acquire(child.width, child.height);
        await this.renderComp(c.getContext('2d'), child, ct, true);
        ctx.drawImage(c as unknown as CanvasImageSource, 0, 0);
        this.release(c);
        return;
      }
    }
  }
}

const DIRECT_EFFECTS = new Set<Effect['type']>(['blur', 'brightness', 'saturate', 'contrast', 'dropShadow']);

const filterString = (effects: Effect[], t: number) =>
  effects
    .map((e) => {
      if (e.type === 'blur') { const r = val(e.radius, t, 0); return r > 0.05 ? `blur(${r}px)` : ''; }
      if (e.type === 'brightness') return `brightness(${val(e.amount, t, 100)}%)`;
      if (e.type === 'saturate') return `saturate(${val(e.amount, t, 100)}%)`;
      if (e.type === 'contrast') return `contrast(${val(e.amount, t, 100)}%)`;
      return '';
    })
    .filter(Boolean)
    .join(' ');

const drawFitted = (ctx: Ctx, img: Drawable, w: number, h: number, fit: 'cover' | 'contain' | 'fill') => {
  if (fit === 'fill') return ctx.drawImage(img as unknown as CanvasImageSource, 0, 0, w, h);
  const s = fit === 'cover' ? Math.max(w / img.width, h / img.height) : Math.min(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.drawImage(img as unknown as CanvasImageSource, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
};

// Shape outline as a polyline (layer space, centred on the origin), used for trim paths.
const outline = (s: ShapeLayer, t: number): {pts: Vec2[]; closed: boolean} => {
  const [w, h] = val(s.size, t, [200, 200] as Vec2);
  switch (s.shape) {
    case 'rect': return {pts: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], closed: true};
    case 'ellipse': return {pts: [...Array(96).keys()].map((i) => { const a = (i / 96) * Math.PI * 2 - Math.PI / 2; return [Math.cos(a) * w / 2, Math.sin(a) * h / 2] as Vec2; }), closed: true};
    case 'polygon': {
      const r = val(s.radius, t, 100), n = s.sides ?? 6;
      return {pts: [...Array(n).keys()].map((i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; return [Math.cos(a) * r, Math.sin(a) * r] as Vec2; }), closed: true};
    }
    default: return {pts: s.points ?? [], closed: s.closed ?? s.shape === 'path'};
  }
};

const drawShape = (ctx: Ctx, s: ShapeLayer, t: number) => {
  const start = val(s.trim?.start, t, 0) / 100, end = val(s.trim?.end, t, 100) / 100;
  ctx.beginPath();
  if (s.trim && (start > 0 || end < 1)) {
    const {pts, closed} = outline(s, t);
    const all = closed ? [...pts, pts[0]] : pts;
    const lens = all.slice(1).map((p, i) => Math.hypot(p[0] - all[i][0], p[1] - all[i][1]));
    const total = lens.reduce((a, b) => a + b, 0);
    const a = Math.min(start, end) * total, z = Math.max(start, end) * total;
    let acc = 0, started = false;
    for (let i = 0; i < lens.length; i++) {
      const s0 = acc, s1 = acc + lens[i];
      acc = s1;
      if (s1 < a || s0 > z) continue;
      const p = (d: number): Vec2 => { const k = lens[i] ? (d - s0) / lens[i] : 0; return [all[i][0] + (all[i + 1][0] - all[i][0]) * k, all[i][1] + (all[i + 1][1] - all[i][1]) * k]; };
      const from = p(Math.max(a, s0)), to = p(Math.min(z, s1));
      if (!started) { ctx.moveTo(...from); started = true; }
      ctx.lineTo(...to);
    }
  } else if (s.shape === 'rect') {
    const [w, h] = val(s.size, t, [200, 200] as Vec2);
    ctx.roundRect(-w / 2, -h / 2, w, h, val(s.radius, t, 0));
  } else if (s.shape === 'ellipse') {
    const [w, h] = val(s.size, t, [200, 200] as Vec2);
    ctx.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  } else {
    const {pts, closed} = outline(s, t);
    pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    if (closed) ctx.closePath();
  }
  const trimmed = !!s.trim && (start > 0 || end < 1);
  if (s.fill && !trimmed && s.shape !== 'line') {
    if (typeof s.fill === 'object' && 'linear' in s.fill) {
      const g = ctx.createLinearGradient(...s.fill.linear.from, ...s.fill.linear.to);
      for (const [o, c] of s.fill.linear.stops) g.addColorStop(o, c);
      ctx.fillStyle = g;
    } else ctx.fillStyle = val(s.fill as string, t, '#fff');
    ctx.fill();
  }
  if (s.stroke) {
    ctx.strokeStyle = val(s.stroke, t, '#fff');
    ctx.lineWidth = val(s.strokeWidth, t, 4);
    ctx.lineCap = s.lineCap ?? 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
};
