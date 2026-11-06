// Project = a folder (design D3):
//   project.json  media/  vo/  music/  sources.json  analysis.json  director/  renders/  .customerpro.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AnalysisFile, LinkFile, ProjectPreset, ProjectSummary, SourcesFile} from '../shared/types.js';
import {PRESET_SIZES} from '../shared/types.js';

export const PROJECT_FILE = 'project.json';
export const SOURCES_FILE = 'sources.json';
export const ANALYSIS_FILE = 'analysis.json';
export const LINK_FILE = '.customerpro.json';
export const SUBDIRS = ['media', 'vo', 'music', 'director', 'renders'] as const;
export const CACHE_DIR = '.cache';

export const defaultProjectsRoot = () => process.env.CPV_PROJECTS_ROOT || path.join(os.homedir(), 'CustomerPro Video');

// Folder names: keep them readable but valid on Windows and macOS.
export const safeFolderName = (name: string) => {
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (s || 'Untitled').slice(0, 80);
};

const uniqueDir = (root: string, base: string) => {
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base} ${i}`);
  return dir;
};

export const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
};
export const writeJsonAtomic = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

export const isProjectDir = (dir: string) => fs.existsSync(path.join(dir, PROJECT_FILE));
export const projectFile = (dir: string) => path.join(dir, PROJECT_FILE);

// A minimal DT.ly project (same shape as DT.ly's newProject; kept local so creating a folder needs no engine import).
const blankProject = (name: string, preset: ProjectPreset) => {
  const [width, height] = PRESET_SIZES[preset];
  return {dtly: 1 as const, name, root: 'main', comps: [{id: 'main', name: 'Main', width, height, fps: 30, duration: 10, background: '#000000', layers: []}]};
};

export const ensureLayout = (dir: string) => {
  for (const d of SUBDIRS) fs.mkdirSync(path.join(dir, d), {recursive: true});
  if (!fs.existsSync(path.join(dir, SOURCES_FILE))) writeJsonAtomic(path.join(dir, SOURCES_FILE), {version: 1, sources: []} satisfies SourcesFile);
  if (!fs.existsSync(path.join(dir, ANALYSIS_FILE))) writeJsonAtomic(path.join(dir, ANALYSIS_FILE), {version: 1, byHash: {}} satisfies AnalysisFile);
};

export const createProject = (o: {name: string; preset?: ProjectPreset; root?: string; project?: unknown}) => {
  const root = o.root ?? defaultProjectsRoot();
  fs.mkdirSync(root, {recursive: true});
  const dir = uniqueDir(root, safeFolderName(o.name));
  fs.mkdirSync(dir, {recursive: true});
  ensureLayout(dir);
  writeJsonAtomic(projectFile(dir), o.project ?? blankProject(path.basename(dir), o.preset ?? 'reel'));
  return dir;
};

export const openProjectDir = (dir: string) => {
  if (!isProjectDir(dir)) throw new Error(`Not a CustomerPro Video project: ${dir}`);
  ensureLayout(dir);
  return summarize(dir);
};

export const summarize = (dir: string): ProjectSummary => {
  const pf = projectFile(dir);
  const p = readJson<{name?: string; root?: string; comps?: {id: string; width: number; height: number; duration: number}[]}>(pf, {});
  const root = p.comps?.find((c) => c.id === p.root);
  const st = fs.statSync(pf);
  const posterFile = path.join(dir, CACHE_DIR, 'poster.jpg');
  return {
    dir, name: p.name ?? path.basename(dir), updatedAt: st.mtimeMs,
    width: root?.width, height: root?.height, duration: root?.duration,
    linked: fs.existsSync(path.join(dir, LINK_FILE)),
    poster: fs.existsSync(posterFile) ? posterFile : undefined,
  };
};

// Projects under the root folder plus any recently opened elsewhere, newest first.
export const listProjects = (opts: {root?: string; extra?: string[]} = {}) => {
  const root = opts.root ?? defaultProjectsRoot();
  const dirs = new Set<string>();
  if (fs.existsSync(root)) for (const e of fs.readdirSync(root, {withFileTypes: true})) if (e.isDirectory() && isProjectDir(path.join(root, e.name))) dirs.add(path.join(root, e.name));
  for (const d of opts.extra ?? []) if (isProjectDir(d)) dirs.add(path.resolve(d));
  return [...dirs].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
};

// Renames the folder and the project's name. Returns the new folder.
export const renameProject = (dir: string, name: string) => {
  const pf = projectFile(dir);
  const p = readJson<Record<string, unknown>>(pf, {});
  const target = path.join(path.dirname(dir), safeFolderName(name));
  let newDir = dir;
  if (path.resolve(target) !== path.resolve(dir)) {
    newDir = fs.existsSync(target) ? uniqueDir(path.dirname(dir), safeFolderName(name)) : target;
    fs.renameSync(dir, newDir);
  }
  p.name = name;
  writeJsonAtomic(projectFile(newDir), p);
  return newDir;
};

// Copies a project folder (used for "keep mine as a copy" on a sync conflict). Raw files stay referenced.
export const duplicateProject = (dir: string, name: string) => {
  const newDir = uniqueDir(path.dirname(dir), safeFolderName(name));
  fs.cpSync(dir, newDir, {recursive: true, filter: (src) => path.basename(src) !== LINK_FILE});
  const p = readJson<Record<string, unknown>>(projectFile(newDir), {});
  p.name = path.basename(newDir);
  writeJsonAtomic(projectFile(newDir), p);
  return newDir;
};

export const readLink = (dir: string): LinkFile | undefined => {
  const f = path.join(dir, LINK_FILE);
  return fs.existsSync(f) ? readJson<LinkFile | undefined>(f, undefined) : undefined;
};
export const writeLink = (dir: string, link: LinkFile | undefined) => {
  const f = path.join(dir, LINK_FILE);
  if (link) writeJsonAtomic(f, link);
  else fs.rmSync(f, {force: true});
};

export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const projectHash = (dir: string) => sha256(fs.readFileSync(projectFile(dir)));

// Sources in project.json must be relative (media/…, vo/…, music/…): same file valid on web and desktop (D3, D9).
export const RELATIVE_SRC = /^(media|vo|music)\/[^\\]+$/;
export const checkRelativeSources = (project: {comps: {layers: {src?: unknown}[]}[]; fonts?: Record<string, string[]>}) => {
  const bad: string[] = [];
  for (const c of project.comps) for (const l of c.layers) {
    if (typeof l.src === 'string' && !/^https?:/i.test(l.src) && (!RELATIVE_SRC.test(l.src) || l.src.split('/').includes('..'))) bad.push(l.src);
  }
  return bad;
};

// Finds a project folder for a CustomerPro project id (used by customerpro-video://open).
export const findLinkedProject = (projectId: string | number, opts: {root?: string; extra?: string[]} = {}) =>
  listProjects(opts).find((s) => String(readLink(s.dir)?.projectId) === String(projectId));
