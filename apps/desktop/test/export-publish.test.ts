// Final export, publish, open-from-web and resumable uploads (tasks 5.2, 5.3, 3.8) against the mock CustomerPro.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {CustomerProClient} from '../src/customerpro/client.js';
import {signInWithDeviceCode} from '../src/customerpro/device-auth.js';
import {downloadMissingMedia, openRemoteProject} from '../src/customerpro/media-sync.js';
import {ExportRequired, InsufficientCredits, predictExport, publishExport, requestExport, webLinks} from '../src/customerpro/publish.js';
import {SyncManager} from '../src/customerpro/sync.js';
import {MediaUploader, UPLOAD_STATE} from '../src/customerpro/upload.js';
import {startFinalExport, finalProject, planWhatsApp, WHATSAPP_MAX_BYTES} from '../src/engine/export-final.js';
import {configureFfmpeg} from '../src/engine/ffmpeg.js';
import {createProject, readLink} from '../src/engine/projects.js';
import type {ExportProgress, FinalExportResult} from '../src/shared/types.js';
import {createMockServer} from './mock/customerpro-mock.js';
import {ffprobeJson, makeClip, tmpDir} from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childScript = path.join(root, 'dist/engine/render-child.js');
let mock: Awaited<ReturnType<typeof createMockServer>>;
afterEach(async () => { await mock?.close(); });

const signedIn = async (opts: Parameters<typeof createMockServer>[0] = {}) => {
  mock = await createMockServer(opts);
  let token: string | undefined;
  const client = new CustomerProClient({baseUrl: mock.url, getToken: () => token});
  token = (await signInWithDeviceCode(client, {deviceName: 'Test', platform: 'mac', appVersion: '0.1.0', sleep: () => Promise.resolve(), onCode: (s) => mock.approve(s.user_code)})).token;
  const sync = new SyncManager({client, canSync: () => true});
  return {client, sync};
};
const linkedProject = async (ctx: {client: CustomerProClient; sync: SyncManager}, name = 'Export') => {
  const dir = createProject({name, root: tmpDir('exp')});
  await ctx.sync.link(dir, {orgId: 3});
  return {dir, id: Number(readLink(dir)!.projectId)};
};

describe('export grant (D12)', () => {
  it('within the allowance: free, counts a video; re-export within 7 days is free and does not count', async () => {
    const ctx = await signedIn();
    const {id} = await linkedProject(ctx);
    const me = await ctx.client.me();
    expect(predictExport(me)).toMatchObject({kind: 'free', allowance: {used: 3, videos_per_month: 20}});
    const g = await requestExport(ctx.client, {projectId: id, duration: 12.5, preset: 'reel'});
    expect(g).toMatchObject({kind: 'free', charged_credits: 0, allowance: {used: 4, videos_per_month: 20}});
    expect(Date.parse(g.free_reexport_until!)).toBeGreaterThan(Date.now() + 6 * 864e5);
    expect(predictExport(await ctx.client.me(), {freeReexportUntil: g.free_reexport_until}).kind).toBe('reexport');
    const again = await requestExport(ctx.client, {projectId: id, duration: 12.5, preset: 'square'});
    expect(again).toMatchObject({kind: 'reexport', charged_credits: 0, allowance: {used: 4}});
  });

  it('allowance used up: paid in credits; the confirm dialog knows the price from the last answer', async () => {
    const ctx = await signedIn();
    const {id} = await linkedProject(ctx);
    Object.assign(mock.state.account, {used: 20, balance: 120, priceCredits: 50});
    const q = predictExport(await ctx.client.me(), {lastPrice: 50});
    expect(q).toMatchObject({kind: 'paid', priceCredits: 50, balance: 120});
    expect(predictExport(await ctx.client.me()).priceCredits).toBeUndefined();
    const g = await requestExport(ctx.client, {projectId: id, duration: 60, preset: 'reel'});
    expect(g).toMatchObject({kind: 'paid', charged_credits: 50});
    expect((await ctx.client.me()).credits.balance).toBe(70);
  });

  it('402 insufficient_credits carries the price; nothing is charged', async () => {
    const ctx = await signedIn();
    const {id} = await linkedProject(ctx);
    Object.assign(mock.state.account, {used: 20, balance: 30, priceCredits: 50});
    const err = await requestExport(ctx.client, {projectId: id, duration: 60, preset: 'reel'}).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCredits);
    expect(err.price).toBe(50);
    expect(mock.state.account.balance).toBe(30);
    expect(mock.state.exports.size).toBe(0);
  });
});

