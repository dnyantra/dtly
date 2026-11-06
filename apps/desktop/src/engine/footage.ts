// Footage pipeline (D8), engine side: contact sheets, audio for speech-to-text, and segment_prepare.
import fs from 'node:fs';
import path from 'node:path';
import type {AnalysisEntry, AnalysisFile, Aspect, Grade, GradeName, SegmentOptions, SegmentResult, SourceEntry} from '../shared/types.js';
import {ffmpegPath, h264Args, hwDecodeArgs, probe, run} from './ffmpeg.js';
import {ANALYSIS_FILE, CACHE_DIR, projectFile, readJson, writeJsonAtomic} from './projects.js';
import {getSource} from './sources.js';

const SHEET_W = 1280, SHEET_H = 720, COLS = 3, ROWS = 2;

export const readAnalysis = (dir: string) => readJson<AnalysisFile>(path.join(dir, ANALYSIS_FILE), {version: 1, byHash: {}});
const updateAnalysis = (dir: string, hash: string, patch: Partial<AnalysisEntry>) => {
  const a = readAnalysis(dir);
  a.byHash[hash] = {...a.byHash[hash], ...patch, updatedAt: new Date().toISOString()};
  writeJsonAtomic(path.join(dir, ANALYSIS_FILE), a);
  return a.byHash[hash];
};

const srcPathOf = (dir: string, e: SourceEntry) => (e.copiedTo ? path.join(dir, e.copiedTo) : e.path);

const durationOf = async (e: SourceEntry, file: string) => e.probe?.duration ?? (await probe(file)).duration ?? 0;

// Evenly spaced moments, kept clear of the very end (seeking past the last keyframe yields nothing).
export const sheetTimes = (duration: number, n = COLS * ROWS) => {
  const usable = Math.max(0.05, duration - 0.25);
  return [...Array(n).keys()].map((i) => Math.round(((usable * (i + 0.5)) / n) * 1000) / 1000);
};

