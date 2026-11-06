// Final export (task 5.2, D12): no watermark, Reel 1080×1920 / Square 1080×1080 / Landscape 1920×1080 (or the
// project's own size), H.264 at ~8 Mbps + AAC 192k, plus an optional WhatsApp copy under 16 MB. Progress with
// time left, cancellable. The server grant (POST exports) is asked for by the main process before this runs.
//
// Encoding: DT.ly renders a high-quality master (CRF 16; its `videoEncoder: 'auto'` picks libx264 or a working
// hardware encoder, so LGPL builds work). DT.ly's encoder option is quality-based, so the master is then
// re-encoded to the ~8 Mbps target here (audio copied: DT.ly already mixes AAC 192k).
import {fork, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FINAL_PRESETS, type ExportProgress, type FinalExportResult, type FinalPreset, type RenderedFile} from '../shared/types.js';
import {Cancelled, ffmpegPath, h264BitrateArgs, probe} from './ffmpeg.js';
import {killTree, type ExportJob} from './preview.js';
import {projectFile, readJson, writeJsonAtomic} from './projects.js';

export const FINAL_COMP = '__cpv_final';
export const FINAL_VIDEO_BITRATE = 8_000_000; // ≈ 60 MB a minute with audio
export const FINAL_AUDIO_BITRATE = 192_000;
export const WHATSAPP_MAX_BYTES = 16_000_000; // WhatsApp's 16 MB (decimal, the stricter reading)

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// The project with its root comp fitted (contain) into the preset size. Nothing is cropped; a different
// aspect gets the root's background around it. The original project is not touched.
export const finalProject = (project: any, preset: FinalPreset) => {
  const p = structuredClone(project);
  const root = p.comps?.find((c: any) => c.id === p.root);
  if (!root) throw new Error('Project has no root composition');
  const [W, H] = preset === 'project' ? [even(root.width), even(root.height)] : FINAL_PRESETS[preset].size;
  const base = {width: W, height: H, duration: root.duration as number, fps: (root.fps as number) ?? 30};
  if (root.width === W && root.height === H) return {project: p, ...base};
  const s = Math.min(W / root.width, H / root.height);
  p.comps.push({
    id: FINAL_COMP, name: 'Final', width: W, height: H, fps: base.fps, duration: root.duration, background: root.background ?? '#000000',
    layers: [{id: '__cpv_root', type: 'precomp', comp: root.id, transform: {position: [W / 2, H / 2], scale: [s * 100, s * 100]}}],
  });
  p.root = FINAL_COMP;
  return {project: p, ...base};
};

// Bitrates and size for a copy that fits `maxBytes`: 10% margin for the container and encoder overshoot,
// audio 128k (less for long videos), 720p when the video bitrate gets too low for 1080p, 480p below that.
export const planWhatsApp = (duration: number, srcW: number, srcH: number, maxBytes = WHATSAPP_MAX_BYTES) => {
  if (!(duration > 0)) throw new Error('Unknown duration');
  const budget = (maxBytes * 8 * 0.9) / duration; // bits per second for audio + video
  const audio = Math.round(Math.min(128_000, Math.max(48_000, budget * 0.12)));
  const video = Math.round(Math.min(6_000_000, budget - audio));
  if (video < 100_000) throw new Error(`A ${Math.round(duration)} s video can't fit in ${(maxBytes / 1e6).toFixed(0)} MB for WhatsApp`);
  const srcShort = Math.min(srcW, srcH);
  const short = Math.min(srcShort, video >= 2_500_000 ? 1080 : video >= 700_000 ? 720 : 480);
  const s = short / srcShort;
  return {videoBitrate: video, audioBitrate: audio, width: even(srcW * s), height: even(srcH * s)};
};

