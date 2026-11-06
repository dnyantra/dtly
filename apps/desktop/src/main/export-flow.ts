// Final export + publish in the main process (D12, tasks 5.2/5.3): quote for the confirm dialog, the grant
// (POST exports), the engine render, then the upload to the project's renders and the Media Library.
import fs from 'node:fs';
import {readLink, readJson, projectFile} from '../engine/projects.js';
import {InsufficientCredits, predictExport, publishExport, readExports, requestExport, updateExports, webLinks} from '../customerpro/publish.js';
import type {SyncManager} from '../customerpro/sync.js';
import type {Events} from '../shared/bridge.js';
import type {ExportQuoteResult, FinalStartResult, PublishEvent} from '../shared/publish.js';
import type {ExportProgress, FinalPreset} from '../shared/types.js';
import type {AccountManager} from './account.js';
import type {EngineHost} from './engine-host.js';
import {log} from './logger.js';
import type {SettingsStore} from './settings.js';

interface Deps {
  engine: EngineHost;
  account: AccountManager;
  sync: SyncManager;
  settings: SettingsStore;
  send: (e: 'publish', d: PublishEvent) => void;
}

const rootOf = (dir: string) => {
  const p = readJson<{root?: string; comps?: {id: string; width: number; height: number; duration: number}[]}>(projectFile(dir), {});
  const r = p.comps?.find((c) => c.id === p.root);
  if (!r) throw new Error('Project has no root composition');
  return r;
};
const presetFor = (w: number, h: number): FinalPreset => (w === 1080 && h === 1920 ? 'reel' : w === 1080 && h === 1080 ? 'square' : w === 1920 && h === 1080 ? 'landscape' : h > w ? 'reel' : w === h ? 'square' : w / h > 1.5 ? 'landscape' : 'project');

export class FinalExportFlow {
  private jobs = new Map<string, {dir: string; exportId: number | string; autoPublish: boolean}>();
  private uploads = new Map<string, AbortController>();

  constructor(private d: Deps) {
    d.engine.onEvent('export', (e) => this.onExport(e));
  }

  async quote(dir: string): Promise<ExportQuoteResult> {
    const acc = this.d.account.access();
    let state = this.d.account.state();
    if (acc.canExport) { try { state = await this.d.account.refresh(); } catch { /* offline: the last /me */ } }
    const me = state.me;
    const root = rootOf(dir);
    const ex = readExports(dir);
    const last = [...ex.exports].reverse().find((r) => r.main && fs.existsSync(r.main.file));
    const q = me ? predictExport(me, {freeReexportUntil: ex.freeReexportUntil, lastPrice: this.d.settings.get().lastExportPrice})
      : {kind: 'paid' as const, balance: 0, allowance: {used: 0, videos_per_month: 0, resets_at: null}};
    const canExport = state.access.canExport && state.online !== false;
    return {
      ...q,
      canExport,
      reason: !state.access.canExport ? (state.access.reason ?? 'Your role cannot export final videos in this workspace') : state.online === false ? 'Final export needs a connection to CustomerPro (preview export works offline)' : undefined,
      duration: root.duration, width: root.width, height: root.height, defaultPreset: presetFor(root.width, root.height),
      linked: !!readLink(dir), canLink: state.access.canEdit,
      last: last && {exportId: last.export_id, at: last.at, preset: last.preset, main: last.main, whatsapp: last.whatsapp,
        published: last.published?.main ? {main: last.published.main, whatsapp: last.published.whatsapp, links: webLinks(state.baseUrl, last.published.main)} : undefined},
      baseUrl: state.baseUrl,
    };
  }

