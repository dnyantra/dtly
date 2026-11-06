// Preview export (task 2.7, D12): watermarked, 720p, local only, no server call. Progress and cancel.
import {fork, spawnSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ExportProgress} from '../shared/types.js';
import {projectFile, readJson, writeJsonAtomic} from './projects.js';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
export const PREVIEW_COMP = '__cpv_preview';
export const WATERMARK = 'PREVIEW · CustomerPro Video';

// Wraps the root comp in a 720p comp with a watermark on top. The original project is not touched.
export const previewProject = (project: any, opts: {shortSide?: number; watermark?: string} = {}) => {
  const p = structuredClone(project);
  const root = p.comps.find((c: any) => c.id === p.root);
  if (!root) throw new Error('Project has no root composition');
  const short = opts.shortSide ?? 720;
  const s = Math.min(1, short / Math.min(root.width, root.height));
  const W = even(root.width * s), H = even(root.height * s);
  const text = opts.watermark ?? WATERMARK;
  const big = Math.round(Math.min(W, H) * 0.075);
  p.comps.push({
    id: PREVIEW_COMP, name: 'Preview', width: W, height: H, fps: root.fps, duration: root.duration, background: root.background ?? '#000000',
    layers: [
      {id: '__cpv_wm_small', type: 'text', text, size: Math.round(big * 0.45), weight: 700, color: 'rgba(255,255,255,0.85)', align: 'center',
        shadow: {color: 'rgba(0,0,0,0.6)', blur: 6}, transform: {position: [W / 2, H - Math.round(H * 0.04)]}},
      {id: '__cpv_wm_big', type: 'text', text: 'PREVIEW', size: big * 2, weight: 800, color: 'rgba(255,255,255,0.22)', align: 'center',
        stroke: {color: 'rgba(0,0,0,0.18)', width: 2}, transform: {position: [W / 2, H / 2], rotation: -30}},
      {id: '__cpv_root', type: 'precomp', comp: root.id, transform: {position: [W / 2, H / 2], scale: [s * 100, s * 100]}},
    ],
  });
  p.root = PREVIEW_COMP;
  return {project: p, width: W, height: H, duration: root.duration as number};
};

export const killTree = (child: ChildProcess) => {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
};

export interface ExportJob { id: string; out: string; cancel: () => void; done: Promise<ExportProgress> }

// The child script sits next to this module once bundled (dist/engine/render-child.js); tests may pass one.
export const startPreviewExport = (dir: string, opts: {id?: string; out?: string; childScript: string; execArgv?: string[]; workers?: number; onProgress?: (p: ExportProgress) => void}): ExportJob => {
  const id = opts.id ?? `exp-${Date.now().toString(36)}`;
  const project = readJson<any>(projectFile(dir), null);
  if (!project) throw new Error('Cannot read project.json');
  const prev = previewProject(project);
  // Sources are relative to the project folder, so the temporary project lives there too.
  const tmpProject = path.join(dir, `.preview-${id}.json`);
  writeJsonAtomic(tmpProject, prev.project);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const out = opts.out ?? path.join(dir, 'renders', `${(project.name || 'video').replace(/[^\w-]+/g, '-')}-preview-${stamp}.mp4`);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const workers = opts.workers ?? Math.max(1, Math.min(os.cpus().length - 1, prev.duration > 6 ? 8 : 1));
  const env: NodeJS.ProcessEnv = {...process.env};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  // DT.ly picks the H.264 encoder itself (libx264 if present, else a working hardware encoder), so LGPL
  // ffmpeg builds export without the old encoder shim.
  const execArgv = opts.execArgv ?? [];
  const child = fork(opts.childScript, [], {execArgv, env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d).slice(-4000)));
  let cancelled = false;
  let total = Math.round(prev.duration * (project.comps.find((c: any) => c.id === project.root)?.fps ?? 30));
  const emit = (p: Omit<ExportProgress, 'id'>) => opts.onProgress?.({id, ...p});
  const done = new Promise<ExportProgress>((resolve) => {
    let finished = false;
    const finish = (p: Omit<ExportProgress, 'id'>) => {
      if (finished) return;
      finished = true;
      fs.rmSync(tmpProject, {force: true});
      if (p.phase !== 'finished') fs.rmSync(out, {force: true});
      emit(p);
      resolve({id, ...p});
    };
    child.on('message', (m: any) => {
      if (m.type === 'progress') { total = m.total; emit({phase: 'render', done: m.done, total: m.total}); }
      else if (m.type === 'done') finish({phase: 'finished', done: total, total, out});
      else if (m.type === 'error') finish({phase: 'error', done: 0, total, error: m.message});
    });
    child.on('exit', (code) => {
      if (cancelled) finish({phase: 'cancelled', done: 0, total});
      else if (code !== 0) finish({phase: 'error', done: 0, total, error: (stderr.match(/^\w*Error[^\n]*/m)?.[0] ?? stderr.trim().split('\n').slice(-3).join('\n')) || `render exited with ${code}`});
      else if (fs.existsSync(out)) finish({phase: 'finished', done: total, total, out});
    });
  });
  child.send({project: tmpProject, out, workers});
  emit({phase: 'render', done: 0, total});
  return {id, out, done, cancel: () => { cancelled = true; killTree(child); }};
};