// ffmpeg with -progress on stdout: reports seconds encoded; cancellable.
const transcode = (args: string[], o: {signal?: AbortSignal; onTime?: (sec: number) => void}) =>
  new Promise<void>((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Cancelled());
    const p = spawn(ffmpegPath(), ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let err = '', buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) { const m = /^out_time_us=(\d+)/.exec(l); if (m) o.onTime?.(Number(m[1]) / 1e6); }
    });
    p.stderr.on('data', (d: Buffer) => (err = (err + d).slice(-4000)));
    const onAbort = () => p.kill('SIGKILL');
    o.signal?.addEventListener('abort', onAbort, {once: true});
    p.on('error', reject);
    p.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (o.signal?.aborted) reject(new Cancelled());
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.trim().split('\n').slice(-4).join('\n')}`));
    });
  });

const describe = async (file: string, encoder?: string): Promise<RenderedFile> => {
  const pr = await probe(file);
  const size = fs.statSync(file).size;
  const duration = pr.duration ?? 0;
  return {file, size, width: pr.video?.displayWidth ?? 0, height: pr.video?.displayHeight ?? 0, duration, bitrate: duration ? Math.round((size * 8) / duration) : 0, encoder};
};

// The WhatsApp copy from the finished main file. Copies it when it already fits; otherwise re-encodes at the
// planned bitrate and, if the encoder overshot (hardware encoders do), again at a proportionally lower one.
export const makeWhatsAppCopy = async (main: RenderedFile, out: string, o: {maxBytes?: number; signal?: AbortSignal; onFraction?: (f: number) => void} = {}): Promise<RenderedFile> => {
  const max = o.maxBytes ?? WHATSAPP_MAX_BYTES;
  if (main.size <= max * 0.97) { fs.copyFileSync(main.file, out); o.onFraction?.(1); return {...main, file: out}; }
  const plan = planWhatsApp(main.duration, main.width, main.height, max);
  let vb = plan.videoBitrate;
  const attempts = 3;
  for (let a = 0; a < attempts; a++) {
    const enc = h264BitrateArgs(vb, {profile: 'main'});
    await transcode(['-i', main.file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${plan.width}:${plan.height}:flags=lanczos`, ...enc.args,
      '-c:a', 'aac', '-b:a', String(plan.audioBitrate), '-ac', '2', '-movflags', '+faststart', out],
    {signal: o.signal, onTime: (t) => o.onFraction?.(Math.min(1, (a + Math.min(1, t / main.duration)) / (a + 1)))});
    const size = fs.statSync(out).size;
    if (size <= max) { o.onFraction?.(1); return describe(out, enc.encoder); }
    vb = Math.round(vb * (max / size) * 0.85);
  }
  fs.rmSync(out, {force: true});
  throw new Error(`Could not make a WhatsApp copy under ${(max / 1e6).toFixed(0)} MB`);
};

export interface FinalExportOptions {
  preset: FinalPreset;
  whatsapp?: boolean;
  whatsappMaxBytes?: number; // tests use a small limit to exercise the re-encode
  videoBitrate?: number;
  id?: string;
  outDir?: string;
  childScript: string;
  execArgv?: string[];
  workers?: number;
  onProgress?: (p: ExportProgress) => void;
}

