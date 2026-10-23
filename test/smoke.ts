// End-to-end smoke test: starters → stills → MP4, then the MCP server driven like an agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readProject, renderStill, renderVideo, writeProject} from '../src/node.js';
import {layoutText, setKeyframe, validate} from '../src/index.js';
import {newCanvas, registerFonts} from '../src/node.js';
import {STARTERS} from '../src/starter.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-test-'));
const step = (s: string) => console.log(`✓ ${s}`);

// Word positions must keep the space between words (skia drops trailing spaces in measureText).
registerFonts({dtly: 1, name: 't', root: 'main', comps: []}, '.');
const ctx = newCanvas(10, 10).getContext('2d') as unknown as CanvasRenderingContext2D;
const L = layoutText(ctx, {id: 't', type: 'text', text: 'with words आजच कॉल'}, 64, 0, '800 64px "Baloo 2"');
for (let i = 1; i < L.words.length; i++) assert.ok(L.words[i].x > L.words[i - 1].x + L.words[i - 1].w + 5, `gap before "${L.words[i].text}"`);
step('word spacing preserved in per-word layout');

for (const [name, s] of Object.entries(STARTERS)) {
  const file = path.join(dir, `${name}.json`);
  writeProject(file, s.build('DT.ly किरण'));
  assert.deepEqual(validate(readProject(file)), []);
  const png = await renderStill(file, 2, path.join(dir, `${name}.png`), {scale: 0.25});
  assert.ok(fs.statSync(png).size > 1000);
  step(`starter ${name}: valid, still rendered`);
}

const p = readProject(path.join(dir, 'bars.json'));
setKeyframe(p, 'bars-title', 'transform.rotation', 1, -8, 'backOut');
setKeyframe(p, 'bars-title', 'transform.rotation', 1.6, 0);
writeProject(path.join(dir, 'bars.json'), p);
const r = await renderVideo(path.join(dir, 'bars.json'), path.join(dir, 'bars.mp4'), {to: 1});
assert.equal(r.frames, 30);
assert.ok(fs.statSync(r.out).size > 1000);
step('MP4 render (1 s)');

const client = new Client({name: 'dtly-test', version: '0'});
await client.connect(new StdioClientTransport({command: process.execPath, args: [...process.execArgv, path.resolve('src/cli.ts'), 'mcp']}));
const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('keyframe_set') && tools.includes('render_frame'));
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({name, arguments: args});
  assert.ok(!res.isError, `${name}: ${JSON.stringify(res.content)}`);
  return res.content as {type: string; text?: string; data?: string}[];
};
const proj = path.join(dir, 'mcp.json');
await call('project_create', {project: proj, name: 'MCP test', duration: 3});
await call('layer_add', {project: proj, layer: {type: 'text', id: 'hello', text: 'नमस्कार DT.ly', size: 120}});
await call('preset_apply', {project: proj, preset: 'text.cascade', params: {layer: 'hello'}});
await call('keyframe_set', {project: proj, layer: 'hello', property: 'transform.scale', time: 0, value: [60, 60], ease: {spring: {stiffness: 200, damping: 10}}});
await call('keyframe_set', {project: proj, layer: 'hello', property: 'transform.scale', time: 1, value: [100, 100]});
const frame = await call('render_frame', {project: proj, time: 1.5, scale: 0.25});
assert.ok(frame.some((c) => c.type === 'image' && (c.data?.length ?? 0) > 1000));
assert.match((await call('project_validate', {project: proj}))[0].text ?? '', /No problems/);
await client.close();
step(`MCP server: ${tools.length} tools, edit + render_frame round trip`);

fs.rmSync(dir, {recursive: true, force: true});
console.log('All tests passed.');
