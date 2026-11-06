// Media bin: raw files referenced in place (sources.json), photos/logos/audio copied into media/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {MediaKind, SourceEntry, SourcesFile, SourceState} from '../shared/types.js';
import {ffmpegPath, hwDecodeArgs, probe, run} from './ffmpeg.js';
import {CACHE_DIR, readJson, SOURCES_FILE, writeJsonAtomic} from './projects.js';

const EXT: Record<string, MediaKind> = {};
for (const e of ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'mts', 'm2ts', 'webm', 'hevc', '3gp', 'mxf']) EXT[e] = 'video';
for (const e of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'svg', 'tif', 'tiff', 'bmp']) EXT[e] = 'image';
for (const e of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus']) EXT[e] = 'audio';
EXT.pdf = 'pdf';

export const kindOf = (file: string): MediaKind => EXT[path.extname(file).slice(1).toLowerCase()] ?? 'other';

const CHUNK = 4 * 1024 * 1024;
// Content id: sha256(first 4 MB + last 4 MB + size). Cheap on 4K clips, stable across moves and renames.
export const quickHash = (file: string) => {
  const st = fs.statSync(file);
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (st.size > CHUNK) {
      const tailLen = Math.min(CHUNK, st.size - CHUNK);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
      h.update(tail);
    }
  } finally { fs.closeSync(fd); }
  h.update(String(st.size));
  return h.digest('hex');
};

export const readSources = (dir: string): SourcesFile => readJson<SourcesFile>(path.join(dir, SOURCES_FILE), {version: 1, sources: []});
export const writeSources = (dir: string, s: SourcesFile) => writeJsonAtomic(path.join(dir, SOURCES_FILE), s);

// Expands folders (recursively, skipping hidden files) into importable files.
export const expandPaths = (paths: string[]) => {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) if (!e.startsWith('.')) walk(path.join(p, e));
    } else if (kindOf(p) !== 'other') out.push(path.resolve(p));
  };
  for (const p of paths) walk(p);
  return out;
};

const thumbFor = async (dir: string, entry: SourceEntry, signal?: AbortSignal) => {
  if (entry.kind !== 'video' && entry.kind !== 'image') return undefined;
  const rel = `${CACHE_DIR}/thumbs/${entry.id}.jpg`;
  const out = path.join(dir, rel);
  if (fs.existsSync(out)) return rel;
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const src = entry.copiedTo ? path.join(dir, entry.copiedTo) : entry.path;
  const at = entry.kind === 'video' ? Math.min(1, (entry.probe?.duration ?? 0) / 3) : 0;
  const pre = entry.kind === 'video' ? [...hwDecodeArgs(), '-ss', at.toFixed(2)] : [];
  try {
    await run(ffmpegPath(), ['-v', 'error', '-y', ...pre, '-i', src, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '4', out], {signal});
    return rel;
  } catch { return undefined; }
};

const copyName = (dir: string, file: string) => {
  const base = path.basename(file).replace(/[^\w.\-]+/g, '-');
  let rel = `media/${base}`;
  const ext = path.extname(base), stem = path.basename(base, ext);
  for (let i = 2; fs.existsSync(path.join(dir, rel)); i++) rel = `media/${stem}-${i}${ext}`;
  return rel;
};

export interface ImportResult { added: SourceEntry[]; skipped: {path: string; reason: string}[] }

