import {fork, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isAnimated, type Composition, type Project} from '../core/model.js';
import {checkFfmpeg} from './ffmpeg.js';
import {newCanvas, NodeHost, registerFonts} from './node-host.js';
import {Renderer} from './renderer.js';

export const loadProject = (file: string): Project => JSON.parse(fs.readFileSync(file, 'utf8'));

const setup = (projectFile: string, project?: Project) => {
  const p = project ?? loadProject(projectFile);
  if (p.comps.some((c) => c.layers.some((l) => l.type === 'video' || l.type === 'audio'))) checkFfmpeg();
  const baseDir = path.dirname(path.resolve(projectFile));
  registerFonts(p, baseDir);
  const host = new NodeHost(baseDir);
  return {project: p, baseDir, host, renderer: new Renderer(p, host)};
};

// Renders one frame (or a scaled-down still) to PNG/JPG.
export const renderStill = async (projectFile: string, time: number, out: string, opts: {comp?: string; scale?: number} = {}) => {
  const {project, host, renderer} = setup(projectFile);
  const comp = renderer.comp(opts.comp ?? project.root);
  const scale = opts.scale ?? 1;
  const canvas = newCanvas(Math.round(comp.width * scale), Math.round(comp.height * scale));
  const full = newCanvas(comp.width, comp.height);
  await renderer.renderComp(full.getContext('2d') as unknown as CanvasRenderingContext2D, comp, time);
  canvas.getContext('2d').drawImage(full, 0, 0, canvas.width, canvas.height);
  await canvas.toFile(out);
  host.close();
  return out;
};

// A grid of frames for quick review (what an agent "looks at" instead of scrubbing).
export const renderContactSheet = async (projectFile: string, times: number[], out: string, opts: {comp?: string; columns?: number; thumbWidth?: number} = {}) => {
  const {project, host, renderer} = setup(projectFile);
  const comp = renderer.comp(opts.comp ?? project.root);
  const cols = opts.columns ?? Math.min(times.length, 6);
  const tw = opts.thumbWidth ?? 240, th = Math.round((tw * comp.height) / comp.width);
  const rows = Math.ceil(times.length / cols);
  const sheet = newCanvas(cols * tw, rows * (th + 28));
  const sc = sheet.getContext('2d');
  sc.fillStyle = '#111';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  const full = newCanvas(comp.width, comp.height);
  for (const [i, t] of times.entries()) {
    const fc = full.getContext('2d');
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.clearRect(0, 0, comp.width, comp.height);
    await renderer.renderComp(fc as unknown as CanvasRenderingContext2D, comp, t);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + 28);
    sc.drawImage(full, x, y, tw, th);
    sc.fillStyle = '#ddd';
    sc.font = '16px sans-serif';
    sc.fillText(`${t.toFixed(2)}s`, x + 8, y + th + 20);
  }
  await sheet.toFile(out);
  host.close();
  return out;
};

interface AudioClip { file: string; start: number; trimIn: number; duration: number; speed: number; volume: unknown; fadeIn?: number; fadeOut?: number }

// Collects audio from audio layers and un-muted video layers, through nested comps.
const collectAudio = (project: Project, comp: Composition, offset: number, srcShift: number, windowEnd: number, baseDir: string, out: AudioClip[]) => {
  for (const l of comp.layers) {
    const inP = l.inPoint ?? 0, outP = Math.min(l.outPoint ?? comp.duration, comp.duration);
    if (l.type === 'audio' || (l.type === 'video' && l.volume !== undefined && l.volume !== 0)) {
      const speed = l.type === 'video' ? l.speed ?? 1 : 1;
      const start = offset + inP - srcShift;
      const visibleFrom = Math.max(start, offset);
      const end = Math.min(offset + outP - srcShift, windowEnd);
      if (end <= visibleFrom) continue;
      out.push({
        file: path.resolve(baseDir, l.src),
        start: visibleFrom,
        trimIn: (l.trimIn ?? 0) + (visibleFrom - start) * speed,
        duration: end - visibleFrom,
        speed,
        volume: l.volume ?? 1,
        fadeIn: l.type === 'audio' ? l.fadeIn : undefined,
        fadeOut: l.type === 'audio' ? l.fadeOut : undefined,
      });
    }
    if (l.type === 'precomp') {
      const child = project.comps.find((c) => c.id === l.comp);
      if (child) collectAudio(project, child, offset + inP, l.timeOffset ?? 0, Math.min(windowEnd, offset + outP), baseDir, out);
    }
  }
};

