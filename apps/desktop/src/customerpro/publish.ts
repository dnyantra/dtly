// Final export grant and publish (D12, tasks 5.2/5.3; contracts.md §1 "Export and publish").
// POST exports → grant (allowance, 7-day re-export, or credits; 402 insufficient_credits with the price)
// → the engine renders → renders/presign (single PUT ≤ 150 MB, progress, retries) → POST renders (main, then
// the WhatsApp variant) → the video is in the Media Library.
import fs from 'node:fs';
import path from 'node:path';
import type {FinalPreset, Me, RenderedFile} from '../shared/types.js';
import {readJson, writeJsonAtomic} from '../engine/projects.js';
import {ApiError, NetworkError, type CustomerProClient, type Presign} from './client.js';
import {putRange, UploadUrlExpired} from './upload.js';

import type {ExportKind} from '../shared/publish.js';
export type {ExportKind};
export interface ExportGrant {
  grant: string;
  export_id: number | string;
  charged_credits: number;
  allowance: {used: number; videos_per_month: number};
  free_reexport_until: string | null;
  kind?: ExportKind;
}
export interface PublishedAsset { media_asset_id: number | string; url: string }

export class InsufficientCredits extends Error {
  readonly code = 'insufficient_credits';
  constructor(public price: number, public balance?: number) {
    super(`This export costs ${price} credits${balance !== undefined ? ` and the workspace has ${balance}` : ''}. Add credits on CustomerPro to continue.`);
    this.name = 'InsufficientCredits';
  }
}
export class ExportRequired extends Error {
  readonly code = 'export_required';
  constructor(msg = 'The export grant is missing or expired (7 days). Export again to publish.') { super(msg); this.name = 'ExportRequired'; }
}

const pid = (id: number | string) => encodeURIComponent(String(id));
const asId = (id: number | string) => (/^\d+$/.test(String(id)) ? Number(id) : id);

// ---- the per-project export record (.customerpro-exports.json): grants, files, what was published ----------
export const EXPORTS_FILE = '.customerpro-exports.json';
export interface ExportRecord {
  export_id: number | string; grant: string; kind?: ExportKind; charged_credits: number; preset: FinalPreset; at: string;
  main?: RenderedFile; whatsapp?: RenderedFile;
  published?: {main?: PublishedAsset; whatsapp?: PublishedAsset; at: string};
}
export interface ExportsFile { freeReexportUntil?: string | null; exports: ExportRecord[] }
export const readExports = (dir: string): ExportsFile => readJson<ExportsFile>(path.join(dir, EXPORTS_FILE), {exports: []});
export const updateExports = (dir: string, fn: (f: ExportsFile) => void) => {
  const f = readExports(dir);
  fn(f);
  f.exports = f.exports.slice(-20);
  writeJsonAtomic(path.join(dir, EXPORTS_FILE), f);
  return f;
};