// Adds files or folders to the bin. Video is referenced in place; images, audio and PDFs are copied into media/
// (they are small, and the project needs them on the web too).
export const importMedia = async (dir: string, paths: string[], opts: {copyKinds?: MediaKind[]; signal?: AbortSignal; onProgress?: (done: number, total: number, name: string) => void} = {}): Promise<ImportResult> => {
  const copyKinds = opts.copyKinds ?? ['image', 'audio', 'pdf'];
  const files = expandPaths(paths);
  const s = readSources(dir);
  const byHash = new Map(s.sources.map((e) => [e.hash, e]));
  const added: SourceEntry[] = [];
  const skipped: ImportResult['skipped'] = [];
  for (const [i, file] of files.entries()) {
    opts.onProgress?.(i, files.length, path.basename(file));
    if (opts.signal?.aborted) break;
    try {
      const st = fs.statSync(file);
      const hash = quickHash(file);
      const existing = byHash.get(hash);
      if (existing) {
        // Same content already in the bin: if the old path is gone, adopt the new one.
        if (!fs.existsSync(existing.path)) { existing.path = file; existing.mtime = st.mtimeMs; }
        skipped.push({path: file, reason: 'already in the media bin'});
        continue;
      }
      const kind = kindOf(file);
      const entry: SourceEntry = {id: hash.slice(0, 16), path: file, name: path.basename(file), kind, size: st.size, mtime: st.mtimeMs, hash, addedAt: new Date().toISOString()};
      if (kind === 'video' || kind === 'audio' || kind === 'image') {
        try { entry.probe = await probe(file); } catch (e) { if (kind === 'video') throw e; }
      }
      if (copyKinds.includes(kind)) {
        const rel = copyName(dir, file);
        fs.copyFileSync(file, path.join(dir, rel));
        entry.copiedTo = rel;
      }
      entry.thumb = await thumbFor(dir, entry, opts.signal);
      s.sources.push(entry);
      byHash.set(hash, entry);
      added.push(entry);
    } catch (e) {
      skipped.push({path: file, reason: (e as Error).message.split('\n')[0]});
    }
  }
  opts.onProgress?.(files.length, files.length, '');
  writeSources(dir, s);
  return {added, skipped};
};

// The bin with each raw file's state: missing (moved/deleted) or changed on disk.
export const listSources = (dir: string): SourceState[] =>
  readSources(dir).sources.map((e) => {
    const p = e.copiedTo ? path.join(dir, e.copiedTo) : e.path;
    let st: fs.Stats | undefined;
    try { st = fs.statSync(p); } catch { /* missing */ }
    const changed = !!st && !e.copiedTo && (st.size !== e.size || Math.abs(st.mtimeMs - e.mtime) > 1);
    return {...e, missing: !st, changed};
  });

// "Locate…": point a missing entry at its new path. Checks the content hash, then looks for the other
// missing files in the same new folder (a moved folder is the usual case).
export const locateSource = (dir: string, id: string, newPath: string) => {
  const s = readSources(dir);
  const entry = s.sources.find((e) => e.id === id);
  if (!entry) throw new Error(`No source ${id}`);
  if (quickHash(newPath) !== entry.hash) throw new Error(`${path.basename(newPath)} is a different file (content does not match ${entry.name})`);
  const st = fs.statSync(newPath);
  Object.assign(entry, {path: path.resolve(newPath), mtime: st.mtimeMs});
  const relocated = [entry.id];
  const folder = path.dirname(newPath);
  for (const other of s.sources) {
    if (other === entry || other.copiedTo || fs.existsSync(other.path)) continue;
    const candidate = path.join(folder, path.basename(other.path));
    try {
      if (fs.existsSync(candidate) && quickHash(candidate) === other.hash) {
        Object.assign(other, {path: candidate, mtime: fs.statSync(candidate).mtimeMs});
        relocated.push(other.id);
      }
    } catch { /* unreadable: leave missing */ }
  }
  writeSources(dir, s);
  return {relocated};
};

export const removeSource = (dir: string, id: string) => {
  const s = readSources(dir);
  s.sources = s.sources.filter((e) => e.id !== id);
  writeSources(dir, s);
};

export const getSource = (dir: string, id: string) => {
  const e = readSources(dir).sources.find((x) => x.id === id || x.hash === id);
  if (!e) throw new Error(`No source ${id} in this project`);
  return e;
};

// The raw file paths tools may read (path guard for the director, D7/D14).
export const allowedRawPaths = (dir: string) => new Set(readSources(dir).sources.map((e) => path.resolve(e.path)));