// Piecewise-linear FFmpeg volume expression from keyframes (local time t from 0).
const volumeExpr = (v: unknown, layerStart: number): string => {
  if (typeof v === 'number') return String(v);
  if (!isAnimated<number>(v as never)) return '1';
  const kfs = [...(v as {keyframes: {t: number; v: number}[]}).keyframes].sort((a, b) => a.t - b.t).map((k) => ({t: k.t - layerStart, v: k.v}));
  let expr = String(kfs[kfs.length - 1].v);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    const seg = `${a.v}+(${b.v - a.v})*(t-${a.t})/${Math.max(1e-6, b.t - a.t)}`;
    expr = `if(lt(t,${b.t}),${seg},${expr})`;
  }
  return `if(lt(t,${kfs[0].t}),${kfs[0].v},${expr})`;
};

// Audio inputs + filter graph for the window [from, to), with FFmpeg input indices starting at `firstInput`.
const audioGraph = (project: Project, comp: Composition, baseDir: string, from: number, to: number, firstInput: number) => {
  const clips: AudioClip[] = [];
  collectAudio(project, comp, 0, 0, comp.duration, baseDir, clips);
  const audible = clips
    .map((c) => ({...c, start: c.start - from}))
    .filter((c) => c.start + c.duration > 0 && c.start < to - from)
    .map((c) => (c.start < 0 ? {...c, trimIn: c.trimIn - c.start * c.speed, duration: c.duration + c.start, start: 0} : c));
  if (!audible.length) return {inputs: [] as string[], filter: null, count: 0};
  const chains = audible.map((c, i) => {
    const f = [`atrim=start=${c.trimIn.toFixed(4)}:duration=${(c.duration * c.speed).toFixed(4)}`, 'asetpts=PTS-STARTPTS'];
    if (c.speed !== 1) f.push(`atempo=${Math.min(2, Math.max(0.5, c.speed))}`);
    f.push(`volume='${volumeExpr(c.volume, c.start + from)}':eval=frame`);
    if (c.fadeIn) f.push(`afade=t=in:st=0:d=${c.fadeIn}`);
    if (c.fadeOut) f.push(`afade=t=out:st=${Math.max(0, c.duration - c.fadeOut)}:d=${c.fadeOut}`);
    const ms = Math.round(c.start * 1000);
    f.push(`adelay=${ms}|${ms}`, 'aformat=sample_rates=48000:channel_layouts=stereo');
    return `[${firstInput + i}:a]${f.join(',')}[a${i}]`;
  });
  const mix = `${audible.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audible.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95,apad,atrim=duration=${(to - from).toFixed(3)}[aout]`;
  return {inputs: audible.flatMap((c) => ['-i', c.file]), filter: [...chains, mix].join(';'), count: audible.length};
};

const runFfmpeg = (args: string[], stdin = false) => {
  const ff = spawn('ffmpeg', args, {stdio: [stdin ? 'pipe' : 'ignore', 'inherit', 'pipe']});
  let err = '';
  ff.stderr!.on('data', (d: Buffer) => (err += d));
  const done = new Promise<void>((res, rej) => ff.on('close', (code: number) => (code === 0 ? res() : rej(new Error(`ffmpeg failed (${code}): ${err.slice(-2000)}`)))));
  return {ff, done};
};

const X264 = (crf = 18) => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', 'medium'];

