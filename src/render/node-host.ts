// Node host: skia-canvas for drawing, FFmpeg for decoding video frames.
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Canvas, FontLibrary, ImageData, loadImage} from 'skia-canvas';
import {isAnimated, type Effect, type Project, type VideoLayer} from '../core/model.js';
import {GRADE_TYPES} from './grade.js';
import type {CanvasLike, Drawable, Host} from './renderer.js';

// CPU rendering by default: deterministic, and the GPU backend can drop draws when a shader
// compile times out (seen with JPEG/YUV images on Metal). DTLY_GPU=1 opts back in.
export const newCanvas = (w: number, h: number) => {
  const c = new Canvas(w, h);
  c.gpu = process.env.DTLY_GPU === '1';
  return c;
};

const BUNDLED_FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fonts');
let bundledLoaded = false;

export const registerFonts = (project: Project, baseDir: string) => {
  if (!bundledLoaded) {
    FontLibrary.use('Baloo 2', [path.join(BUNDLED_FONTS, 'Baloo2.ttf')]);
    FontLibrary.use('Mukta', [path.join(BUNDLED_FONTS, 'Mukta-Bold.ttf')]);
    bundledLoaded = true;
  }
  for (const [family, files] of Object.entries(project.fonts ?? {})) {
    FontLibrary.use(family, files.map((f) => path.resolve(baseDir, f)));
  }
};

// Streams frames sequentially from one FFmpeg process; seeks by restarting when needed.
class VideoReader {
  private proc?: ChildProcessWithoutNullStreams;
  private chunks: Buffer[] = [];
  private pending = 0; // bytes held in `chunks`
  private frames: Buffer[] = [];
  private nextIndex = 0; // index (relative to start) of frames[0]
  private start = 0;
  private ended = false;
  private waiters: (() => void)[] = [];
  private canvas: Canvas;
  private lastIndex = -1;
  private readonly frameBytes: number;

  constructor(private file: string, private w: number, private h: number, private fit: string, private rate: number, private extraFilters: string[] = []) {
    this.frameBytes = w * h * 4;
    this.canvas = newCanvas(w, h);
  }

  private open(startSeconds: number) {
    this.proc?.kill('SIGKILL');
    this.chunks = [];
    this.pending = 0;
    this.frames = [];
    this.nextIndex = 0;
    this.ended = false;
    this.start = startSeconds;
    const {w, h, fit} = this;
    const scale =
      fit === 'fill' ? `scale=${w}:${h}`
      : fit === 'contain' ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    this.proc = spawn('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, startSeconds)), '-i', this.file, '-vf', [`fps=${this.rate}`, scale, ...this.extraFilters, 'format=rgba'].join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const proc = this.proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (proc !== this.proc) return;
      // Gather chunks and copy once per frame (concatenating per chunk is quadratic at 8 MB/frame).
      this.chunks.push(chunk);
      this.pending += chunk.length;
      while (this.pending >= this.frameBytes) {
        const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.pending);
        this.frames.push(all.subarray(0, this.frameBytes));
        const rest = all.subarray(this.frameBytes);
        this.chunks = rest.length ? [rest] : [];
        this.pending = rest.length;
      }
      if (this.frames.length > 8) proc.stdout.pause();
      this.wake();
    });
    proc.stdout.on('end', () => { if (proc === this.proc) { this.ended = true; this.wake(); } });
    proc.on('error', () => { this.ended = true; this.wake(); });
  }
  private wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  async frame(sourceTime: number): Promise<Drawable> {
    const want = Math.max(0, Math.round(sourceTime * this.rate));
    if (want === this.lastIndex) return this.canvas;
    const rel = want - Math.round(this.start * this.rate);
    if (!this.proc || rel < this.nextIndex || rel - this.nextIndex > this.rate * 3) this.open(want / this.rate);
    const target = want - Math.round(this.start * this.rate);
    while (true) {
      while (this.frames.length && this.nextIndex < target) { this.frames.shift(); this.nextIndex++; }
      if (this.frames.length && this.nextIndex === target) break;
      if (this.ended) break; // past the end of the source: hold the last frame
      this.proc!.stdout.resume();
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const data = this.frames[0];
    if (data) {
      const ctx = this.canvas.getContext('2d');
      // skia-canvas records draw commands; clearing first stops full-frame puts piling up each frame.
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), this.w, this.h), 0, 0);
      this.lastIndex = want;
    }
    return this.canvas;
  }
  close() { this.proc?.kill('SIGKILL'); }
}

export class NodeHost implements Host {
  defaultFont = 'Baloo 2';
  private images = new Map<string, Promise<Drawable>>();
  private readers = new Map<string, VideoReader>();
  constructor(private baseDir: string) {}

  resolve(src: string) { return src.startsWith('data:') ? src : path.resolve(this.baseDir, src); }
  data(src: string) { return fs.promises.readFile(this.resolve(src), 'utf8'); }
  createCanvas(w: number, h: number): CanvasLike { return newCanvas(w, h) as unknown as CanvasLike; }
  image(src: string) {
    if (!this.images.has(src)) this.images.set(src, loadImage(this.resolve(src)) as unknown as Promise<Drawable>);
    return this.images.get(src)!;
  }
  videoFrame(layer: VideoLayer, sourceTime: number, w: number, h: number, fps: number) {
    const rate = fps / (layer.speed ?? 1);
    const key = [layer.id, layer.src, w, h, layer.fit, rate].join('|');
    let r = this.readers.get(key);
    if (!r) this.readers.set(key, (r = new VideoReader(this.resolve(layer.src), w, h, layer.fit ?? 'cover', rate, [...this.bakedVideoEffects(layer)].map((e) => ffmpegFilter(e, (src) => this.resolve(src))))));
    return r.frame(sourceTime);
  }
  // Static colour/blur effects on video run inside FFmpeg, in parallel with drawing.
  bakedVideoEffects(layer: VideoLayer) {
    const effects = layer.effects ?? [];
    const baked = effects.filter((e) => BAKEABLE.has(e.type) && !isAnimated((e as {radius?: unknown; amount?: unknown}).radius ?? (e as {amount?: unknown}).amount));
    // A full-strength LUT that is the only grade on the clip runs inside FFmpeg (lut3d), at no extra cost.
    const grades = effects.filter((e) => GRADE_TYPES.has(e.type));
    if (grades.length === 1 && grades[0].type === 'lut' && (grades[0].intensity === undefined || grades[0].intensity === 100)) baked.push(grades[0]);
    return new Set(baked);
  }
  close() { this.readers.forEach((r) => r.close()); this.readers.clear(); }
}

const BAKEABLE = new Set<Effect['type']>(['blur', 'brightness', 'saturate', 'contrast']);
// FFmpeg equivalents of the CSS filters the renderer would otherwise apply.
const escapeFilterPath = (p: string) => p.replace(/\\/g, '/').replace(/([:'\\,\[\];])/g, '\\$1');
const ffmpegFilter = (e: Effect, resolve: (src: string) => string) => {
  switch (e.type) {
    case 'lut': return `lut3d=file=${escapeFilterPath(resolve(e.src))}:interp=trilinear`;
    case 'blur': return `gblur=sigma=${Number(e.radius)}`;
    case 'brightness': { const k = Number(e.amount) / 100; return `colorchannelmixer=rr=${k}:gg=${k}:bb=${k}`; }
    case 'saturate': return `eq=saturation=${Number(e.amount) / 100}`;
    case 'contrast': return `eq=contrast=${Number(e.amount) / 100}`;
    default: return 'null';
  }
};