describe('final export render (task 5.2)', () => {
  let dir: string;
  beforeAll(() => {
    configureFfmpeg(path.join(root, 'resources')); // the bundled LGPL build when present (hardware H.264 encoder)
    dir = createProject({name: 'Final', root: tmpDir('final'), project: {dtly: 1, name: 'Final', root: 'main', comps: [{id: 'main', width: 1080, height: 1920, fps: 30, duration: 3, background: '#203040', layers: [
      {id: 'title', type: 'text', text: 'Final export', size: 120, color: '#fff', transform: {position: [540, 400], rotation: {keyframes: [{t: 0, v: 0}, {t: 3, v: 20}]}}},
      {id: 'clip', type: 'video', src: 'media/clip.mp4', fit: 'cover', size: [1920, 1080], volume: 1, inPoint: 0, outPoint: 3, transform: {position: [540, 1200], scale: [56.25, 56.25]}},
    ]}]}});
    makeClip(path.join(dir, 'media', 'clip.mp4'), {dur: 3});
  });
  const run = (o: Partial<Parameters<typeof startFinalExport>[1]>) => {
    const events: ExportProgress[] = [];
    const job = startFinalExport(dir, {preset: 'reel', childScript, onProgress: (e) => events.push(e), ...o});
    return {job, events};
  };

  it('plans WhatsApp bitrates: 60 s fits 16 MB at 720p, short clips keep 1080p', () => {
    const long = planWhatsApp(60, 1080, 1920);
    expect(long).toMatchObject({width: 720, height: 1280});
    expect(((long.videoBitrate + long.audioBitrate) * 60) / 8).toBeLessThan(WHATSAPP_MAX_BYTES * 0.92);
    expect(planWhatsApp(10, 1080, 1920)).toMatchObject({width: 1080, height: 1920});
    expect(() => planWhatsApp(3600, 1080, 1920)).toThrow(/can't fit/);
    expect(finalProject({root: 'm', comps: [{id: 'm', width: 1080, height: 1920, duration: 2, fps: 30, layers: []}]}, 'landscape')).toMatchObject({width: 1920, height: 1080, project: {root: '__cpv_final'}});
  });

  it('renders 1080×1920 H.264 ~8 Mbps + AAC without watermark, and a WhatsApp copy under 16 MB, with progress and time left', async () => {
    const {job, events} = run({whatsapp: true});
    const r = await job.done;
    expect(r.phase, r.error).toBe('finished');
    const res = r.result as FinalExportResult;
    const v = ffprobeJson(res.main.file);
    const vs = v.streams.find((s) => s.codec_type === 'video')!;
    const as = v.streams.find((s) => s.codec_type === 'audio')!;
    expect([vs.codec_name, vs.width, vs.height]).toEqual(['h264', 1080, 1920]);
    expect(as.codec_name).toBe('aac');
    expect(Number(as.bit_rate)).toBeGreaterThan(150_000);
    expect(res.main.bitrate).toBeGreaterThan(4_000_000);
    expect(res.main.bitrate).toBeLessThan(11_500_000);
    expect(res.whatsapp!.size).toBeLessThan(16_000_000);
    expect(fs.existsSync(res.whatsapp!.file)).toBe(true);
    expect(events.some((e) => e.phase === 'render' && e.etaSeconds !== undefined && (e.fraction ?? 0) > 0)).toBe(true);
    expect(events.map((e) => e.stage)).toContain('encode');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.final-'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'renders')).filter((f) => f.includes('master'))).toEqual([]);
  });

  it('re-encodes the WhatsApp copy to fit a limit (720p when the bitrate is low), and fits other presets', async () => {
    const {job} = run({preset: 'landscape', whatsapp: true, whatsappMaxBytes: 400_000});
    const r = await job.done;
    expect(r.phase, r.error).toBe('finished');
    const res = r.result!;
    expect([res.main.width, res.main.height]).toEqual([1920, 1080]);
    expect(res.main.size).toBeGreaterThan(400_000); // so the copy really is re-encoded
    expect(res.whatsapp!.size).toBeLessThanOrEqual(400_000);
    expect([res.whatsapp!.width, res.whatsapp!.height]).toEqual([1280, 720]);
    expect(ffprobeJson(res.whatsapp!.file).streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
  });

  it('cancels and leaves no files', async () => {
    const {job} = run({whatsapp: true});
    setTimeout(() => job.cancel(), 300);
    const r = await job.done;
    expect(r.phase).toBe('cancelled');
    expect(fs.existsSync(job.out)).toBe(false);
  });
});

describe('publish (task 5.3)', () => {
  const fakeRender = (dir: string, name: string, size: number) => {
    const f = path.join(dir, 'renders', name);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    fs.writeFileSync(f, crypto.randomBytes(size));
    return {file: f, size, width: 1080, height: 1920, duration: 12, bitrate: 8e6};
  };

  it('uploads main then the WhatsApp variant, retrying a dropped connection, and links to the web composers', async () => {
    const ctx = await signedIn();
    const {dir, id} = await linkedProject(ctx);
    const g = await requestExport(ctx.client, {projectId: id, duration: 12, preset: 'reel'});
    const main = fakeRender(dir, 'main.mp4', 300_000), wa = fakeRender(dir, 'main-whatsapp.mp4', 90_000);
    mock.state.faults.failNextPut = 1;
    const progress: {variant: string; sent: number; attempt: number}[] = [];
    const sleeps: number[] = [];
    const r = await publishExport(ctx.client, {main, whatsapp: wa}, {projectId: id, exportId: g.export_id, maxBytes: 150e6, sleep: async (ms) => { sleeps.push(ms); }, onProgress: (p) => progress.push(p)});
    expect(r.whatsappError).toBeUndefined();
    expect(mock.state.renders.map((x) => [x.variant, x.size])).toEqual([['main', 300_000], ['whatsapp', 90_000]]);
    expect(r.main.media_asset_id).toBe(mock.state.renders[0].media_asset_id);
    expect(sleeps).toHaveLength(1);
    expect(progress.some((p) => p.attempt === 2 && p.sent === 300_000)).toBe(true);
    const links = webLinks(mock.url, r.main);
    expect(links.post).toBe(`${mock.url}/social/posts/create?media_asset=${r.main.media_asset_id}`);
    expect(links.whatsapp).toContain('/campaigns/create');
    expect(links.mediaLibrary).toBe(`${mock.url}/media-library?type=video`);
  });

  it('re-presigns an expired upload URL; refuses an expired export; respects the size limit', async () => {
    const ctx = await signedIn();
    const {dir, id} = await linkedProject(ctx);
    const g = await requestExport(ctx.client, {projectId: id, duration: 12, preset: 'reel'});
    const main = fakeRender(dir, 'v.mp4', 50_000);
    mock.state.faults.expireNextPut = 1;
    await publishExport(ctx.client, {main}, {projectId: id, exportId: g.export_id, sleep: async () => undefined});
    expect(mock.state.log.filter((l) => l.path.endsWith('/renders/presign'))).toHaveLength(2);
    await expect(publishExport(ctx.client, {main}, {projectId: id, exportId: g.export_id, maxBytes: 10_000})).rejects.toThrow(/accepts up to/);
    mock.expireExport(Number(g.export_id));
    await expect(publishExport(ctx.client, {main}, {projectId: id, exportId: g.export_id})).rejects.toBeInstanceOf(ExportRequired);
  });
});

describe('resumable media upload with re-sign (contracts: media/resign)', () => {
  it('a resume after the part URLs expired renews them instead of restarting', async () => {
    const ctx = await signedIn({singleMaxBytes: 1000, partSize: 64 * 1024});
    const {dir, id} = await linkedProject(ctx, 'Resign');
    const data = crypto.randomBytes(300 * 1024 + 7); // 5 parts
    fs.writeFileSync(path.join(dir, 'media', 'shot.mp4'), data);
    const up = new MediaUploader(ctx.client, dir);
    let puts = 0;
    const push = mock.state.log.push.bind(mock.state.log);
    mock.state.log.push = (...e) => { if (e[0].method === 'PUT' && e[0].status === 200 && ++puts === 2) mock.state.faults.failNextPartPut = 1; return push(...e); };
    await expect(up.uploadFile('media/shot.mp4')).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_STATE), 'utf8'))['media/shot.mp4'].parts.filter((p: {etag?: string}) => p.etag)).toHaveLength(2);
    mock.expireUploadUrls(); // hours later: every URL handed out so far is dead
    const presigns = () => mock.state.log.filter((l) => l.path.endsWith('/media/presign')).length;
    const before = presigns();
    expect(await up.uploadFile('media/shot.mp4')).toContain('media/shot.mp4');
    expect(presigns()).toBe(before); // not restarted
    expect(mock.state.log.filter((l) => l.path.endsWith('/media/resign') && l.status === 200)).toHaveLength(1);
    expect(puts).toBe(5); // 2 before + the 3 remaining parts
    expect(Buffer.compare(mock.state.objects.get(`3/video/${id}/media/shot.mp4`)!, data)).toBe(0);
  });
});

