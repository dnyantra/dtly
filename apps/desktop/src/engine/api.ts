// The engine's request handlers (EngineApi). Transport-agnostic: index.ts wires them to the utility-process
// port (or a Node child process / direct calls in tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {EngineApi, EngineEvents} from '../shared/engine-api.js';
import {redact} from '../shared/misc.js';
import {dtlyCore, dtlyVersion} from './dtly.js';
import {ffmpegInfo} from './ffmpeg.js';
import {addSegmentLayer, analysePass1, contactSheet, extractAudio, readAnalysis, segmentPrepare} from './footage.js';
import {startFinalExport} from './export-final.js';
import {startPreviewExport, type ExportJob} from './preview.js';
import {createProject, defaultProjectsRoot, duplicateProject, listProjects, openProjectDir, projectFile, projectHash, readJson, renameProject, summarize, writeJsonAtomic} from './projects.js';
import {importMedia, listSources, locateSource, readSources, removeSource} from './sources.js';
import {startStudioSession, type StudioSession} from './studio.js';
import {createDirectorHandlers} from './director/index.js';

type Emit = <E extends keyof EngineEvents>(event: E, data: EngineEvents[E]) => void;
type Async<T> = {[K in keyof T]: T[K] extends (p: infer P) => infer R ? (p: P) => Promise<Awaited<R>> : never};
export type EngineHandlers = Async<EngineApi>;

export interface EngineOptions { emit: Emit; childScript: string; projectsRoot?: string; logLines?: string[] }

