// Stylised compositing effects drawn from a layer's buffer: RGB split, glitch and wave.
// All are strip/offset based (no per-pixel loops), so they stay cheap at 1080p.
import {val} from '../core/anim.js';
import type {Effect} from '../core/model.js';

type Ctx = CanvasRenderingContext2D;
type Canvasish = {width: number; height: number; getContext(t: '2d'): Ctx};
type Acquire = (w: number, h: number) => Canvasish;

export const FX_TYPES = new Set<Effect['type']>(['rgbSplit', 'glitch', 'wave']);

// Deterministic noise so renders are repeatable.
const rand = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

const channel = (src: Canvasish, acquire: Acquire, color: string) => {
  const c = acquire(src.width, src.height), g = c.getContext('2d');
  g.drawImage(src as unknown as CanvasImageSource, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(src as unknown as CanvasImageSource, 0, 0);
  return c;
};

const rgbSplit = (target: Ctx, src: Canvasish, acquire: Acquire, release: (c: Canvasish) => void, dx: number, dy: number) => {
  if (Math.abs(dx) + Math.abs(dy) < 0.5) { target.drawImage(src as unknown as CanvasImageSource, 0, 0); return; }
  const r = channel(src, acquire, '#ff0000'), g = channel(src, acquire, '#00ff00'), b = channel(src, acquire, '#0000ff');
  target.save();
  target.globalCompositeOperation = 'lighter';
  target.drawImage(r as unknown as CanvasImageSource, dx, dy);
  target.drawImage(g as unknown as CanvasImageSource, 0, 0);
  target.drawImage(b as unknown as CanvasImageSource, -dx, -dy);
  target.restore();
  [r, g, b].forEach(release);
};

// Draws `src` onto `target` through any stylised effects; returns false if none apply.
export const drawWithFx = (target: Ctx, src: Canvasish, effects: Effect[], t: number, fps: number, acquire: Acquire, release: (c: Canvasish) => void): boolean => {
  const fx = effects.filter((e) => FX_TYPES.has(e.type));
  if (!fx.length) return false;
  let cur = src;
  const temps: Canvasish[] = [];
  const stage = () => { const c = acquire(src.width, src.height); temps.push(c); return c; };
  for (const e of fx) {
    const out = stage(), o = out.getContext('2d');
    const W = src.width, H = src.height;
    if (e.type === 'wave') {
      const amp = val(e.amplitude, t, 20), wl = e.wavelength ?? 240, ph = t * (e.speed ?? 1) * Math.PI * 2, strip = 4;
      if (Math.abs(amp) < 0.1) o.drawImage(cur as unknown as CanvasImageSource, 0, 0);
      else if ((e.direction ?? 'horizontal') === 'horizontal') for (let y = 0; y < H; y += strip) o.drawImage(cur as unknown as CanvasImageSource, 0, y, W, strip, Math.sin((y / wl) * Math.PI * 2 + ph) * amp, y, W, strip);
      else for (let x = 0; x < W; x += strip) o.drawImage(cur as unknown as CanvasImageSource, x, 0, strip, H, x, Math.sin((x / wl) * Math.PI * 2 + ph) * amp, strip, H);
    } else if (e.type === 'glitch') {
      const amount = val(e.amount, t, 50) / 100;
      const frame = Math.floor(t * fps / (e.hold ?? 2)), seed = (e.seed ?? 1) * 1000 + frame;
      if (amount <= 0.001) o.drawImage(cur as unknown as CanvasImageSource, 0, 0);
      else {
        // Horizontal slices pushed sideways by random amounts; some frames stay clean.
        let y = 0, k = 0;
        while (y < H) {
          const hgt = Math.max(4, Math.round((0.01 + rand(seed + k * 7.1) * 0.08) * H));
          const active = rand(seed + k * 3.3) < 0.35 + amount * 0.4;
          const dx = active ? (rand(seed + k * 5.7) - 0.5) * 2 * amount * W * 0.08 : 0;
          o.drawImage(cur as unknown as CanvasImageSource, 0, y, W, hgt, dx, y, W, hgt);
          y += hgt; k++;
        }
        if (e.rgb !== false) {
          const split = stage(), sg = split.getContext('2d');
          rgbSplit(sg, out, acquire, release, amount * 14 * (rand(seed) > 0.5 ? 1 : -1), 0);
          cur = split;
          continue;
        }
      }
    } else if (e.type === 'rgbSplit') {
      const amt = val(e.amount, t, 10), ang = ((e.angle ?? 0) * Math.PI) / 180;
      rgbSplit(o, cur, acquire, release, Math.cos(ang) * amt, Math.sin(ang) * amt);
    }
    cur = out;
  }
  target.drawImage(cur as unknown as CanvasImageSource, 0, 0);
  temps.forEach(release);
  return true;
};
