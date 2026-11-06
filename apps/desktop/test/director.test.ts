// AI director (tasks 4.2–4.5) against a mock Worker + mock CustomerPro: scripted Anthropic SSE responses that
// call tools. No real model or API is ever called.
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {DirectorApi} from '../src/customerpro/director-api.js';
import {configureFfmpeg, probe} from '../src/engine/ffmpeg.js';
import {sanitizeTranscript} from '../src/engine/director/agent.js';
import {appTools} from '../src/engine/director/app-tools.js';
import {createHostClient} from '../src/engine/director/rpc.js';
import {dtlyTools} from '../src/engine/director/dtly-tools.js';
import {createGuard} from '../src/engine/director/guard.js';
import {DirectorManager} from '../src/engine/director/manager.js';
import {ProjectStore} from '../src/engine/director/project-store.js';
import {parsePlan} from '../src/engine/director/prompt.js';
import {createProject, projectFile, readJson, writeJsonAtomic, writeLink} from '../src/engine/projects.js';
import {importMedia} from '../src/engine/sources.js';
import type {DirectorEvent} from '../src/shared/director.js';
import {makeClip, tmpDir} from './helpers.js';
import {createDirectorMock, type ProxyCall, type Turn, wavWithSilence} from './mock/director-mock.js';

beforeAll(() => configureFfmpeg());

type Mock = Awaited<ReturnType<typeof createDirectorMock>>;
const mocks: Mock[] = [];
afterEach(async () => { while (mocks.length) await mocks.pop()!.close(); });

const setup = async (o: {respond?: (c: ProxyCall, n: number) => Turn; budget?: number; perCall?: number; confirm?: (q: string) => boolean; caps?: Record<string, number>; validate?: (p: unknown) => string[]; root?: string; cacheDir?: string} = {}) => {
  const mock = await createDirectorMock({respond: o.respond, budgetCredits: o.budget, creditsPerCall: o.perCall});
  mocks.push(mock);
  const root = o.root ?? tmpDir('dir-root');
  const dir = createProject({name: 'Reel', root});
  writeLink(dir, {orgId: 3, projectId: 101, rev: 1});
  const events: DirectorEvent[] = [];
  const host = new DirectorApi({baseUrl: mock.url, getToken: () => mock.sanctumToken}).asHost();
  const confirms: string[] = [];
  const mgr: DirectorManager = new DirectorManager({
    host, projectsRoot: root, cacheDir: o.cacheDir ?? path.join(root, '.cache', 'analysis'), caps: o.caps, validate: o.validate,
    emit: (e) => {
      events.push(e);
      if (e.type === 'confirm') { confirms.push(e.question); setTimeout(() => mgr.answer(e.id, o.confirm?.(e.question) ?? false), 5); }
    },
  });
  return {mock, dir, root, events, mgr, confirms, host};
};
const done = (events: DirectorEvent[]) => events.filter((e) => e.type === 'done').pop() as Extract<DirectorEvent, {type: 'done'}> | undefined;
const proj = (dir: string) => readJson<any>(projectFile(dir), null);
const toolResults = (c: ProxyCall) => (c.body.messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === 'tool_result');
const lastToolResult = (c: ProxyCall) => toolResults(c).pop();
const resultText = (r: any) => (typeof r?.content === 'string' ? r.content : (r?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''));