describe('open from web (task 3.8 app side, D9)', () => {
  it('creates the folder, pulls project.json, downloads the missing media; a second open fetches nothing', async () => {
    const ctx = await signedIn();
    const remote = await ctx.client.createProject({name: 'Made on the web', preset: 'reel'});
    const id = Number(remote.id);
    const a = crypto.randomBytes(40_000), b = crypto.randomBytes(1234);
    mock.seedMedia(id, 'media/board.mp4', a);
    mock.seedMedia(id, 'vo/line1.wav', b);
    mock.webEdit(id, (p) => { p.comps[0].layers.push({id: 'v', type: 'video', src: 'media/board.mp4'}, {id: 'gone', type: 'video', src: 'media/missing.mp4'}); });
    const rootDir = tmpDir('web');
    const progress: number[] = [];
    const r = await openRemoteProject({client: ctx.client, sync: ctx.sync, projectId: id, orgId: 3, root: rootDir, onProgress: (p) => progress.push(p.received)});
    expect(r.created).toBe(true);
    expect(path.basename(r.dir)).toBe('Made on the web');
    expect(readLink(r.dir)).toMatchObject({projectId: id, rev: 2});
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'project.json'), 'utf8')).comps[0].layers[0].src).toBe('media/board.mp4');
    expect(Buffer.compare(fs.readFileSync(path.join(r.dir, 'media/board.mp4')), a)).toBe(0);
    expect(fs.readFileSync(path.join(r.dir, 'vo/line1.wav')).length).toBe(1234);
    expect(r.media).toMatchObject({downloaded: ['media/board.mp4', 'vo/line1.wav'], failed: [], missing: ['media/missing.mp4']});
    expect(progress.at(-1)).toBeGreaterThan(0);
    // Downloaded files count as uploaded: "Upload media" won't send them back.
    expect(new MediaUploader(ctx.client, r.dir).pending()).toEqual([]);

    const again = await openRemoteProject({client: ctx.client, sync: ctx.sync, projectId: id, orgId: 3, root: rootDir});
    expect(again).toMatchObject({dir: r.dir, created: false, media: {downloaded: [], present: 2}});
    fs.rmSync(path.join(r.dir, 'vo/line1.wav'));
    expect((await downloadMissingMedia(ctx.client, r.dir)).downloaded).toEqual(['vo/line1.wav']);
  });
});