export const startFinalExport = (dir: string, o: FinalExportOptions): ExportJob => {
  const id = o.id ?? `final-${Date.now().toString(36)}`;
  const project = readJson<any>(projectFile(dir), null);
  if (!project) throw new Error('Cannot read project.json');
  const fin = finalProject(project, o.preset);
  const tmpProject = path.join(dir, `.final-${id}.json`); // next to project.json: sources are relative to it
  writeJsonAtomic(tmpProject, fin.project);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const base = `${(project.name || 'video').replace(/[^\w-]+/g, '-')}-${o.preset === 'project' ? `${fin.width}x${fin.height}` : o.preset}-${stamp}`;
  const outDir = o.outDir ?? path.join(dir, 'renders');
  fs.mkdirSync(outDir, {recursive: true});
  const out = path.join(outDir, `${base}.mp4`);
  const waOut = path.join(outDir, `${base}-whatsapp.mp4`);
  const workers = o.workers ?? Math.max(1, Math.min(os.cpus().length - 1, fin.duration > 6 ? 8 : 1));
  const bitrate = o.videoBitrate ?? FINAL_VIDEO_BITRATE;

  const env: NodeJS.ProcessEnv = {...process.env};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const execArgv = o.execArgv ?? [];
  const master = path.join(outDir, `.${base}-master.mp4`);

  const t0 = Date.now();
  const total = Math.round(fin.duration * fin.fps);
  // Share of the whole job per stage: DT.ly render, the 8 Mbps encode, the WhatsApp copy.
  const wRender = o.whatsapp ? 0.75 : 0.85, wEncode = o.whatsapp ? 0.12 : 0.15;
  let stage: 'render' | 'encode' | 'whatsapp' = 'render';
  let done = 0;
  const ac = new AbortController();
  let child: ReturnType<typeof fork> | undefined;
  let cancelled = false;
  const emit = (p: Partial<ExportProgress> & Pick<ExportProgress, 'phase'>) => o.onProgress?.({id, kind: 'final', done, total, stage, ...p});
  const tick = (fraction: number) => {
    const el = (Date.now() - t0) / 1000;
    const eta = fraction > 0.02 ? Math.max(0, Math.round((el / fraction) * (1 - fraction))) : undefined;
    emit({phase: 'render', fraction, etaSeconds: eta});
  };

  const renderMain = () => new Promise<void>((resolve, reject) => {
    child = fork(o.childScript, [], {execArgv, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    let settled = false;
    const end = (e?: Error) => { if (settled) return; settled = true; if (e) reject(e); else resolve(); };
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d).slice(-4000)));
    child.on('message', (m: any) => {
      if (m.type === 'progress') { done = m.done; tick((m.done / Math.max(1, m.total)) * wRender); }
      else if (m.type === 'error') end(new Error(m.message));
    });
    child.on('exit', (code) => {
      if (cancelled) end(new Cancelled());
      else if (code === 0 && fs.existsSync(master)) end();
      else end(new Error((stderr.match(/^\w*Error[^\n]*/m)?.[0] ?? stderr.trim().split('\n').slice(-3).join('\n')) || `render exited with ${code}`));
    });
    child.send({project: tmpProject, out: master, workers, crf: 16});
  });

  const run = async (): Promise<FinalExportResult> => {
    tick(0);
    await renderMain();
    stage = 'encode';
    tick(wRender);
    const enc = h264BitrateArgs(bitrate);
    await transcode(['-i', master, '-map', '0:v:0', '-map', '0:a:0?', ...enc.args, '-c:a', 'copy', '-movflags', '+faststart', out],
      {signal: ac.signal, onTime: (t) => tick(wRender + wEncode * Math.min(1, t / fin.duration))});
    fs.rmSync(master, {force: true});
    const main = await describe(out, enc.encoder);
    let whatsapp: RenderedFile | undefined;
    if (o.whatsapp) {
      stage = 'whatsapp';
      tick(wRender + wEncode);
      whatsapp = await makeWhatsAppCopy(main, waOut, {maxBytes: o.whatsappMaxBytes, signal: ac.signal, onFraction: (f) => tick(wRender + wEncode + (1 - wRender - wEncode) * f)});
    }
    return {preset: o.preset, main, whatsapp, seconds: (Date.now() - t0) / 1000};
  };

  const finished = run().then(
    (result): ExportProgress => {
      const p: ExportProgress = {id, kind: 'final', phase: 'finished', done: total, total, stage, fraction: 1, etaSeconds: 0, out, result};
      o.onProgress?.(p);
      return p;
    },
    (e: Error): ExportProgress => {
      for (const f of [out, waOut, master]) fs.rmSync(f, {force: true});
      const p: ExportProgress = {id, kind: 'final', phase: cancelled || e instanceof Cancelled ? 'cancelled' : 'error', done, total, stage, error: cancelled ? undefined : e.message};
      o.onProgress?.(p);
      return p;
    },
  ).finally(() => { fs.rmSync(tmpProject, {force: true}); fs.rmSync(master, {force: true}); });

  return {id, out, done: finished, cancel: () => { cancelled = true; ac.abort(); if (child) killTree(child); }};
};