describe('director agent loop (task 4.4)', () => {
  it('tool round-trip through the proxy: streams, saves, returns images to the model, closes the session', async () => {
    const {mock, dir, events, mgr} = await setup({respond: (_c, n) => [
      {text: 'Adding a title.', tools: [{name: 'layer_add', input: {layer: {type: 'text', id: 'hello', text: 'KK Park', size: 90, color: '#c6ff00'}}}]},
      {tools: [{name: 'render_frame', input: {time: 0.5, scale: 0.2}}]},
      {text: 'Title added and checked.'},
    ][n] ?? {text: 'ok'}});
    mgr.chat(dir, {text: 'Add a title "KK Park"'});
    await mgr.waitIdle(dir);
    expect(done(events)).toMatchObject({reason: 'finished'});
    expect(proj(dir).comps[0].layers.map((l: any) => l.id)).toContain('hello');

    expect(mock.calls).toHaveLength(3);
    for (const c of mock.calls) {
      expect(c.headers.authorization).toBe(`Bearer ${[...mock.sessions.values()][0].token}`);
      expect(c.model).toBe('claude-sonnet-5-5'); // edit → Sonnet, from the session's models
      expect(c.headers['anthropic-version']).toBe('2023-06-01');
      expect(c.body.system).toBeUndefined(); // the Worker owns the system prompt
    }
    const toolNames = mock.calls[0].body.tools.map((t: any) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['layer_add', 'render_frame', 'preset_apply', 'media_list', 'segment_prepare', 'vo_generate', 'music_pick', 'doc_pages']));
    expect(toolNames).not.toContain('render_video');
    expect(toolNames).not.toContain('map_tiles');
    expect(toolNames).not.toContain('studio_open');
    expect(resultText(lastToolResult(mock.calls[1]))).toMatch(/Added text layer "hello"/);
    const img = lastToolResult(mock.calls[2]).content.find((b: any) => b.type === 'image');
    expect(img.source).toMatchObject({type: 'base64', media_type: 'image/png'});
    expect(Buffer.from(img.source.data, 'base64').subarray(1, 4).toString()).toBe('PNG');

    expect(events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toContain('Adding a title.');
    expect(events.some((e) => e.type === 'tool' && e.name === 'layer_add' && e.state === 'end')).toBe(true);
    expect(events.some((e) => e.type === 'credits' && e.budget === 100)).toBe(true);
    expect([...mock.sessions.values()].every((s) => s.status === 'closed')).toBe(true); // session close called
    expect(mock.log.some((l) => /\/close$/.test(l.path))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'director/conversation.json'))).toBe(true);
    expect(readJson<any>(path.join(dir, 'director/usage.json'), {}).sessions[0]).toMatchObject({mode: 'edit', charged: 3});
    expect(fs.existsSync(path.join(dir, '.director-stage.json'))).toBe(false);
  });

  it('plan phase: style + brief inside the conversation, look-only tools, plan card parsed', async () => {
    const plan = {title: 'KK Park', duration: 6, music: {mood: 'techno', trackId: 'techno-1'}, beats: [{name: 'Hook', duration: 3, shots: [{clip: 'abc', from: 1, to: 4}], text: '1,80,000 sq ft', vo: 'Welcome'}], facts: [{text: '2.1 km from Palghar station', source: 'brief'}], gaps: ['logo']};
    const {mock, dir, events, mgr} = await setup({respond: (_c, n) => [
      {tools: [{name: 'layer_add', input: {layer: {type: 'text', text: 'too early'}}}]},
      {text: `Here is the plan.\n<plan>${JSON.stringify(plan)}</plan>`},
    ][n]});
    mgr.plan(dir, {brief: '60-second reel for KK Park', styleId: 'energetic'});
    await mgr.waitIdle(dir);
    const first = mock.calls[0].body.messages[0].content.map((b: any) => b.text ?? '').join('');
    expect(first).toMatch(/<workspace_style>\nEnergetic and confident[\s\S]*<\/workspace_style>/);
    expect(first).toContain('<project_brief>\n60-second reel for KK Park\n</project_brief>');
    expect(first).toContain('<music_library>');
    expect(first).toContain('"primary":"#c6ff00"'); // brand
    expect(resultText(lastToolResult(mock.calls[1]))).toMatch(/do not change the project/);
    expect(proj(dir).comps[0].layers).toHaveLength(0);
    expect(events.find((e) => e.type === 'plan')).toMatchObject({plan: {title: 'KK Park', beats: [{shots: [{clip: 'abc', from: 1, to: 4}]}]}});
    expect(mgr.state(dir).plan?.facts[0].source).toBe('brief');
    expect(events.some((e) => e.type === 'message' && /\(plan below\)/.test((e as any).text))).toBe(true);
    expect(parsePlan('no plan here')).toBeUndefined();
  });

  it('step cap stops at a safe point', async () => {
    const {mock, dir, events, mgr} = await setup({caps: {edit: 2}, respond: () => ({tools: [{name: 'project_describe', input: {}}]})});
    mgr.chat(dir, {text: 'loop forever'});
    await mgr.waitIdle(dir);
    expect(done(events)).toMatchObject({reason: 'step_cap'});
    expect(mock.calls).toHaveLength(3); // 2 tool calls run, the 3rd is blocked and the run ends
    expect([...mock.sessions.values()][0].status).toBe('closed');
  });

  it('budget_exhausted: stops, keeps the saved project, closes, and continues with a new session', async () => {
    let n = 0;
    const {mock, dir, events, mgr} = await setup({budget: 2, respond: () => (n++ < 2 ? {tools: [{name: 'layer_add', input: {layer: {type: 'text', id: `t${n}`, text: `line ${n}`}}}]} : {text: 'All done.'})});
    mgr.chat(dir, {text: 'add lines'});
    await mgr.waitIdle(dir);
    expect(done(events)).toMatchObject({reason: 'budget', code: 'budget_exhausted'});
    expect(proj(dir).comps[0].layers.map((l: any) => l.id).sort()).toEqual(['t1', 't2']);
    expect([...mock.sessions.values()][0].status).toBe('closed');
    const conv = readJson<any[]>(path.join(dir, 'director/conversation.json'), []);
    expect(conv.some((m) => m.stopReason === 'error')).toBe(false);
    expect(conv.at(-1).role).toBe('toolResult');

    mock.state.budget = 100;
    events.length = 0;
    mgr.continue(dir);
    await mgr.waitIdle(dir);
    expect(done(events)).toMatchObject({reason: 'finished'});
    expect(mock.sessions.size).toBe(2);
    const req = mock.calls.at(-1)!.body.messages;
    expect(req.length).toBeGreaterThan(4); // history from the first session
    expect(JSON.stringify(req.at(-1))).toMatch(/Continue from where you stopped/);
  });

  it('refused session (402 insufficient_credits) and stop', async () => {
    const {mock, dir, events, mgr} = await setup();
    mock.state.sessionStatus = 402;
    mgr.chat(dir, {text: 'x'});
    await mgr.waitIdle(dir);
    expect(done(events)).toMatchObject({reason: 'budget', code: 'insufficient_credits'});

    mock.state.sessionStatus = undefined;
    events.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mock.state.respond = () => ({tools: [{name: 'media_list', input: {}}]});
    mgr.chat(dir, {text: 'keep going'});
    const t = setInterval(() => { if (mock.calls.length >= 2) { mgr.stop(dir); clearInterval(t); release(); } }, 5);
    await gate;
    await mgr.waitIdle(dir);
    expect(done(events)?.reason).toBe('stopped');
    expect([...mock.sessions.values()].every((s) => s.status === 'closed')).toBe(true);
  });

  it('confirm before deleting what the owner made (and not for its own layers)', async () => {
    let answer = false;
    const {mock, dir, events, mgr, confirms} = await setup({confirm: () => answer, respond: (_c, n) => [
      {tools: [{name: 'layer_remove', input: {layer: 'owner-title'}}]},
      {tools: [{name: 'layer_add', input: {layer: {type: 'text', id: 'mine', text: 'temp'}}}]},
      {tools: [{name: 'layer_remove', input: {layer: 'mine'}}]},
      {text: 'ok'},
    ][n % 4]});
    const p = proj(dir);
    p.comps[0].layers.push({id: 'owner-title', name: 'Owner title', type: 'text', text: 'Mine', inPoint: 0, outPoint: 5});
    writeJsonAtomic(projectFile(dir), p);

    mgr.chat(dir, {text: 'clean up'});
    await mgr.waitIdle(dir);
    expect(confirms).toHaveLength(1); // asked for the owner's layer only, not for "mine"
    expect(confirms[0]).toMatch(/Owner title/);
    expect(proj(dir).comps[0].layers.map((l: any) => l.id)).toEqual(['owner-title']);
    expect(resultText(lastToolResult(mock.calls[1]))).toMatch(/did not allow deleting/);
    expect(done(events)?.reason).toBe('finished');

    answer = true;
    mgr.chat(dir, {text: 'really remove it'});
    await mgr.waitIdle(dir);
    expect(confirms).toHaveLength(2);
    expect(proj(dir).comps[0].layers.map((l: any) => l.id)).not.toContain('owner-title');
  });

  it('owner edits win: a save in Studio during a tool → conflict, re-read, continue', async () => {
    let owned = false;
    const validate = (p: unknown) => {
      if (!owned) { // the owner saves in Studio while the director's change is being checked
        owned = true;
        const cur = proj(dirRef.dir);
        cur.comps[0].layers.push({id: 'owner-drag', type: 'text', text: 'Dragged by owner', inPoint: 0, outPoint: 3, transform: {position: [100, 200]}});
        writeJsonAtomic(projectFile(dirRef.dir), cur);
      }
      return [] as string[];
    };
    const dirRef = {dir: ''};
    const {mock, dir, events, mgr} = await setup({validate, respond: (_c, n) => [
      {tools: [{name: 'layer_add', input: {layer: {type: 'text', id: 'agent-1', text: 'A'}}}]},
      {tools: [{name: 'project_describe', input: {}}]},
      {tools: [{name: 'layer_add', input: {layer: {type: 'text', id: 'agent-1', text: 'A'}}}]},
      {text: 'Done, kept your title.'},
    ][n]});
    dirRef.dir = dir;
    mgr.chat(dir, {text: 'add A'});
    await mgr.waitIdle(dir);
    expect(resultText(lastToolResult(mock.calls[1]))).toMatch(/^CONFLICT/);
    expect(resultText(lastToolResult(mock.calls[2]))).toMatch(/owner-drag/); // the re-read sees the owner's layer
    const ids = proj(dir).comps[0].layers.map((l: any) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['owner-drag', 'agent-1']));
    expect(proj(dir).comps[0].layers.find((l: any) => l.id === 'owner-drag').transform.position).toEqual([100, 200]);
    expect(events.some((e) => e.type === 'message' && e.role === 'system' && /kept/.test(e.text))).toBe(true);
    expect(done(events)?.reason).toBe('finished');
  });
});

