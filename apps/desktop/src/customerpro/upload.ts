// Prepared-media upload to the project's CustomerPro media folder (D9, task 3.7): single PUT for ≤ 100 MB,
// multipart above, resumable (part ETags persisted in .customerpro-uploads.json). Raw files never upload.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {readJson, readLink, writeJsonAtomic, writeLink} from '../engine/projects.js';
import {ApiError, CustomerProClient, type Presign} from './client.js';
import {resignParts} from './media-sync.js';

export const UPLOAD_STATE = '.customerpro-uploads.json';
export const SYNCED_DIRS = ['media', 'vo', 'music'] as const;

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.json': 'application/json',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};
export const contentType = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

interface PartState { n: number; url: string; etag?: string }
interface FileState { size: number; mtime: number; key: string; mode: 'single' | 'multipart'; upload_id?: string; part_size?: number; parts?: PartState[]; url?: string }
type StateFile = Record<string, FileState>;

export class UploadUrlExpired extends Error {}

// PUT a byte range of a file to a presigned URL with an exact Content-Length (S3/R2 reject chunked bodies).
export const putRange = (url: string, file: string, start: number, end: number, o: {contentType?: string; onBytes?: (n: number) => void; signal?: AbortSignal} = {}) =>
  new Promise<string | undefined>((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = {'Content-Length': end - start};
    if (o.contentType) headers['Content-Type'] = o.contentType;
    const req = mod.request(u, {method: 'PUT', headers}, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve((res.headers.etag as string | undefined)?.replace(/"/g, ''));
        else if (res.statusCode === 403 || res.statusCode === 410) reject(new UploadUrlExpired(`Upload URL refused (${res.statusCode})`));
        else reject(new Error(`Upload failed (${res.statusCode}): ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    const onAbort = () => req.destroy(new Error('Cancelled'));
    o.signal?.addEventListener('abort', onAbort, {once: true});
    if (end <= start) { req.end(); return; }
    const rs = fs.createReadStream(file, {start, end: end - 1});
    rs.on('data', (c) => o.onBytes?.((c as Buffer).length));
    rs.on('error', (e) => req.destroy(e));
    rs.pipe(req);
  });

export interface UploadProgress { path: string; sent: number; size: number; fileIndex: number; files: number }

export class MediaUploader {
  constructor(private client: CustomerProClient, private dir: string) {}

  private stateFile() { return path.join(this.dir, UPLOAD_STATE); }
  private readState(): StateFile { return readJson<StateFile>(this.stateFile(), {}); }
  private saveState(s: StateFile) { writeJsonAtomic(this.stateFile(), s); }

  // Files in media/, vo/, music/ not yet uploaded (or changed since).
  pending(): string[] {
    const link = readLink(this.dir);
    const done = link?.uploaded ?? {};
    const out: string[] = [];
    for (const d of SYNCED_DIRS) {
      const root = path.join(this.dir, d);
      if (!fs.existsSync(root)) continue;
      const walk = (p: string) => {
        for (const e of fs.readdirSync(p, {withFileTypes: true})) {
          if (e.name.startsWith('.')) continue;
          const f = path.join(p, e.name);
          if (e.isDirectory()) walk(f);
          else {
            const rel = path.relative(this.dir, f).split(path.sep).join('/');
            const st = fs.statSync(f);
            const prev = done[rel];
            if (!prev || prev.size !== st.size || Math.abs(prev.mtime - st.mtimeMs) > 1) out.push(rel);
          }
        }
      };
      walk(root);
    }
    return out.sort();
  }

  async uploadAll(o: {onProgress?: (p: UploadProgress) => void; signal?: AbortSignal} = {}) {
    const files = this.pending();
    const results: {path: string; url?: string; error?: string}[] = [];
    for (const [i, rel] of files.entries()) {
      if (o.signal?.aborted) break;
      try {
        const url = await this.uploadFile(rel, {signal: o.signal, onProgress: (sent, size) => o.onProgress?.({path: rel, sent, size, fileIndex: i, files: files.length})});
        results.push({path: rel, url});
      } catch (e) { results.push({path: rel, error: (e as Error).message}); if (o.signal?.aborted) break; }
    }
    return results;
  }

  async uploadFile(rel: string, o: {onProgress?: (sent: number, size: number) => void; signal?: AbortSignal} = {}): Promise<string> {
    const link = readLink(this.dir);
    if (!link) throw new Error('Project is not linked to CustomerPro');
    const file = path.join(this.dir, rel);
    const st = fs.statSync(file);
    const state = this.readState();
    let s: FileState | undefined = state[rel];
    if (s && (s.size !== st.size || Math.abs(s.mtime - st.mtimeMs) > 1)) s = undefined; // file changed: start over
    for (let attempt = 0; ; attempt++) {
      if (!s) {
        const p: Presign = await this.client.presignMedia(link.projectId, {path: rel, size: st.size, content_type: contentType(rel)});
        s = p.mode === 'single'
          ? {size: st.size, mtime: st.mtimeMs, key: p.key, mode: 'single', url: p.url}
          : {size: st.size, mtime: st.mtimeMs, key: p.key, mode: 'multipart', upload_id: p.upload_id, part_size: p.part_size, parts: p.parts.map((x) => ({n: x.n, url: x.url}))};
        state[rel] = s;
        this.saveState(state);
      }
      try {
        let sent = 0;
        const bump = (n: number) => { sent += n; o.onProgress?.(sent, st.size); };
        let done: {path: string; url: string};
        if (s.mode === 'single') {
          await putRange(s.url!, file, 0, st.size, {contentType: contentType(rel), onBytes: bump, signal: o.signal});
          done = await this.client.completeMedia(link.projectId, {path: rel, key: s.key, size: st.size});
        } else {
          const ps = s.part_size!;
          for (const part of s.parts!) {
            const a = (part.n - 1) * ps, b = Math.min(st.size, part.n * ps);
            if (part.etag) { bump(b - a); continue; } // resumed: already uploaded
            if (o.signal?.aborted) throw new Error('Cancelled');
            const before = sent;
            try {
              part.etag = (await putRange(part.url, file, a, b, {onBytes: bump, signal: o.signal})) ?? '';
            } catch (e) {
              if (!(e instanceof UploadUrlExpired)) throw e;
              // Part URLs expired (a resume hours later): renew the unfinished ones and carry on from this part.
              // A 404 (upload unknown) falls through to the restart below.
              const fresh = await resignParts(this.client, link.projectId, {key: s.key, upload_id: s.upload_id!, parts: s.parts!.filter((x) => !x.etag).map((x) => x.n)});
              for (const f of fresh.parts) { const t = s.parts!.find((x) => x.n === f.n); if (t) t.url = f.url; }
              this.saveState(state);
              sent = before;
              part.etag = (await putRange(part.url, file, a, b, {onBytes: bump, signal: o.signal})) ?? '';
            }
            this.saveState(state); // persist after each part: a crash resumes here
          }
          done = await this.client.completeMedia(link.projectId, {path: rel, key: s.key, size: st.size, upload_id: s.upload_id, parts: s.parts!.map((p) => ({n: p.n, etag: p.etag!}))});
        }
        delete state[rel];
        this.saveState(state);
        const l = readLink(this.dir)!;
        writeLink(this.dir, {...l, uploaded: {...(l.uploaded ?? {}), [rel]: {size: st.size, mtime: st.mtimeMs, url: done.url}}});
        return done.url;
      } catch (e) {
        // A single-PUT URL expired, or the multipart upload is gone on the server (resign → 404): start over once.
        if ((e instanceof UploadUrlExpired || (e instanceof ApiError && e.status === 404)) && attempt === 0) {
          delete state[rel];
          this.saveState(state);
          s = undefined;
          continue;
        }
        throw e;
      }
    }
  }
}
