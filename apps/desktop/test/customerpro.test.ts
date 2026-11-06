import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ApiError, CustomerProClient, NetworkError} from '../src/customerpro/client.js';
import {signInWithDeviceCode, SignInError} from '../src/customerpro/device-auth.js';
import {computeAccess} from '../src/customerpro/gating.js';
import {SyncManager, type SyncStatus} from '../src/customerpro/sync.js';
import {MediaUploader, UPLOAD_STATE} from '../src/customerpro/upload.js';
import {createProject, readLink} from '../src/engine/projects.js';
import {createMockServer} from './mock/customerpro-mock.js';
import {tmpDir} from './helpers.js';

const fast = () => Promise.resolve();
let mock: Awaited<ReturnType<typeof createMockServer>>;
afterEach(async () => { await mock?.close(); });

const signedIn = async (opts: Parameters<typeof createMockServer>[0] = {}) => {
  mock = await createMockServer(opts);
  let token: string | undefined;
  let unauthorized = 0;
  const client = new CustomerProClient({baseUrl: mock.url, getToken: () => token, onUnauthorized: () => { unauthorized++; token = undefined; }});
  const t = await signInWithDeviceCode(client, {deviceName: 'Test Mac', platform: 'mac', appVersion: '0.1.0', sleep: fast, onCode: (s) => mock.approve(s.user_code)});
  token = t.token;
  return {client, unauthorized: () => unauthorized, token: () => token};
};