describe('path guard', () => {
  it('reads only the project + owner raw files; writes only inside the project', async () => {
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'a.mp4'), {dur: 1});
    fs.writeFileSync(path.join(raw, 'secret.txt'), 'no');
    const dir = createProject({name: 'G', root: tmpDir('root')});
    await importMedia(dir, [path.join(raw, 'a.mp4')]);
    fs.symlinkSync(raw, path.join(dir, 'media', 'escape'));
    const g = createGuard(dir);
    expect(g.allowRead(path.join(raw, 'a.mp4'))).toBe(true);
    expect(g.allowRead(path.join(raw, 'secret.txt'))).toBe(false);
    expect(g.allowRead(path.join(dir, 'media', 'escape', 'secret.txt'))).toBe(false); // symlink out of the project
    expect(g.allowWrite(path.join(dir, 'vo', 'x.wav'))).toBe(true);
    expect(g.allowWrite(path.join(raw, 'x.wav'))).toBe(false);
    expect(g.allowWrite(path.join(dir, '.customerpro.json'))).toBe(false);
    expect(() => g.checkWrite('../outside.png')).toThrow(/not allowed/);
    expect(() => g.source('/etc/hosts')).toThrow(/not allowed/);

    // Through the tools: DT.ly's svg_import read and an output path outside the project are refused.
    const store = new ProjectStore(dir, {confirm: async () => false});
    const tools = await dtlyTools({dir, guard: g, store});
    const svg = tools.find((t) => t.name === 'svg_import')!;
    const r = await svg.execute({file: path.join(raw, 'secret.txt')}).catch((e) => ({content: [{type: 'text', text: String(e)}], isError: true}));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not allowed/);
    const frame = tools.find((t) => t.name === 'render_frame')!;
    await expect(frame.execute({time: 0, out: '/tmp/evil.png'})).rejects.toThrow(/Writing \/tmp\/evil.png is not allowed/);
  });
});

