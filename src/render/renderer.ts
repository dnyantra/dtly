// Environment-agnostic compositor: draws a composition at time t onto any Canvas2D context.
// The same code runs in Node (skia-canvas) for export and in the browser for preview.
import {val} from '../core/anim.js';
import {parseColor, rgbaString} from '../core/color.js';
import type {Composition, Effect, Layer, Project, Vec2, VideoLayer} from '../core/model.js';
import {drawText} from '../core/text.js';
import {drawShape} from './shapes.js';
import {drawWithFx} from './fx.js';
import {applyGrade, drawVignette, GRADE_TYPES, preloadLuts} from './grade.js';
import {drawPerspective, tiltCorners} from './perspective.js';
import {parsePath, tracePath} from '../core/path.js';
import {LottiePlayer, type LottieHost} from './lottie.js';

type Ctx = CanvasRenderingContext2D;
export interface CanvasLike { width: number; height: number; getContext(type: '2d'): Ctx }
export interface Drawable { width: number; height: number }

export interface Host {
  createCanvas(w: number, h: number): CanvasLike;
  image(src: string): Promise<Drawable>;
  videoFrame(layer: VideoLayer, sourceTime: number, w: number, h: number, fps: number): Promise<Drawable>;
  // Effects the host applies while decoding video (e.g. static blur in FFmpeg); the renderer skips them.
  bakedVideoEffects?(layer: VideoLayer): Set<Effect>;
  // Text files referenced by layers (Lottie JSON, LUTs).
  data(src: string): Promise<string>;
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
    // Pooled canvases come back with whatever state their last user left: reset all of it.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.setLineDash([]);
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
      case 'lottie': { const p = this.lotties.get(layer.src); return layer.size ?? (p ? [p.w, p.h] : [comp.width, comp.width]); }
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

  // Lottie players, keyed by src; loaded before a frame draws so sizes are known synchronously.
  private lotties = new Map<string, LottiePlayer>();
  private async preload(comp: Composition) {
    for (const l of comp.layers) {
      if (l.type === 'lottie' && !this.lotties.has(l.src)) {
        const p = new LottiePlayer(JSON.parse(await this.host.data(l.src)), this.host as unknown as LottieHost);
        await p.preload();
        this.lotties.set(l.src, p);
      }
      if (l.type === 'precomp') await this.preload(this.comp(l.comp));
      if (l.effects?.some((e) => e.type === 'lut')) await preloadLuts(l.effects, {loadText: (src) => this.host.data(src)});
    }
  }

  async renderComp(ctx: Ctx, comp: Composition, t: number, withBackground = true) {
    await this.preload(comp);
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
      if (layer.type === 'adjustment') { this.renderAdjustment(ctx, layer, comp, t); continue; }
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
    } else if (effects.some((e) => e.type === 'cornerPin' || e.type === 'tilt')) {
      // Perspective: draw the content flat at its own size, then map it through the corner pin.
      const [w, h] = this.layerSize(layer, comp, t);
      if (w > 0 && h > 0) {
        const src = this.acquire(Math.ceil(w), Math.ceil(h));
        await this.drawContent(src.getContext('2d'), layer, comp, t);
        const pin = effects.find((e) => e.type === 'cornerPin') as Extract<Effect, {type: 'cornerPin'}> | undefined;
        const tilt = effects.find((e) => e.type === 'tilt') as Extract<Effect, {type: 'tilt'}> | undefined;
        const quad = pin
          ? val(pin.corners, t, [[0, 0], [w, 0], [w, h], [0, h]] as [Vec2, Vec2, Vec2, Vec2])
          : tiltCorners(w, h, val(tilt!.rotateX, t, 0), val(tilt!.rotateY, t, 0), val(tilt!.rotateZ, t, 0), tilt!.perspective ?? Math.max(w, h) * 2);
        b.save();
        b.setTransform(...this.matrix(layer, comp, t));
        drawPerspective(b, src as unknown as CanvasImageSource, w, h, quad);
        b.restore();
        this.release(src);
      }
    } else {
      b.save();
      b.setTransform(...this.matrix(layer, comp, t));
      await this.drawContent(b, layer, comp, t);
      b.restore();
    }

    if (layer.masks?.length) this.applyMasks(b, layer, comp, t);

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