// ---- what the confirm dialog shows (before any charge) ------------------------------------------------------
export interface ExportQuote {
  kind: ExportKind; // predicted; the server decides
  priceCredits?: number; // known when /me carries it or a previous answer told us
  balance: number;
  allowance: {used: number; videos_per_month: number; resets_at: string | null};
  freeReexportUntil?: string;
}
// /me may carry the per-video price (not in the contract yet); otherwise the last price the server told us.
export const exportPriceFromMe = (me: Me): number | undefined => {
  const v = (me as unknown as {video?: {export_price_credits?: unknown}; prices?: {video_export?: unknown}});
  const n = Number(v.video?.export_price_credits ?? v.prices?.video_export);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
export const predictExport = (me: Me, o: {freeReexportUntil?: string | null; lastPrice?: number; now?: number} = {}): ExportQuote => {
  const now = o.now ?? Date.now();
  const base = {balance: me.credits?.balance ?? 0, allowance: {used: me.allowance?.used ?? 0, videos_per_month: me.allowance?.videos_per_month ?? 0, resets_at: me.allowance?.resets_at ?? null}};
  if (o.freeReexportUntil && Date.parse(o.freeReexportUntil) > now) return {...base, kind: 'reexport', freeReexportUntil: o.freeReexportUntil};
  if (base.allowance.used < base.allowance.videos_per_month) return {...base, kind: 'free'};
  return {...base, kind: 'paid', priceCredits: exportPriceFromMe(me) ?? o.lastPrice};
};

// ---- API calls -------------------------------------------------------------------------------------------
export const requestExport = async (client: CustomerProClient, p: {projectId: number | string; duration: number; preset: FinalPreset}): Promise<ExportGrant> => {
  try {
    const r = await client.request<ExportGrant>('POST', 'exports', {project_id: asId(p.projectId), duration: Math.round(p.duration * 1000) / 1000, preset: p.preset});
    const g = r.data;
    return {...g, kind: g.kind ?? (Number(g.charged_credits) > 0 ? 'paid' : undefined)};
  } catch (e) {
    if (e instanceof ApiError && (e.status === 402 || e.code === 'insufficient_credits')) throw new InsufficientCredits(Number(e.body.price_credits ?? NaN));
    throw e;
  }
};

const isExportRequired = (e: unknown) => e instanceof ApiError && (e.code === 'export_required' || (e.status === 403 && /export/i.test(e.message)));

export interface PublishProgress { variant: 'main' | 'whatsapp'; sent: number; size: number; attempt: number }
export interface PublishOptions {
  projectId: number | string;
  exportId: number | string;
  maxBytes?: number; // me.limits.max_render_bytes
  signal?: AbortSignal;
  retries?: number; // per file, for dropped connections (default 4)
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (p: PublishProgress) => void;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One rendered file → renders/presign → single PUT (progress; retried on dropped connections, re-presigned when
// the URL expired) → POST renders.
export const publishRender = async (client: CustomerProClient, file: RenderedFile, variant: 'main' | 'whatsapp', o: PublishOptions): Promise<PublishedAsset> => {
  const size = fs.statSync(file.file).size;
  if (o.maxBytes && size > o.maxBytes) throw new Error(`The video is ${(size / 1e6).toFixed(0)} MB; CustomerPro accepts up to ${(o.maxBytes / 1e6).toFixed(0)} MB`);
  const filename = path.basename(file.file);
  const presign = async () => {
    try {
      const p = (await client.request<Presign>('POST', `projects/${pid(o.projectId)}/renders/presign`, {filename, content_type: 'video/mp4', size, export_id: asId(o.exportId)})).data;
      if (p.mode !== 'single') throw new Error('CustomerPro asked for a multipart render upload, which this version does not support');
      return p;
    } catch (e) { if (isExportRequired(e)) throw new ExportRequired(); throw e; }
  };
  let target = await presign();
  const retries = o.retries ?? 4;
  for (let attempt = 1; ; attempt++) {
    let sent = 0;
    o.onProgress?.({variant, sent, size, attempt});
    try {
      await putRange(target.url, file.file, 0, size, {contentType: 'video/mp4', signal: o.signal, onBytes: (n) => { sent += n; o.onProgress?.({variant, sent, size, attempt}); }});
      break;
    } catch (e) {
      if (o.signal?.aborted) throw new Error('Cancelled');
      if (attempt > retries) throw e;
      if (e instanceof UploadUrlExpired) target = await presign();
      else await (o.sleep ?? sleepMs)(Math.min(30000, 1000 * 2 ** (attempt - 1)));
    }
  }
  try {
    return (await client.request<PublishedAsset>('POST', `projects/${pid(o.projectId)}/renders`, {
      key: target.key, filename, mime: 'video/mp4', duration: Math.round(file.duration * 1000) / 1000, width: file.width, height: file.height, export_id: asId(o.exportId), variant,
    })).data;
  } catch (e) { if (isExportRequired(e)) throw new ExportRequired(); throw e; }
};

// Main first, then the WhatsApp copy (free with the export). A WhatsApp failure doesn't undo the main one.
export const publishExport = async (client: CustomerProClient, files: {main: RenderedFile; whatsapp?: RenderedFile}, o: PublishOptions) => {
  const main = await publishRender(client, files.main, 'main', o);
  let whatsapp: PublishedAsset | undefined, whatsappError: string | undefined;
  if (files.whatsapp) {
    try { whatsapp = await publishRender(client, files.whatsapp, 'whatsapp', o); } catch (e) { if (o.signal?.aborted) throw e; whatsappError = (e as Error).message; }
  }
  return {main, whatsapp, whatsappError};
};

// ---- links into the CustomerPro web app (read from the CustomerPro routes) ----------------------------------
// The composers don't take a media id yet: they open, and the owner picks the video from the Media Library
// picker. `media_asset` is passed along for when they do. Fallback: the Media Library, filtered to videos.
export const webLinks = (baseUrl: string, asset?: PublishedAsset) => {
  const q = asset ? `?media_asset=${encodeURIComponent(String(asset.media_asset_id))}` : '';
  return {
    mediaLibrary: `${baseUrl}/media-library?type=video`,
    post: `${baseUrl}/social/posts/create${q}`, // routes/social.php social.posts.create
    whatsapp: `${baseUrl}/campaigns/create${q}`, // routes/messaging.php whatsapp.campaigns.create
  };
};

export const isOfflineError = (e: unknown) => e instanceof NetworkError;
