// Path guard for the director's tools (D7, D14): reads only inside the project folder and the raw files the
// owner added to the bin; writes only inside the project folder (never the link file or the bin list).
import fs from 'node:fs';
import path from 'node:path';
import type {SourceEntry} from '../../shared/types.js';
import {LINK_FILE, SOURCES_FILE} from '../projects.js';
import {readSources} from '../sources.js';

const real = (p: string) => {
  // Resolve symlinks of the longest existing prefix, so a link inside the project can't point outside it.
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try { return path.join(fs.realpathSync(cur), ...rest); } catch { return path.resolve(p); }
};
export const isInside = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};

export class PathRefused extends Error {
  constructor(p: string, write: boolean) {
    super(`${write ? 'Writing' : 'Reading'} ${p} is not allowed: the director can only use the files added to this project${write ? ' and write inside its folder' : ''}.`);
    this.name = 'PathRefused';
  }
}

export interface Guard {
  dir: string;
  allowRead(abs: string): boolean;
  allowWrite(abs: string): boolean;
  checkWrite(rel: string): string; // → absolute path, or throws PathRefused
  // A bin entry by id, hash, name or relative path (media/…), with the absolute file to read.
  source(ref: string): {entry: SourceEntry; file: string};
}

export const createGuard = (projectDir: string): Guard => {
  const dir = real(projectDir);
  const raw = () => new Set(readSources(projectDir).sources.map((e) => real(e.path)));
  const allowRead = (abs: string) => {
    const r = real(abs);
    return isInside(r, dir) || raw().has(r);
  };
  const allowWrite = (abs: string) => {
    const r = real(abs);
    if (!isInside(r, dir) || r === dir) return false;
    const rel = path.relative(dir, r).split(path.sep).join('/');
    return rel !== LINK_FILE && rel !== SOURCES_FILE;
  };
  return {
    dir,
    allowRead,
    allowWrite,
    checkWrite(rel) {
      const abs = path.resolve(dir, rel);
      if (!allowWrite(abs)) throw new PathRefused(rel, true);
      return abs;
    },
    source(ref) {
      const list = readSources(projectDir).sources;
      const norm = ref.replace(/\\/g, '/');
      const e = list.find((x) => x.id === ref || x.hash === ref || x.name === ref || x.copiedTo === norm || x.path === ref);
      if (!e) {
        if (path.isAbsolute(ref) || norm.includes('..')) throw new PathRefused(ref, false);
        throw new Error(`No file "${ref}" in this project's media. Use media_list for the ids.`);
      }
      const file = e.copiedTo ? path.join(projectDir, e.copiedTo) : e.path;
      if (!allowRead(file)) throw new PathRefused(ref, false);
      if (!fs.existsSync(file)) throw new Error(`${e.name} is missing on disk (moved or deleted). Ask the owner to locate it.`);
      return {entry: e, file};
    },
  };
};

// Output-path keys in tool inputs (render_video.out, map_tiles.out, …): each must stay inside the project.
const OUT_KEYS = new Set(['out', 'output', 'dest', 'target']);
export const findWritePaths = (input: unknown): string[] => {
  const found: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string' && key && OUT_KEYS.has(key)) found.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input);
  return found;
};
// Path-like inputs the model gives for reading (svg_import.file, captions_add.src …).
const READ_KEYS = new Set(['file', 'path', 'svg', 'srt', 'vtt', 'transcript']);
export const findReadPaths = (input: unknown): string[] => {
  const found: string[] = [];
  if (input && typeof input === 'object') for (const [k, v] of Object.entries(input)) if (READ_KEYS.has(k) && typeof v === 'string') found.push(v);
  return found;
};