describe('footage analysis pass 1 (task 4.2)', () => {
  it('captions per clip, skips per-file failures, and reuses the shared cache in another project (no credits)', async () => {
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'drone.mp4'), {dur: 3});
    makeClip(path.join(raw, 'bad.mp4'), {dur: 2, audio: false});
    const root = tmpDir('root');
    const cacheDir = path.join(root, '.cache', 'analysis');
    const respond = (c: ProxyCall): Turn => {
      const t = JSON.stringify(c.body.messages);
      if (t.includes('name=bad.mp4')) return {text: 'Sorry, I cannot help with that.'};
      return {text: '{"caption": "Aerial view of a cricket ground", "motion": "drone orbit", "quality": "sharp", "best": [{"t": 1.2, "why": "reveal"}], "tags": ["drone"]}'};
    };
    const a = await setup({respond, root, cacheDir});
    await importMedia(a.dir, [raw]);
    a.mgr.analyse(a.dir);
    await a.mgr.waitIdle(a.dir);
    const d1 = done(a.events)!;
    expect(d1.reason).toBe('finished');
    const byName = (id: string) => (d1.results!.find((r) => r.id === id));
    const src = readJson<any>(path.join(a.dir, 'sources.json'), {}).sources as any[];
    const drone = src.find((s) => s.name === 'drone.mp4'), bad = src.find((s) => s.name === 'bad.mp4');
    expect(byName(drone.id)).toMatchObject({ok: true});
    expect(byName(bad.id)).toMatchObject({ok: false});
    expect(a.mock.calls).toHaveLength(2);
    expect(a.mock.calls[0].model).toBe('claude-haiku-5-5');
    expect(a.mock.calls[0].body.messages[0].content.some((b: any) => b.type === 'image')).toBe(true);
    const ai = readJson<any>(path.join(a.dir, 'analysis.json'), {}).byHash[drone.hash].ai;
    expect(ai).toMatchObject({caption: 'Aerial view of a cricket ground', best: [{t: 1.2}], speech: expect.stringContaining('Welcome to KK Park')});
    expect(a.mock.state.transcribes).toBe(1); // the clip with sound; the silent one skipped speech-to-text
    expect(fs.existsSync(path.join(cacheDir, `${drone.hash}.json`))).toBe(true);
    expect([...a.mock.sessions.values()].every((s) => s.status === 'closed' && s.mode === 'analyse')).toBe(true);
    const sessionsAfterFirst = a.mock.sessions.size;

    // Second project, same root: the same clip is analysed at once from the shared cache.
    const dir2 = createProject({name: 'Second', root});
    writeLink(dir2, {orgId: 3, projectId: 102, rev: 1});
    await importMedia(dir2, [path.join(raw, 'drone.mp4')]);
    a.events.length = 0;
    a.mgr.analyse(dir2);
    await a.mgr.waitIdle(dir2);
    expect(done(a.events)!.results).toEqual([{id: drone.id, ok: true, cached: true}]);
    expect(a.mock.calls).toHaveLength(2);
    expect(a.mock.sessions.size).toBe(sessionsAfterFirst); // no session, no credits
    expect(readJson<any>(path.join(dir2, 'analysis.json'), {}).byHash[drone.hash].ai.caption).toBe('Aerial view of a cricket ground');
  });
});