// 6 frames → one 1280×720 PNG (3×2 grid, letterboxed cells). Cached per content hash.
export const contactSheet = async (dir: string, sourceId: string, opts: {signal?: AbortSignal; force?: boolean} = {}) => {
  const e = getSource(dir, sourceId);
  if (e.kind !== 'video') throw new Error(`${e.name} is not a video`);
  const file = srcPathOf(dir, e);
  const rel = `${CACHE_DIR}/sheets/${e.hash.slice(0, 16)}.png`;
  const out = path.join(dir, rel);
  const cached = readAnalysis(dir).byHash[e.hash]?.sheet;
  if (!opts.force && cached && fs.existsSync(path.join(dir, cached.file))) return cached;
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const times = sheetTimes(await durationOf(e, file));
  const cw = Math.floor(SHEET_W / COLS), ch = Math.floor(SHEET_H / ROWS);
  const inputs = times.flatMap((t) => [...hwDecodeArgs(), '-ss', t.toFixed(3), '-i', file]);
  const cells = times.map((_, i) => `[${i}:v:0]trim=end_frame=1,scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24[c${i}]`);
  const rows = [...Array(ROWS).keys()].map((r) => `${[...Array(COLS).keys()].map((c) => `[c${r * COLS + c}]`).join('')}hstack=inputs=${COLS}[r${r}]`);
  const graph = [...cells, ...rows, `${[...Array(ROWS).keys()].map((r) => `[r${r}]`).join('')}vstack=inputs=${ROWS},pad=${SHEET_W}:${SHEET_H}:(ow-iw)/2:(oh-ih)/2:color=black[out]`].join(';');
  await run(ffmpegPath(), ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', out], {signal: opts.signal});
  const sheet = {file: rel, times, width: SHEET_W, height: SHEET_H};
  updateAnalysis(dir, e.hash, {sheet});
  return sheet;
};

// 16 kHz mono WAV for speech-to-text (CustomerPro speech/transcribe). Clips without audio record {none:true}.
export const extractAudio = async (dir: string, sourceId: string, opts: {signal?: AbortSignal; force?: boolean} = {}) => {
  const e = getSource(dir, sourceId);
  const file = srcPathOf(dir, e);
  const cached = readAnalysis(dir).byHash[e.hash]?.audio;
  if (!opts.force && cached && ('none' in cached || fs.existsSync(path.join(dir, cached.file)))) return cached;
  const pr = e.probe ?? (await probe(file));
  if (!pr.audio) return updateAnalysis(dir, e.hash, {audio: {none: true}}).audio!;
  const rel = `${CACHE_DIR}/audio/${e.hash.slice(0, 16)}.wav`;
  const out = path.join(dir, rel);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  await run(ffmpegPath(), ['-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], {signal: opts.signal});
  const duration = (await probe(out)).duration ?? 0;
  return updateAnalysis(dir, e.hash, {audio: {file: rel, sampleRate: 16000, channels: 1, duration}}).audio!;
};

// Pass 1 without AI (task 2.5): contact sheet + audio for each video in the bin. Per-file failures are reported and skipped.
export const analysePass1 = async (dir: string, ids: string[], opts: {signal?: AbortSignal; onProgress?: (done: number, total: number, name: string) => void} = {}) => {
  const results: {id: string; ok: boolean; error?: string}[] = [];
  for (const [i, id] of ids.entries()) {
    if (opts.signal?.aborted) break;
    const e = getSource(dir, id);
    opts.onProgress?.(i, ids.length, e.name);
    try {
      if (e.kind === 'video') await contactSheet(dir, id, opts);
      if (e.kind === 'video' || e.kind === 'audio') await extractAudio(dir, id, opts);
      results.push({id, ok: true});
    } catch (err) { results.push({id, ok: false, error: (err as Error).message}); }
  }
  opts.onProgress?.(ids.length, ids.length, '');
  return results;
};

const ASPECT_SIZE: Record<Aspect, [number, number]> = {'9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080]};
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// Base looks from KK Park's prep.mjs. prep.mjs used `eq`, which is GPL-only in FFmpeg, so the looks are
// rebuilt from LGPL filters (D2): lutyuv for contrast + gamma on luma, hue for saturation (same maths as eq's
// contrast/gamma/saturation), plus colorbalance and unsharp as before. Expects 8-bit input (format=yuv420p first).
const toneFilter = (contrast = 1, saturation = 1, gamma = 1) => {
  const parts: string[] = [];
  if (contrast !== 1 || gamma !== 1) parts.push(`lutyuv=y='clip(((pow(val/255\\,${(1 / gamma).toFixed(4)})-0.5)*${contrast}+0.5)*255\\,0\\,255)'`);
  if (saturation !== 1) parts.push(`hue=s=${saturation}`);
  return parts;
};
export const gradeFilter = (g: GradeName | Grade | undefined): string | undefined => {
  if (!g || g === 'none') return undefined;
  if (g === 'drone') return [...toneFilter(1.12, 1.28, 0.97), 'colorbalance=rs=-0.03:bs=0.04:rh=0.04:bh=-0.03', 'unsharp=5:5:0.5'].join(',');
  if (g === 'phone') return [...toneFilter(1.06, 1.15, 1), 'colorbalance=rh=0.03:bh=-0.02'].join(',');
  const parts = toneFilter(g.contrast ?? 1, g.saturation ?? 1, g.gamma ?? 1);
  if (g.warmth) parts.push(`colorbalance=rh=${(g.warmth * 0.05).toFixed(3)}:bh=${(-g.warmth * 0.05).toFixed(3)}`);
  if (g.sharpen) parts.push('unsharp=5:5:0.5');
  return parts.join(',') || undefined;
};

const rotateFilter = (r?: number) => (r === 90 ? 'transpose=1' : r === 180 ? 'hflip,vflip' : r === 270 ? 'transpose=2' : undefined);

const slug = (s: string) => s.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip';

const compSize = (dir: string): [number, number] => {
  const p = readJson<{root?: string; comps?: {id: string; width: number; height: number}[]}>(projectFile(dir), {});
  const c = p.comps?.find((x) => x.id === p.root);
  return c ? [c.width, c.height] : [1080, 1920];
};

// segment_prepare(source, from, to, {aspect, cx, cy, rotate, grade}) — D8 / KK Park prep.mjs as a function:
// cut [from-0.7, to+0.7], crop to the comp aspect at 1.1× the comp size, grade, H.264 at CRF 16 → media/<name>.mp4.
export const segmentPrepare = async (dir: string, sourceId: string, from: number, to: number, opts: SegmentOptions & {signal?: AbortSignal; onProgress?: (fraction: number) => void} = {}): Promise<SegmentResult> => {
  const t0 = Date.now();
  if (!(to > from) || from < 0) throw new Error(`Bad range ${from}–${to}`);
  const e = getSource(dir, sourceId);
  if (e.kind !== 'video') throw new Error(`${e.name} is not a video`);
  const file = srcPathOf(dir, e);
  if (!fs.existsSync(file)) throw new Error(`${e.name} is missing. Use Locate… in the media bin.`);
  const duration = await durationOf(e, file);
  const handles = opts.handles ?? 0.7;
  const start = Math.max(0, from - handles);
  const end = Math.min(duration || to + handles, to + handles);
  if (end <= start) throw new Error(`${from}–${to} is outside the clip (${duration.toFixed(2)} s)`);

  const [cw, chh] = opts.size ?? (opts.aspect ? ASPECT_SIZE[opts.aspect] : compSize(dir));
  const W = even(cw * 1.1), H = even(chh * 1.1);
  const cx = Math.min(1, Math.max(0, opts.cx ?? 0.5)), cy = Math.min(1, Math.max(0, opts.cy ?? 0.5));
  const fps = opts.fps ?? 30;
  const cover = `scale=w='if(gt(iw/ih,${W}/${H}),-2,${W})':h='if(gt(iw/ih,${W}/${H}),${H},-2)':flags=lanczos,crop=${W}:${H}:'(iw-${W})*${cx}':'(ih-${H})*${cy}'`;
  const vf = [rotateFilter(opts.rotate), cover, `fps=${fps}`, 'format=yuv420p', gradeFilter(opts.grade ?? (/^DJI_/i.test(e.name) ? 'drone' : 'phone'))].filter(Boolean).join(',');

  const name = slug(opts.name ?? `${slug(e.name)}-${from.toFixed(1).replace('.', '_')}`);
  const rel = `media/${name}.mp4`;
  const out = path.join(dir, rel);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const tmp = path.join(dir, 'media', `.${name}.part.mp4`);
  const enc = h264Args(16);
  const hw = hwDecodeArgs();
  const len = end - start;
  const args = ['-v', 'error', '-stats', '-y', ...hw, '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', file, '-map', '0:v:0', '-an', '-vf', vf, ...enc.args, '-r', String(fps), '-movflags', '+faststart', tmp];
  try {
    await run(ffmpegPath(), args, {
      signal: opts.signal,
      onStderr: (s) => {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (m && opts.onProgress) opts.onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / len));
      },
    });
    fs.renameSync(tmp, out);
  } finally { fs.rmSync(tmp, {force: true}); }
  const pr = await probe(out);
  return {file: rel, width: W, height: H, duration: pr.duration ?? len, handleIn: from - start, handleOut: end - to, encoder: enc.encoder, hwDecode: hw.length > 0, seconds: (Date.now() - t0) / 1000};
};

// "Add to timeline": a prepared segment becomes a video layer at the end of the root comp's video track.
// Size is the 1.1× segment, scaled to fit the comp exactly (room for a Ken Burns move without upscaling).
export const addSegmentLayer = (project: any, seg: SegmentResult, from: number, to: number, o: {at?: number; name?: string} = {}) => {
  const comp = project.comps.find((c: any) => c.id === project.root);
  if (!comp) throw new Error('Project has no root composition');
  const videos = comp.layers.filter((l: any) => l.type === 'video' || l.type === 'precomp');
  const at = o.at ?? videos.reduce((m: number, l: any) => Math.max(m, l.outPoint ?? comp.duration), 0);
  const len = to - from;
  const scale = Math.round((comp.width / seg.width) * 100 * 1000) / 1000;
  const ids = new Set(project.comps.flatMap((c: any) => c.layers.map((l: any) => l.id)));
  let id = `clip-${ids.size + 1}`;
  for (let i = 2; ids.has(id); i++) id = `clip-${ids.size + i}`;
  const layer = {id, name: o.name ?? path.basename(seg.file, '.mp4'), type: 'video', src: seg.file, fit: 'cover', size: [seg.width, seg.height], volume: 0, trimIn: Math.round(seg.handleIn * 1000) / 1000, inPoint: at, outPoint: Math.round((at + len) * 1000) / 1000, transform: {scale: [scale, scale]}};
  // Index: just above the lowest layer stack position of existing clips (titles stay on top).
  const lastClip = comp.layers.findIndex((l: any) => l.type === 'video' || l.type === 'precomp');
  comp.layers.splice(lastClip < 0 ? comp.layers.length : lastClip, 0, layer);
  if (layer.outPoint > comp.duration) comp.duration = layer.outPoint;
  return layer;
};