export const createEngine = (o: EngineOptions): EngineHandlers & {shutdown: () => void} => {
  let studio: StudioSession | undefined;
  const exports = new Map<string, ExportJob>();
  const tasks = new Map<string, AbortController>();
  const root = () => o.projectsRoot ?? defaultProjectsRoot();
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    const line = `${new Date().toISOString()} ${level} ${redact(message)}`;
    o.logLines?.push(line);
    if (o.logLines && o.logLines.length > 2000) o.logLines.splice(0, o.logLines.length - 2000);
    o.emit('log', {level, message: redact(message)});
  };
  // Long jobs get an AbortController under a task name the UI can cancel.
  const task = async <T>(name: string, fn: (signal: AbortSignal) => Promise<T>) => {
    tasks.get(name)?.abort();
    const ac = new AbortController();
    tasks.set(name, ac);
    try { return await fn(ac.signal); } finally { if (tasks.get(name) === ac) tasks.delete(name); }
  };
  const inProject = (dir: string) => {
    const d = path.resolve(dir);
    if (!fs.existsSync(projectFile(d))) throw new Error(`Not a project folder: ${dir}`);
    return d;
  };
  const ffLite = () => {
    const f = ffmpegInfo();
    return {ffmpeg: f.ffmpeg, ffprobe: f.ffprobe, version: f.version, lgpl: f.lgpl, h264: f.encoders.filter((e) => /264/.test(e)), hwaccels: f.hwaccels};
  };

  // AI director (tasks 4.2–4.5): agent loop, footage analysis, plan → build → edit.
  const director = createDirectorHandlers({projectsRoot: o.projectsRoot, emitEvent: (e) => o.emit('director', e), emitHostCall: (c) => o.emit('hostCall', c)});
  const h: EngineHandlers = {
    ...director,
    async ping() { return {pong: true, pid: process.pid, versions: {node: process.versions.node, electron: process.versions.electron}}; },
    async info() { return {ffmpeg: ffLite(), dtly: dtlyVersion(), node: process.versions.node, electron: process.versions.electron, projectsRoot: root()}; },
    async listProjects(p) { return listProjects({root: root(), extra: p?.extra}); },
    async createProject(p) {
      const dir = createProject({name: p.name, preset: p.preset, project: p.project, root: root()});
      log('info', `created project ${dir}`);
      return summarize(dir);
    },
    async renameProject(p) {
      const reopen = studio && studio.dir === path.resolve(p.dir);
      if (reopen) { studio!.close(); studio = undefined; }
      return summarize(renameProject(inProject(p.dir), p.name));
    },
    async duplicateProject(p) { return summarize(duplicateProject(inProject(p.dir), p.name)); },
    async openProject(p) {
      const dir = inProject(p.dir);
      const summary = openProjectDir(dir);
      if (studio?.dir === dir) {
        studio.setOptions({readOnly: p.readOnly, parentOrigin: p.parentOrigin});
        return {project: summary, studioUrl: studio.url};
      }
      studio?.close();
      studio = undefined;
      studio = await startStudioSession(dir, {readOnly: p.readOnly, parentOrigin: p.parentOrigin, onProjectChanged: (e) => o.emit('projectChanged', {dir, ...e})});
      log('info', `opened ${dir}`);
      return {project: summary, studioUrl: studio.url};
    },
    async closeProject() { const had = !!studio; studio?.close(); studio = undefined; return {closed: had}; },
    async setStudioOptions(p) { studio?.setOptions(p); return {ok: true}; },
    async readProjectFile(p) { const dir = inProject(p.dir); return {project: readJson(projectFile(dir), null), hash: projectHash(dir)}; },
    async writeProjectFile(p) {
      const dir = inProject(p.dir);
      const proj = p.project as {dtly?: number};
      if (proj?.dtly !== 1) throw new Error('Not a DT.ly project');
      writeJsonAtomic(projectFile(dir), proj);
      return {hash: projectHash(dir)};
    },
    async importMedia(p) {
      const dir = inProject(p.dir);
      return task(`import:${dir}`, (signal) => importMedia(dir, p.paths, {signal, onProgress: (done, total, label) => o.emit('progress', {task: 'import', done, total, label})}));
    },
    async listSources(p) { return listSources(inProject(p.dir)); },
    async locateSource(p) { return locateSource(inProject(p.dir), p.id, p.path); },
    async removeSource(p) { removeSource(inProject(p.dir), p.id); return {ok: true}; },
    async analyse(p) {
      const dir = inProject(p.dir);
      const ids = p.ids ?? readSources(dir).sources.filter((e) => e.kind === 'video' || e.kind === 'audio').map((e) => e.id);
      return task(`analyse:${dir}`, (signal) => analysePass1(dir, ids, {signal, onProgress: (done, total, label) => o.emit('progress', {task: 'analyse', done, total, label})}));
    },
    async analysis(p) { return readAnalysis(inProject(p.dir)); },
    async contactSheet(p) { return contactSheet(inProject(p.dir), p.id, {force: p.force}); },
    async extractAudio(p) { return extractAudio(inProject(p.dir), p.id); },
    async segmentPrepare(p) {
      const dir = inProject(p.dir);
      return task(`segment:${dir}`, (signal) => segmentPrepare(dir, p.id, p.from, p.to, {...p.opts, signal, onProgress: (f) => o.emit('progress', {task: 'segment', done: Math.round(f * 100), total: 100})}));
    },
    async addToTimeline(p) {
      const dir = inProject(p.dir);
      const segment = await h.segmentPrepare(p);
      // Read → add → write: the Studio server sees the change on disk and streams it to the open editor.
      const proj = readJson<any>(projectFile(dir), null);
      const layer = addSegmentLayer(proj, segment, p.from, p.to, {at: p.at});
      const {validate} = await dtlyCore();
      const warnings = validate(proj);
      if (warnings.length) log('warn', `after adding ${layer.id}: ${warnings.join('; ')}`);
      writeJsonAtomic(projectFile(dir), proj);
      return {segment, layerId: layer.id};
    },
    async startPreviewExport(p) {
      const dir = inProject(p.dir);
      const job = startPreviewExport(dir, {childScript: o.childScript, onProgress: (e) => o.emit('export', e)});
      exports.set(job.id, job);
      job.done.then((r) => { log(r.phase === 'error' ? 'error' : 'info', `export ${job.id} ${r.phase}${r.error ? `: ${r.error}` : ''}`); exports.delete(job.id); });
      return {id: job.id, out: job.out};
    },
    async startFinalExport(p) {
      const dir = inProject(p.dir);
      if (p.id && exports.has(p.id)) throw new Error('That export is already running');
      const job = startFinalExport(dir, {preset: p.preset, whatsapp: p.whatsapp, whatsappMaxBytes: p.whatsappMaxBytes, id: p.id, childScript: o.childScript, onProgress: (e) => o.emit('export', e)});
      exports.set(job.id, job);
      job.done.then((r) => { log(r.phase === 'error' ? 'error' : 'info', `final export ${job.id} ${r.phase}${r.error ? `: ${r.error}` : ''}${r.result ? ` (${r.result.main.size} bytes, ${r.result.seconds.toFixed(1)} s)` : ''}`); exports.delete(job.id); });
      return {id: job.id, out: job.out};
    },
    async cancelExport(p) { const j = exports.get(p.id); j?.cancel(); return {cancelled: !!j}; },
    async cancelTask(p) {
      let n = 0;
      for (const [k, ac] of tasks) if (k === p.task || k.startsWith(`${p.task}:`)) { ac.abort(); n++; }
      return {cancelled: n > 0};
    },
    async diagnostics() {
      let ff: unknown;
      try { ff = ffLite(); } catch (e) { ff = {error: (e as Error).message}; }
      return {
        engine: {pid: process.pid, node: process.versions.node, electron: process.versions.electron, uptime: process.uptime(), memory: process.memoryUsage()},
        os: {platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMem: os.totalmem(), freeMem: os.freemem()},
        ffmpeg: ff, dtly: dtlyVersion(), projectsRoot: root(),
        openProject: studio ? {dir: path.basename(studio.dir)} : null,
        log: (o.logLines ?? []).slice(-500),
      };
    },
  };
  return {...h, shutdown: () => { director.shutdown(); studio?.close(); for (const j of exports.values()) j.cancel(); for (const t of tasks.values()) t.abort(); }};
};