describe('device sign-in (D5)', () => {
  it('polls through authorization_pending until approved', async () => {
    mock = await createMockServer();
    const client = new CustomerProClient({baseUrl: mock.url});
    let code = '';
    let polls = 0;
    const r = await signInWithDeviceCode(client, {deviceName: 'Mac', platform: 'mac', appVersion: '0.1.0', onCode: (s) => { code = s.user_code; expect(s.verification_url).toContain(`/desktop/link?code=${s.user_code}`); },
      sleep: async () => { if (++polls === 3) mock.approve(code); }});
    expect(code).toMatch(/^[0-9A-F]{4}-\d{4}$/);
    expect(polls).toBe(3);
    expect(r.workspace.name).toBe('KK Park');
    expect(r.token).toContain('|');
  });
  it('reports denial and cancellation', async () => {
    mock = await createMockServer();
    const client = new CustomerProClient({baseUrl: mock.url});
    await expect(signInWithDeviceCode(client, {deviceName: 'Mac', platform: 'mac', appVersion: '0', sleep: fast, onCode: (s) => mock.deny(s.user_code)})).rejects.toMatchObject({code: 'denied'});
    const ac = new AbortController();
    const p = signInWithDeviceCode(client, {deviceName: 'Mac', platform: 'mac', appVersion: '0', signal: ac.signal, onCode: () => ac.abort()});
    await expect(p).rejects.toBeInstanceOf(SignInError);
  });
  it('maps network failure to NetworkError', async () => {
    const client = new CustomerProClient({baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000});
    await expect(client.deviceStart({device_name: 'x', platform: 'mac', app_version: '0'})).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('GET /me gating', () => {
  it('maps plan and permissions to access modes', async () => {
    const {client} = await signedIn();
    const me = await client.me();
    expect(computeAccess(me, '0.1.0')).toMatchObject({mode: 'full', canEdit: true, canExport: true, canSync: true});
    mock.state.me.installed = false;
    expect(computeAccess(await client.me(), '0.1.0').mode).toBe('upgrade');
    mock.state.me.installed = true;
    mock.state.me.permissions = {view: true, edit: false, export: false};
    expect(computeAccess(await client.me(), '0.1.0')).toMatchObject({mode: 'read-only', canEdit: false, canExport: false, canSync: true});
    mock.state.me.permissions = {view: true, edit: true, export: false};
    expect(computeAccess(await client.me(), '0.1.0')).toMatchObject({mode: 'full', canExport: false});
    mock.state.me.min_version = '0.2.0';
    expect(computeAccess(await client.me(), '0.1.0')).toMatchObject({mode: 'update-required', canSync: false, canEdit: true});
    expect(computeAccess(undefined, '0.1.0').mode).toBe('signed-out');
  });
  it('a revoked device signs out on the next call', async () => {
    const ctx = await signedIn();
    mock.revokeAll();
    await expect(ctx.client.me()).rejects.toMatchObject({status: 401, code: 'invalid_token'});
    expect(ctx.unauthorized()).toBe(1);
    expect(ctx.token()).toBeUndefined();
  });
  it('logout revokes the token', async () => {
    const ctx = await signedIn();
    await ctx.client.logout();
    await expect(ctx.client.me()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('project sync (D9)', () => {
  const setup = async () => {
    const ctx = await signedIn({});
    const statuses: SyncStatus[] = [];
    const sync = new SyncManager({client: ctx.client, canSync: () => true, debounceMs: 30, retryMs: 50, onStatus: (_d, s) => statuses.push(s)});
    const dir = createProject({name: 'Synced', root: tmpDir('sync')});
    return {...ctx, sync, dir, statuses};
  };
  const edit = (dir: string, fn: (p: any) => void) => {
    const f = path.join(dir, 'project.json');
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    fn(p);
    fs.writeFileSync(f, JSON.stringify(p, null, 2));
  };

  it('links (creates remote), pushes on save debounced, pulls web edits on open', async () => {
    const {sync, dir} = await setup();
    const s = await sync.link(dir, {orgId: 3});
    expect(s).toMatchObject({state: 'synced', rev: 2});
    const link = readLink(dir)!;
    const remote = mock.state.projects.get(Number(link.projectId))!;
    expect(remote.last_edited_on).toBe('desktop');

    edit(dir, (p) => { p.comps[0].layers.push({id: 't1', type: 'text', text: 'Hello'}); });
    edit(dir, (p) => { p.comps[0].layers[0].text = 'Hello again'; });
    sync.schedulePush(dir);
    sync.schedulePush(dir);
    await new Promise((r) => setTimeout(r, 150));
    await sync.push(dir); // waits for the queue
    expect(mock.state.log.filter((l) => l.method === 'PUT' && l.path.endsWith(`/projects/${link.projectId}`))).toHaveLength(2); // link + one debounced push
    expect(remote.project.comps[0].layers[0].text).toBe('Hello again');
    expect(readLink(dir)!.rev).toBe(3);

    // A teammate edits on the web while the app is closed → opening loads theirs.
    mock.webEdit(Number(link.projectId), (p) => { p.comps[0].layers[0].text = 'From the web'; });
    expect(await sync.pull(dir)).toMatchObject({state: 'synced', rev: 4});
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).comps[0].layers[0].text).toBe('From the web');
    // Nothing changed anywhere → no write.
    expect(await sync.pull(dir)).toMatchObject({state: 'synced', rev: 4});
  });

  it('409 → conflict; keep mine as a copy, then load theirs', async () => {
    const {sync, dir} = await setup();
    await sync.link(dir, {orgId: 3});
    const id = Number(readLink(dir)!.projectId);
    mock.webEdit(id, (p) => { p.name = 'Web name'; });
    edit(dir, (p) => { p.comps[0].background = '#ff0000'; });
    expect(await sync.push(dir)).toMatchObject({state: 'conflict', localRev: 2, remoteRev: 3});
    expect(await sync.pull(dir)).toMatchObject({state: 'conflict'});
    const {copy} = await sync.resolveConflict(dir, 'keep-mine');
    expect(copy).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(copy!, 'project.json'), 'utf8')).comps[0].background).toBe('#ff0000');
    expect(fs.existsSync(path.join(copy!, '.customerpro.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).name).toBe('Web name');
    expect(readLink(dir)!.rev).toBe(3);
  });

  it('links to an existing web project, refuses absolute sources, and queues while offline', async () => {
    const {sync, dir, client} = await setup();
    const created = await client.createProject({name: 'Made on web', preset: 'square'});
    await sync.link(dir, {orgId: 3, projectId: created.id});
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).comps[0].width).toBe(1080);
    edit(dir, (p) => { p.comps[0].layers.push({id: 'v', type: 'video', src: '/Users/me/raw/DJI_1.MP4'}); });
    expect(await sync.push(dir)).toMatchObject({state: 'error'});
    edit(dir, (p) => { p.comps[0].layers[0].src = 'media/DJI_1.mp4'; });
    await mock.close();
    expect(await sync.push(dir)).toMatchObject({state: 'offline'});
    sync.dispose();
  });

  it('blocked when access does not allow sync', async () => {
    const ctx = await signedIn();
    const sync = new SyncManager({client: ctx.client, canSync: () => false, blockedReason: () => 'Update to continue'});
    const dir = createProject({name: 'B', root: tmpDir('sync')});
    await new SyncManager({client: ctx.client, canSync: () => true}).link(dir, {orgId: 3});
    expect(await sync.push(dir)).toMatchObject({state: 'blocked', message: 'Update to continue'});
  });
});

describe('media upload (task 3.7)', () => {
  const linked = async (opts: Parameters<typeof createMockServer>[0]) => {
    const ctx = await signedIn(opts);
    const dir = createProject({name: 'Up', root: tmpDir('up')});
    await new SyncManager({client: ctx.client, canSync: () => true}).link(dir, {orgId: 3});
    return {...ctx, dir, id: Number(readLink(dir)!.projectId)};
  };

  it('uploads small files with a single PUT and skips them next time', async () => {
    const {client, dir, id} = await linked({});
    fs.writeFileSync(path.join(dir, 'media', 'logo.png'), crypto.randomBytes(5000));
    fs.writeFileSync(path.join(dir, 'vo', 'line1.wav'), crypto.randomBytes(3000));
    fs.mkdirSync(path.join(dir, '.cache'), {recursive: true});
    fs.writeFileSync(path.join(dir, '.cache', 'x.png'), 'not uploaded');
    const up = new MediaUploader(client, dir);
    expect(up.pending()).toEqual(['media/logo.png', 'vo/line1.wav']);
    const r = await up.uploadAll();
    expect(r.every((x) => x.url)).toBe(true);
    expect(mock.state.objects.get(`3/video/${id}/media/logo.png`)?.length).toBe(5000);
    expect(up.pending()).toEqual([]);
    expect(readLink(dir)!.uploaded!['vo/line1.wav'].url).toContain('/vo/line1.wav');
  });

  it('multipart upload resumes after a failed part without re-sending finished parts', async () => {
    const {client, dir, id} = await linked({singleMaxBytes: 1000, partSize: 64 * 1024});
    const data = crypto.randomBytes(300 * 1024 + 123); // 5 parts
    fs.writeFileSync(path.join(dir, 'media', 'shot1.mp4'), data);
    const up = new MediaUploader(client, dir);
    mock.state.faults.failNextPartPut = 0;
    // Fail the 3rd part: let 2 parts through first.
    let puts = 0;
    const origLog = mock.state.log.push.bind(mock.state.log);
    mock.state.log.push = (...e) => { if (e[0].method === 'PUT' && e[0].path.startsWith('/upload/') && ++puts === 2) mock.state.faults.failNextPartPut = 1; return origLog(...e); };
    await expect(up.uploadFile('media/shot1.mp4')).rejects.toThrow();
    const state = JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_STATE), 'utf8'))['media/shot1.mp4'];
    expect(state.parts.filter((p: {etag?: string}) => p.etag)).toHaveLength(2);
    const before = puts;
    const progress: number[] = [];
    const url = await up.uploadFile('media/shot1.mp4', {onProgress: (s) => progress.push(s)});
    expect(puts - before).toBe(3); // only the remaining parts
    expect(url).toContain('media/shot1.mp4');
    expect(Buffer.compare(mock.state.objects.get(`3/video/${id}/media/shot1.mp4`)!, data)).toBe(0);
    expect(progress.at(-1)).toBe(data.length);
    expect(fs.existsSync(path.join(dir, UPLOAD_STATE)) && JSON.parse(fs.readFileSync(path.join(dir, UPLOAD_STATE), 'utf8'))['media/shot1.mp4']).toBeFalsy();
  });

  it('restarts once when a presigned URL has expired', async () => {
    const {client, dir} = await linked({});
    fs.writeFileSync(path.join(dir, 'music', 'track.mp3'), crypto.randomBytes(2000));
    mock.state.faults.expireNextPut = 1;
    expect(await new MediaUploader(client, dir).uploadFile('music/track.mp3')).toContain('music/track.mp3');
  });
});