  async start(dir: string, o: {preset: FinalPreset; whatsapp: boolean; autoPublish: boolean}): Promise<FinalStartResult> {
    const acc = this.d.account.access();
    if (!acc.canExport) throw new Error(acc.reason ?? 'Your role cannot export final videos in this workspace');
    const state = this.d.account.state();
    // The grant is per CustomerPro project: link first (creates it on the web) or bring the web copy up to date.
    if (!readLink(dir)) {
      if (!acc.canEdit) throw new Error('Link this project to CustomerPro first (needs Video edit access)');
      const s = await this.d.sync.link(dir, {orgId: state.me?.workspace.id ?? ''});
      if (s.state === 'error' || s.state === 'blocked') throw new Error(`Could not link the project: ${s.message}`);
    } else if (acc.canEdit) {
      await this.d.sync.push(dir).catch(() => undefined);
    }
    const link = readLink(dir)!;
    const duration = rootOf(dir).duration;
    let grant;
    try {
      grant = await requestExport(this.d.account.client, {projectId: link.projectId, duration, preset: o.preset});
    } catch (e) {
      if (e instanceof InsufficientCredits) {
        if (Number.isFinite(e.price)) this.d.settings.set({lastExportPrice: e.price});
        const me = (await this.d.account.refresh().catch(() => state)).me;
        return {ok: false, error: 'insufficient_credits', price: e.price, balance: me?.credits.balance ?? 0, buyUrl: `${state.baseUrl}/billing`};
      }
      throw e;
    }
    if (grant.charged_credits > 0) this.d.settings.set({lastExportPrice: grant.charged_credits});
    const at = new Date().toISOString();
    updateExports(dir, (f) => {
      f.freeReexportUntil = grant.free_reexport_until;
      f.exports.push({export_id: grant.export_id, grant: grant.grant, kind: grant.kind, charged_credits: grant.charged_credits, preset: o.preset, at});
    });
    log('info', `export grant ${grant.export_id} (${grant.kind ?? '?'}, ${grant.charged_credits} credits)`);
    void this.d.account.refresh().catch(() => undefined); // new balance / allowance
    const id = `final-${grant.export_id}-${Date.now().toString(36)}`;
    this.jobs.set(id, {dir, exportId: grant.export_id, autoPublish: o.autoPublish});
    try {
      const r = await this.d.engine.call('startFinalExport', {dir, preset: o.preset, whatsapp: o.whatsapp, id});
      return {ok: true, id: r.id, out: r.out, exportId: grant.export_id, kind: grant.kind, chargedCredits: grant.charged_credits, allowance: grant.allowance, freeReexportUntil: grant.free_reexport_until};
    } catch (e) { this.jobs.delete(id); throw e; }
  }

  private onExport(e: ExportProgress) {
    const job = this.jobs.get(e.id);
    if (!job || e.phase === 'render') return;
    this.jobs.delete(e.id);
    if (e.phase !== 'finished' || !e.result) return;
    const res = e.result;
    updateExports(job.dir, (f) => { const r = f.exports.find((x) => String(x.export_id) === String(job.exportId)); if (r) { r.main = res.main; r.whatsapp = res.whatsapp; } });
    if (job.autoPublish) void this.publish(job.dir, job.exportId).catch(() => undefined);
  }

  async publish(dir: string, exportId: number | string) {
    const acc = this.d.account.access();
    const fail = (error: string, code?: string) => { this.d.send('publish', {dir, exportId, phase: 'error', error, code}); return new Error(error); };
    if (!acc.canExport) throw fail(acc.reason ?? 'Your role cannot publish videos');
    const link = readLink(dir);
    const rec = readExports(dir).exports.find((x) => String(x.export_id) === String(exportId));
    if (!link || !rec?.main || !fs.existsSync(rec.main.file)) throw fail('The exported file is missing; export again');
    const key = String(exportId);
    this.uploads.get(key)?.abort();
    const ac = new AbortController();
    this.uploads.set(key, ac);
    const state = this.d.account.state();
    try {
      const r = await publishExport(this.d.account.client, {main: rec.main, whatsapp: rec.whatsapp && fs.existsSync(rec.whatsapp.file) ? rec.whatsapp : undefined}, {
        projectId: link.projectId, exportId, maxBytes: state.me?.limits?.max_render_bytes, signal: ac.signal,
        onProgress: (p) => this.d.send('publish', {dir, exportId, phase: 'uploading', ...p}),
      });
      updateExports(dir, (f) => { const x = f.exports.find((y) => String(y.export_id) === key); if (x) x.published = {main: r.main, whatsapp: r.whatsapp, at: new Date().toISOString()}; });
      const done = {main: r.main, whatsapp: r.whatsapp, whatsappError: r.whatsappError, links: webLinks(state.baseUrl, r.main)};
      log('info', `published export ${key} as media asset ${r.main.media_asset_id}${r.whatsapp ? ` (+ WhatsApp ${r.whatsapp.media_asset_id})` : ''}`);
      this.d.send('publish', {dir, exportId, phase: 'done', ...done});
      return done;
    } catch (e) {
      if (ac.signal.aborted) { this.d.send('publish', {dir, exportId, phase: 'cancelled'}); throw new Error('Cancelled'); }
      log('warn', `publish ${key} failed: ${(e as Error).message}`);
      throw fail((e as Error).message, (e as {code?: string}).code);
    } finally { if (this.uploads.get(key) === ac) this.uploads.delete(key); }
  }

  cancelPublish(exportId: number | string) { this.uploads.get(String(exportId))?.abort(); }
}

export type PublishSend = (e: 'publish', d: Events['publish']) => void;