    this.grade(b, effects, comp, t);

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
    if (!drawWithFx(target, buf, effects, t, comp.fps, (w, h) => this.acquire(w, h), (c) => this.release(c as CanvasLike))) target.drawImage(buf as unknown as CanvasImageSource, 0, 0);
    target.restore();
    this.release(buf);
  }

  // Masks are drawn into their own full-frame buffer, then applied with one composite:
  // this also hides everything when a mask has zero size (some backends skip empty paths).
  private applyMasks(b: Ctx, layer: Layer, comp: Composition, t: number) {
    const masks = layer.masks ?? [];
    const m = this.matrix(layer, comp, t);
    const mk = this.acquire(comp.width, comp.height);
    const mc = mk.getContext('2d');
    masks.forEach((mask, i) => {
      mc.save();
      if (i === 0 && mask.inverted) { mc.fillStyle = '#000'; mc.fillRect(0, 0, comp.width, comp.height); }
      mc.setTransform(...m);
      mc.globalCompositeOperation = mask.inverted ? 'destination-out' : 'source-over';
      mc.beginPath();
      if (mask.shape === 'path' && mask.points?.length) {
        mask.points.forEach(([x, y], k) => (k ? mc.lineTo(x, y) : mc.moveTo(x, y)));
        mc.closePath();
      } else if (mask.shape === 'path' && mask.path) tracePath(mc, parsePath(val(mask.path, t, '')));
      else {
        const [x, y, w, h] = val(mask.rect, t, [0, 0, 0, 0] as [number, number, number, number]);
        if (Math.abs(w) > 0.01 && Math.abs(h) > 0.01) {
          if (mask.shape === 'ellipse') mc.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
          else mc.roundRect(x, y, w, h, mask.radius ?? 0);
        }
      }
      mc.fillStyle = '#000';
      mc.fill();
      mc.restore();
    });
    b.save();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(mk as unknown as CanvasImageSource, 0, 0);
    b.restore();
    this.release(mk);
  }

  // Grade effects (curves, wheels, exposure, temperature, LUT) and vignette on a comp-size buffer.
  private grade(b: Ctx, effects: Effect[], comp: Composition, t: number) {
    const grades = effects.filter((e) => GRADE_TYPES.has(e.type)) as Parameters<typeof applyGrade>[3];
    if (grades.length) applyGrade(b, comp.width, comp.height, grades, t);
    for (const e of effects) if (e.type === 'vignette') drawVignette(b, comp.width, comp.height, val(e.amount, t, 50), e.softness, e.color);
  }

  // An adjustment layer re-renders everything already drawn below it through its effects.
  private renderAdjustment(target: Ctx, layer: Layer, comp: Composition, t: number) {
    if (!this.isActive(layer, comp, t)) return;
    const opacity = val(layer.transform?.opacity, t, 100) / 100;
    const effects = layer.effects ?? [];
    if (opacity <= 0 || !effects.length) return;
    const W = comp.width, H = comp.height;
    const buf = this.acquire(W, H), b = buf.getContext('2d');
    const filters = filterString(effects, t);
    if (filters) b.filter = filters;
    b.drawImage(target.canvas as unknown as CanvasImageSource, 0, 0);
    b.filter = 'none';
    this.grade(b, effects, comp, t);
    if (layer.masks?.length) this.applyMasks(b, layer, comp, t);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha *= opacity;
    if (!drawWithFx(target, buf, effects, t, comp.fps, (w, h) => this.acquire(w, h), (c) => this.release(c as CanvasLike))) target.drawImage(buf as unknown as CanvasImageSource, 0, 0);
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
      case 'lottie': {
        const p = this.lotties.get(layer.src);
        if (!p) return;
        const [w, h] = layer.size ?? [p.w, p.h];
        const s = Math.min(w / p.w, h / p.h);
        const [f0, f1] = layer.frames ?? [p.ip, p.op];
        const span = Math.max(1, f1 - f0);
        let f = ((t - inP) * (layer.speed ?? 1) + (layer.timeOffset ?? 0)) * p.fr;
        f = layer.loop === false ? Math.min(f, span - 0.001) : ((f % span) + span) % span;
        ctx.save();
        ctx.translate((w - p.w * s) / 2, (h - p.h * s) / 2);
        ctx.scale(s, s);
        p.draw(ctx, f0 + f);
        ctx.restore();
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