export const renderVideo = async (projectFile: string, out: string, opts: {comp?: string; from?: number; to?: number; crf?: number; audio?: boolean; onProgress?: (done: number, total: number) => void} = {}) => {
  checkFfmpeg();
  const {project, baseDir, host, renderer} = setup(projectFile);
  const comp = renderer.comp(opts.comp ?? project.root);
  const from = opts.from ?? 0, to = Math.min(opts.to ?? comp.duration, comp.duration);
  const total = Math.round((to - from) * comp.fps);

  const audio = opts.audio === false ? {inputs: [], filter: null, count: 0} : audioGraph(project, comp, baseDir, from, to, 1);
  const args = ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${comp.width}x${comp.height}`, '-r', String(comp.fps), '-i', '-', ...audio.inputs];
  if (audio.filter) args.push('-filter_complex', audio.filter, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  args.push(...X264(opts.crf), '-movflags', '+faststart', '-frames:v', String(total), out);
  const {ff, done} = runFfmpeg(args, true);

  const canvas = newCanvas(comp.width, comp.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  for (let f = 0; f < total; f++) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, comp.width, comp.height);
    if (!comp.background) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, comp.width, comp.height); }
    await renderer.renderComp(ctx, comp, from + f / comp.fps);
    const raw = canvas.toBufferSync('raw');
    if (!ff.stdin!.write(raw)) await new Promise((r) => ff.stdin!.once('drain', r));
    opts.onProgress?.(f + 1, total);
  }
  ff.stdin!.end();
  await done;
  host.close();
  return {out, frames: total, seconds: to - from, audioTracks: audio.count};
};

// Splits the timeline across worker processes (one per core), then joins the chunks
// losslessly and mixes the audio once over the whole range.
export const renderVideoParallel = async (projectFile: string, out: string, opts: {comp?: string; from?: number; to?: number; crf?: number; workers?: number; onProgress?: (done: number, total: number) => void} = {}) => {
  checkFfmpeg();
  const project = loadProject(projectFile);
  const comp = project.comps.find((c) => c.id === (opts.comp ?? project.root));
  if (!comp) throw new Error(`Unknown comp ${opts.comp}`);
  const from = opts.from ?? 0, to = Math.min(opts.to ?? comp.duration, comp.duration);
  const f0 = Math.round(from * comp.fps), total = Math.round((to - from) * comp.fps);
  // One process is fastest for short videos (worker start-up dominates); opt in for long renders.
  const workers = Math.max(1, Math.min(opts.workers ?? 1, os.cpus().length, Math.ceil(total / 15)));
  if (workers === 1) return renderVideo(projectFile, out, opts);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-'));
  const here = fileURLToPath(import.meta.url);
  const cli = path.resolve(path.dirname(here), here.endsWith('.ts') ? '../cli.ts' : '../cli.js');
  const progress = new Array(workers).fill(0);
  const chunks = [...Array(workers).keys()].map((i) => {
    const a = f0 + Math.floor((total * i) / workers), b = f0 + Math.floor((total * (i + 1)) / workers);
    return {file: path.join(tmp, `chunk-${i}.mp4`), from: a / comp.fps, to: b / comp.fps, frames: b - a};
  });
  await Promise.all(chunks.map((c, i) => new Promise<void>((res, rej) => {
    const child = fork(cli, ['chunk', projectFile, c.file, String(c.from), String(c.to), opts.comp ?? '', String(opts.crf ?? 18)], {execArgv: process.execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let err = '';
    child.stderr!.on('data', (d: Buffer) => (err += d));
    child.on('message', (m: {done?: number}) => {
      if (m.done !== undefined) { progress[i] = m.done; opts.onProgress?.(progress.reduce((x, y) => x + y, 0), total); }
    });
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`chunk ${i} failed: ${err.slice(-1500)}`))));
  })));

  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, chunks.map((c) => `file '${c.file}'`).join('\n'));
  const audio = audioGraph(project, comp, path.dirname(path.resolve(projectFile)), from, to, 1);
  const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...audio.inputs];
  if (audio.filter) args.push('-filter_complex', audio.filter, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'copy', '-movflags', '+faststart', out);
  await runFfmpeg(args).done;
  fs.rmSync(tmp, {recursive: true, force: true});
  return {out, frames: total, seconds: to - from, audioTracks: audio.count, workers};
};
