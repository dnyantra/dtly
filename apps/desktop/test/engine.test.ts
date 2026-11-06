import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createEngine} from '../src/engine/api.js';
import {configureFfmpeg} from '../src/engine/ffmpeg.js';
import {previewProject} from '../src/engine/preview.js';
import type {EngineEvents} from '../src/shared/engine-api.js';
import {ffprobeJson, makeClip, tmpDir} from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events: {event: keyof EngineEvents; data: any}[] = [];
let engine: ReturnType<typeof createEngine>;

beforeAll(() => {
  configureFfmpeg();
  engine = createEngine({childScript: path.join(root, 'dist/engine/render-child.js'), projectsRoot: tmpDir('eng'), emit: (event, data) => events.push({event, data})});
});
afterAll(() => engine.shutdown());

const waitFor = async <T>(fn: () => T | undefined, ms = 60000) => {
  const until = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
};

const titleProject = (duration: number) => ({dtly: 1, name: 'T', root: 'main', comps: [{id: 'main', width: 1080, height: 1920, fps: 30, duration, background: '#223344', layers: [
  {id: 'title', type: 'text', text: 'Hello', size: 120, color: '#fff', transform: {position: [540, 960], rotation: {keyframes: [{t: 0, v: 0}, {t: duration, v: 90}]}}},
]}]});

describe('Studio inside the app (task 2.3, D4, D14)', () => {
  it('serves Studio with the app embed config; API needs the token; external saves stream live', async () => {
    const p = await engine.createProject({name: 'Studio test', project: titleProject(2)});
    const {studioUrl} = await engine.openProject({dir: p.dir, parentOrigin: 'app://shell', readOnly: false});
    const html = await (await fetch(studioUrl)).text();
    const cfg = JSON.parse(/window\.DTLY = (\{.*?\});/.exec(html)![1]);
    expect(cfg).toMatchObject({brand: 'CustomerPro Video', media: 'direct', features: {render: 'browser', events: true, svgImport: true}, readOnly: false, parentOrigin: 'app://shell'});
    expect(html).toContain('<title>CustomerPro Video Studio</title>');
    expect(new URL(studioUrl).hostname).toBe('127.0.0.1');
    expect((await fetch(`${studioUrl}api/project`)).status).toBe(403);
    const r = await fetch(`${studioUrl}api/project`, {headers: {'X-DTLY-Token': cfg.token}});
    const {rev} = await r.json() as {rev: number};

    // SSE through the front server: an external (agent/tool) save shows up as a 'project' event.
    const got = new Promise<string>((resolve, reject) => {
      const req = http.get(`${studioUrl}api/events?token=${cfg.token}`, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; if (/event: project\ndata: (.*)\n/.test(buf)) { resolve(/event: project\ndata: (.*)\n/.exec(buf)![1]); req.destroy(); } });
      });
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no live event')), 5000);
    });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const proj = titleProject(2);
    proj.comps[0].layers[0].text = 'Edited by the director';
    await engine.writeProjectFile({dir: p.dir, project: proj});
    const ev = JSON.parse(await got);
    expect(ev.rev).toBeGreaterThan(rev);
    expect(Date.now() - t0).toBeLessThan(1000); // "within a second"
    await waitFor(() => events.find((e) => e.event === 'projectChanged' && e.data.dir === p.dir));

    // Read-only follows /me permissions.
    await engine.setStudioOptions({readOnly: true});
    expect(await (await fetch(studioUrl)).text()).toContain('"readOnly":true');
    await engine.closeProject(undefined as never);
  });
});

describe('preview export (task 2.7)', () => {
  it('wraps the root comp at 720p with a watermark', () => {
    const r = previewProject(titleProject(2));
    expect([r.width, r.height]).toEqual([720, 1280]);
    const c = r.project.comps.find((x: any) => x.id === r.project.root);
    expect(c.layers.map((l: any) => l.type)).toEqual(['text', 'text', 'precomp']);
    expect(previewProject({...titleProject(2), comps: [{...titleProject(2).comps[0], width: 1920, height: 1080}]}).height).toBe(720);
  });

  it('renders a watermarked 720p MP4 with progress, including a prepared clip', async () => {
    const p = await engine.createProject({name: 'Export test', project: titleProject(1.5)});
    const raw = makeClip(path.join(tmpDir('raw'), 'cam.mp4'), {dur: 3});
    const {added} = await engine.importMedia({dir: p.dir, paths: [raw]});
    const {segment} = await engine.addToTimeline({dir: p.dir, id: added[0].id, from: 0.5, to: 1.5});
    expect(segment.file).toMatch(/^media\//);
    const job = await engine.startPreviewExport({dir: p.dir});
    const done = await waitFor(() => events.find((e) => e.event === 'export' && e.data.id === job.id && e.data.phase !== 'render')?.data);
    expect(done.phase).toBe('finished');
    expect(events.some((e) => e.event === 'export' && e.data.id === job.id && e.data.phase === 'render' && e.data.done > 0)).toBe(true);
    const v = ffprobeJson(done.out).streams.find((s) => s.codec_type === 'video')!;
    expect([v.codec_name, v.width, v.height]).toEqual(['h264', 720, 1280]);
    expect(fs.readdirSync(p.dir).some((f) => f.startsWith('.preview-'))).toBe(false); // temp project removed
  });

  it('cancels a running export and leaves no file', async () => {
    const p = await engine.createProject({name: 'Cancel test', project: titleProject(30)});
    const job = await engine.startPreviewExport({dir: p.dir});
    await waitFor(() => events.find((e) => e.event === 'export' && e.data.id === job.id && e.data.done > 10));
    await engine.cancelExport({id: job.id});
    const end = await waitFor(() => events.find((e) => e.event === 'export' && e.data.id === job.id && e.data.phase !== 'render')?.data, 10000);
    expect(end.phase).toBe('cancelled');
    expect(fs.existsSync(job.out)).toBe(false);
  });
});
