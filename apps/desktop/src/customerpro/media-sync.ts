// Project media from CustomerPro (D9, app side of task 3.8): "Open in desktop app" on a project that isn't on
// this computer creates the folder, pulls project.json (rev compare-and-set via SyncManager.link) and downloads
// the prepared media the web has (GET projects/{id}/media). Also the re-sign call for multipart uploads whose
// part URLs expired (POST media/resign), used by MediaUploader to resume instead of restarting.
import fs from 'node:fs';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createProject, findLinkedProject, projectFile, readJson, readLink, RELATIVE_SRC, safeFolderName, writeLink} from '../engine/projects.js';
import type {CustomerProClient} from './client.js';
import type {SyncManager} from './sync.js';

export interface RemoteMedia { path: string; size: number; content_type: string; url: string; updated_at: string }

const pid = (id: number | string) => encodeURIComponent(String(id));

export const listRemoteMedia = async (client: CustomerProClient, projectId: number | string) =>
  (await client.request<{data: RemoteMedia[]}>('GET', `projects/${pid(projectId)}/media`)).data.data ?? [];

// Renews part URLs of an unfinished multipart upload. 404 → the upload is gone (caller starts over).
export const resignParts = async (client: CustomerProClient, projectId: number | string, p: {key: string; upload_id: string; parts: number[]}) =>
  (await client.request<{parts: {n: number; url: string}[]}>('POST', `projects/${pid(projectId)}/media/resign`, p)).data;

// media/…, vo/…, music/… only; never absolute, never "..".
export const safeMediaPath = (rel: string) => typeof rel === 'string' && RELATIVE_SRC.test(rel) && !rel.split('/').includes('..') && !rel.split('/').includes('.');

// GET to a file: streamed to <dest>.part, renamed when complete (an interrupted download never looks finished).
export const downloadTo = async (url: string, dest: string, o: {signal?: AbortSignal; onBytes?: (n: number) => void; fetch?: typeof fetch} = {}) => {
  const res = await (o.fetch ?? fetch)(url, {signal: o.signal, redirect: 'follow'});
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const part = `${dest}.part`;
  let n = 0;
  try {
    await pipeline(Readable.fromWeb(res.body as never), new Transform({transform(c, _e, cb) { n += c.length; o.onBytes?.(c.length); cb(null, c); }}), fs.createWriteStream(part), {signal: o.signal});
    fs.renameSync(part, dest);
  } catch (e) { fs.rmSync(part, {force: true}); throw e; }
  return n;
};

export interface DownloadProgress { path: string; received: number; size: number; fileIndex: number; files: number }
export interface DownloadReport { downloaded: string[]; present: number; failed: {path: string; error: string}[]; missing: string[] }

// Downloads media the web has and this folder lacks (or has at a different size). Files fetched are recorded as
// uploaded in .customerpro.json so "Upload media" doesn't send them back. `missing` lists relative sources in
// project.json found neither here nor on CustomerPro.
export const downloadMissingMedia = async (client: CustomerProClient, dir: string, o: {signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; fetch?: typeof fetch} = {}): Promise<DownloadReport> => {
  const link = readLink(dir);
  if (!link) throw new Error('Project is not linked to CustomerPro');
  const remote = (await listRemoteMedia(client, link.projectId)).filter((m) => safeMediaPath(m.path));
  const todo = remote.filter((m) => {
    const f = path.join(dir, ...m.path.split('/'));
    try { return fs.statSync(f).size !== m.size; } catch { return true; }
  });
  const report: DownloadReport = {downloaded: [], present: remote.length - todo.length, failed: [], missing: []};
  const uploaded: NonNullable<typeof link.uploaded> = {};
  for (const [i, m] of todo.entries()) {
    if (o.signal?.aborted) break;
    const dest = path.join(dir, ...m.path.split('/'));
    let received = 0;
    try {
      const n = await downloadTo(m.url, dest, {signal: o.signal, fetch: o.fetch, onBytes: (b) => { received += b; o.onProgress?.({path: m.path, received, size: m.size, fileIndex: i, files: todo.length}); }});
      if (m.size && n !== m.size) throw new Error(`size ${n} ≠ ${m.size}`);
      const st = fs.statSync(dest);
      uploaded[m.path] = {size: st.size, mtime: st.mtimeMs, url: m.url.split('?')[0]};
      report.downloaded.push(m.path);
    } catch (e) {
      fs.rmSync(dest, {force: true});
      report.failed.push({path: m.path, error: (e as Error).message});
    }
  }
  if (Object.keys(uploaded).length) {
    const l = readLink(dir)!;
    writeLink(dir, {...l, uploaded: {...(l.uploaded ?? {}), ...uploaded}});
  }
  const project = readJson<{comps?: {layers?: {src?: unknown}[]}[]}>(projectFile(dir), {});
  const refs = new Set<string>();
  for (const c of project.comps ?? []) for (const l of c.layers ?? []) if (typeof l.src === 'string' && safeMediaPath(l.src)) refs.add(l.src);
  report.missing = [...refs].filter((r) => !fs.existsSync(path.join(dir, ...r.split('/')))).sort();
  return report;
};

// customerpro-video://open?project=ID: the local folder linked to that project, or a new one pulled from the
// web; then its missing media. Returns the folder to open.
export const openRemoteProject = async (d: {
  client: CustomerProClient; sync: SyncManager; projectId: string | number; orgId: string | number;
  root: string; extra?: string[]; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; fetch?: typeof fetch;
}) => {
  let dir = findLinkedProject(d.projectId, {root: d.root, extra: d.extra})?.dir;
  let created = false;
  if (!dir) {
    const remote = await d.client.getProject(d.projectId);
    dir = createProject({name: safeFolderName(remote.name || `Project ${remote.id}`), root: d.root});
    try {
      await d.sync.link(dir, {projectId: remote.id, orgId: d.orgId});
    } catch (e) { fs.rmSync(dir, {recursive: true, force: true}); throw e; }
    created = true;
  }
  // The project opens even when media can't be fetched (offline, older server); Studio shows what's missing.
  let media: DownloadReport | undefined, mediaError: string | undefined;
  try { media = await downloadMissingMedia(d.client, dir, {signal: d.signal, onProgress: d.onProgress, fetch: d.fetch}); } catch (e) { mediaError = (e as Error).message; }
  return {dir, created, media, mediaError};
};