describe('app tools (footage, voiceover, music, documents)', () => {
  it('media_frames, vo_generate with silence trimmed, music_pick, doc_pages, analysis_save', async () => {
    const {dir, host, root} = await setup();
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'clip.mp4'), {dur: 3});
    fs.writeFileSync(path.join(raw, 'brochure.pdf'), minimalPdf(['Page one', 'Page two']));
    await importMedia(dir, [raw]);
    const tools = appTools({dir, guard: createGuard(dir), host, cacheDir: path.join(root, '.cache', 'analysis'), confirm: async () => true});
    const t = (n: string) => tools.find((x) => x.name === n)!;
    const clipId = readJson<any>(path.join(dir, 'sources.json'), {}).sources.find((s: any) => s.name === 'clip.mp4').id;

    const fr = await t('media_frames').execute({file: clipId, from: 0.5, to: 2.5, count: 4});
    expect(fr.content[0]).toMatchObject({type: 'image', mimeType: 'image/png'});
    expect((fr.content[1] as any).text).toMatch(/0\.5, 1\.167, 1\.833, 2\.5/);

    const vo = JSON.parse(((await t('vo_generate').execute({text: 'Welcome to KK Park', speaker: 'anushka', language: 'hi-IN'})).content[0] as {text: string}).text);
    expect(vo.src).toMatch(/^vo\/welcome-to-kk-park\.wav$/);
    expect(vo.duration).toBeGreaterThan(1.0);
    expect(vo.duration).toBeLessThan(1.5); // 0.6 s of silence each side trimmed from 2.4 s
    expect((await probe(path.join(dir, vo.src))).audio?.sampleRate).toBe(48000);

    const mu = JSON.parse(((await t('music_pick').execute({id: 'techno-1'})).content[0] as {text: string}).text);
    expect(mu).toMatchObject({src: 'music/techno-1.wav', beats: 'music/techno-1.beats.json', bpm: 120, beatCount: 7});
    expect(fs.existsSync(path.join(dir, 'music/techno-1.wav'))).toBe(true);

    const pdf = await t('doc_pages').execute({file: 'brochure.pdf', pages: [2]});
    expect(pdf.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect((pdf.content.at(-1) as any).text).toMatch(/pages 2 of 2/);

    await t('analysis_save').execute({file: clipId, notes: {shake: 'none'}});
    const hash = readJson<any>(path.join(dir, 'sources.json'), {}).sources.find((s: any) => s.id === clipId).hash;
    expect(readJson<any>(path.join(dir, 'analysis.json'), {}).byHash[hash].ai.notes).toEqual({shake: 'none'});

    await expect(t('media_sheet').execute({file: '../../etc/passwd'})).rejects.toThrow(/not allowed/);
    expect(wavWithSilence(0, 1).length).toBeGreaterThan(44);
  });

  it('engine → main host calls round-trip (createSession through the RPC, errors keep their code)', async () => {
    const {mock, dir} = await setup();
    const api = new DirectorApi({baseUrl: mock.url, getToken: () => mock.sanctumToken});
    const rpc = createHostClient((c) => {
      const fn = (api.asHost() as any)[c.op];
      void fn(c.params).then((result: unknown) => rpc.reply({id: c.id, result}), (e: any) => rpc.reply({id: c.id, error: {message: e.message, code: e.code}}));
    });
    const s = await rpc.host.createSession({dir, mode: 'build', premium: true});
    expect(s.models).toEqual(['claude-opus-5-5']);
    expect(mock.log.find((l) => l.path.endsWith('/director/sessions'))?.body).toEqual({project_id: 101, mode: 'build', premium: true});
    mock.state.sessionStatus = 402;
    await expect(rpc.host.createSession({dir, mode: 'edit'})).rejects.toMatchObject({code: 'insufficient_credits'});
    fs.rmSync(path.join(dir, '.customerpro.json'));
    await expect(rpc.host.createSession({dir, mode: 'edit'})).rejects.toMatchObject({code: 'not_linked'});
  });

  it('sanitizes transcripts (no errored turns, no dangling tool calls)', () => {
    const t = sanitizeTranscript([
      {role: 'system', content: ''},
      {role: 'user', content: [{type: 'text', text: 'hi'}]},
      {role: 'assistant', content: [{type: 'toolCall', id: 'a', name: 'x', arguments: {}}], stopReason: 'toolUse'},
      {role: 'toolResult', toolCallId: 'a', content: []},
      {role: 'assistant', content: [{type: 'toolCall', id: 'b', name: 'x', arguments: {}}], stopReason: 'toolUse'},
      {role: 'assistant', content: [], stopReason: 'error'},
    ]) as any[];
    expect(t.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
  });
});

// A tiny two-page PDF (Helvetica text + a rectangle per page).
const minimalPdf = (pages: string[]) => {
  const o = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((t, i) => {
    const c = `BT /F1 48 Tf 72 700 Td (${t}) Tj ET 0 0 1 rg 72 400 200 150 re f`;
    o.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    o.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  });
  let s = '%PDF-1.4\n';
  const off: number[] = [];
  o.forEach((b, i) => { off.push(s.length); s += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${o.length + 1}\n0000000000 65535 f \n${off.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${o.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return s;
};
