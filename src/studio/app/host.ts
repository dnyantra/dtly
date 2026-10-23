// Browser host for the shared Renderer: <canvas> for drawing, <video>/<img> for media.
import {val} from '../../core/anim.js';
import type {AudioLayer, Composition, Project, VideoLayer} from '../../core/model.js';
import type {CanvasLike, Drawable, Host} from '../../render/renderer.js';
import {config} from './config.js';

export const mediaUrl = (src: string) => (src.startsWith('data:') ? src : `/api/media?src=${encodeURIComponent(src)}&token=${config.token}`);

const waitFor = (el: HTMLMediaElement, event: string, ms = 2000) =>
  new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); el.removeEventListener(event, done); resolve(); };
    const timer = setTimeout(done, ms);
    el.addEventListener(event, done, {once: true});
  });

interface VideoEntry { el: HTMLVideoElement; canvas: HTMLCanvasElement; used: number }

export class BrowserHost implements Host {
  defaultFont = 'Baloo 2';
  playing = false;
  private images = new Map<string, Promise<Drawable>>();
  private videos = new Map<string, VideoEntry>();
  private frameNo = 0;

  createCanvas(w: number, h: number): CanvasLike {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c as unknown as CanvasLike;
  }

  async data(src: string) {
    const r = await fetch(mediaUrl(src));
    if (!r.ok) throw new Error(`Could not load ${src}`);
    return r.text();
  }

  image(src: string) {
    if (!this.images.has(src)) {
      this.images.set(src, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${src}`));
        img.src = mediaUrl(src);
      }));
    }
    return this.images.get(src)!;
  }

  // Scrubbing seeks exactly; playback lets the element play and only corrects drift.
  async videoFrame(layer: VideoLayer, sourceTime: number, w: number, h: number, fps: number): Promise<Drawable> {
    const key = `${layer.id}|${layer.src}`;
    let v = this.videos.get(key);
    if (!v) {
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.src = mediaUrl(layer.src);
      v = {el, canvas: document.createElement('canvas'), used: 0};
      this.videos.set(key, v);
      await waitFor(el, 'loadeddata', 5000);
    }
    v.used = this.frameNo;
    const el = v.el;
    const t = Math.max(0, Math.min(sourceTime, (el.duration || Infinity) - 0.001));
    if (this.playing) {
      el.playbackRate = layer.speed ?? 1;
      if (Math.abs(el.currentTime - t) > 0.25) el.currentTime = t;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - t) > 0.5 / fps) {
        el.currentTime = t;
        await waitFor(el, 'seeked');
      }
    }
    // Fit into the layer box the same way the FFmpeg path does (cover/contain/fill).
    const c = v.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const vw = el.videoWidth || w, vh = el.videoHeight || h;
    const fit = layer.fit ?? 'cover';
    if (fit === 'fill') ctx.drawImage(el, 0, 0, w, h);
    else {
      const s = fit === 'cover' ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
      ctx.drawImage(el, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
    }
    return c;
  }

  // Call after each rendered frame: pauses videos whose layers are no longer on screen.
  endFrame() {
    for (const v of this.videos.values()) if (v.used !== this.frameNo && !v.el.paused) v.el.pause();
    this.frameNo++;
  }

  stopAll() { for (const v of this.videos.values()) v.el.pause(); }
}

// Preview audio for audio layers and un-muted video layers of the shown comp (not nested comps).
export class AudioPreview {
  private els = new Map<string, HTMLAudioElement>();

  sync(project: Project, comp: Composition, t: number, playing: boolean) {
    const live = new Set<string>();
    for (const l of comp.layers) {
      if (l.type !== 'audio' && !(l.type === 'video' && l.volume)) continue;
      const layer = l as AudioLayer | VideoLayer;
      const key = `${layer.id}|${layer.src}`;
      let el = this.els.get(key);
      if (!el) {
        el = new Audio(mediaUrl(layer.src));
        el.preload = 'auto';
        this.els.set(key, el);
      }
      live.add(key);
      const inP = layer.inPoint ?? 0, outP = layer.outPoint ?? comp.duration;
      const active = playing && t >= inP && t < outP;
      if (!active) { if (!el.paused) el.pause(); continue; }
      const speed = layer.type === 'video' ? layer.speed ?? 1 : 1;
      const src = (layer.trimIn ?? 0) + (t - inP) * speed;
      let vol = Math.max(0, Math.min(1, val(layer.volume, t, 1)));
      if (layer.type === 'audio') {
        if (layer.fadeIn && t - inP < layer.fadeIn) vol *= (t - inP) / layer.fadeIn;
        if (layer.fadeOut && outP - t < layer.fadeOut) vol *= (outP - t) / layer.fadeOut;
      }
      el.volume = vol;
      el.playbackRate = speed;
      if (Math.abs(el.currentTime - src) > 0.2) el.currentTime = src;
      if (el.paused) el.play().catch(() => {});
    }
    for (const [k, el] of this.els) if (!live.has(k) && !el.paused) el.pause();
    void project;
  }

  stop() { for (const el of this.els.values()) el.pause(); }
}

// Fonts: the bundled families plus any the project registers.
export const loadFonts = async (project: Project) => {
  const faces: FontFace[] = [
    new FontFace('Baloo 2', 'url(/fonts/Baloo2.ttf)', {weight: '400 800'}),
    new FontFace('Mukta', 'url(/fonts/Mukta-Bold.ttf)', {weight: '400 800'}),
  ];
  for (const [family, files] of Object.entries(project.fonts ?? {})) for (const f of files) faces.push(new FontFace(family, `url(${mediaUrl(f)})`));
  await Promise.all(faces.map(async (f) => { try { document.fonts.add(await f.load()); } catch { /* missing font: fall back */ } }));
};
