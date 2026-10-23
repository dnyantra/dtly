// DT.ly MCP server — fine-grained, After Effects-style editing for agents.
// Every tool takes the project file path; edits are saved atomically after each call.
import fs from 'node:fs';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import {EASE_NAMES} from '../core/ease.js';
import type {Ease, NewLayer} from '../core/model.js';
import * as ops from '../ops/ops.js';
import {editProject, readProject, writeProject} from '../ops/store.js';
import {listPresets, PRESETS} from '../presets/index.js';
import {renderContactSheet, renderStill, renderVideoParallel} from '../render/export.js';
import {VERSION} from '../version.js';

export const createMcpServer = () => {
const server = new McpServer({name: 'dtly', title: 'DT.ly — from the creator of CustomerPro.in', version: VERSION});

const projectArg = z.string().describe('Path to the DT.ly project .json file');
const easeArg = z
  .union([z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()]), z.object({spring: z.object({stiffness: z.number().optional(), damping: z.number().optional(), mass: z.number().optional()})})])
  .optional()
  .describe(`Ease for the segment leaving this keyframe: ${EASE_NAMES.join(', ')}; a cubic-bezier [x1,y1,x2,y2]; or {spring:{stiffness,damping}}`);
const json = z.any().describe('A JSON value (number, [x,y], colour string, object…)');

const text = (s: string) => ({content: [{type: 'text' as const, text: s}]});
const run = (fn: () => string | Promise<string>) => async () => {
  try {
    return text(await fn());
  } catch (e) {
    return {...text(`Error: ${(e as Error).message}`), isError: true};
  }
};
const framesDir = (project: string) => {
  const d = path.join(path.dirname(path.resolve(project)), '.dtly', 'frames');
  fs.mkdirSync(d, {recursive: true});
  return d;
};

server.registerTool('project_create', {
  description: 'Create a new DT.ly project with a root composition "main". Defaults: 1080x1920 (9:16), 30 fps, 10 s.',
  inputSchema: {project: projectArg, name: z.string(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), duration: z.number().optional(), background: z.string().optional()},
}, (a) => run(() => {
  if (fs.existsSync(a.project)) throw new Error(`${a.project} already exists`);
  writeProject(a.project, ops.newProject(a));
  return `Created ${a.project}\n${ops.describe(readProject(a.project))}`;
})());

server.registerTool('project_describe', {
  description: 'Outline of the project: comps, layer stack (index 0 = top), timing, and which properties are animated with keyframe times. Call this before editing.',
  inputSchema: {project: projectArg},
}, (a) => run(() => ops.describe(readProject(a.project)))());

server.registerTool('project_validate', {
  description: 'Static checks: broken parent/matte/precomp references, bad in/out points, keyframes outside the comp.',
  inputSchema: {project: projectArg},
}, (a) => run(() => { const w = ops.validate(readProject(a.project)); return w.length ? w.join('\n') : 'No problems found.'; })());

server.registerTool('layer_get', {
  description: 'Full JSON of one layer, including every property and keyframe.',
  inputSchema: {project: projectArg, layer: z.string()},
}, (a) => run(() => JSON.stringify(ops.findLayer(readProject(a.project), a.layer).layer, null, 2))());

server.registerTool('comp_add', {
  description: 'Add a composition (use for precomps/scenes). Size, fps and duration default to the root comp.',
  inputSchema: {project: projectArg, id: z.string(), name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), duration: z.number().optional(), background: z.string().optional()},
}, (a) => run(() => { const {project, ...c} = a; editProject(project, (p) => ops.addComp(p, c)); return `Added comp ${a.id}`; })());

server.registerTool('comp_update', {
  description: 'Change a composition: duration, size, fps, background, name, markers. Set root:true to make it the rendered comp.',
  inputSchema: {project: projectArg, comp: z.string(), duration: z.number().optional(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), background: z.string().optional(), name: z.string().optional(), markers: z.array(z.object({t: z.number(), label: z.string()})).optional(), root: z.boolean().optional()},
}, (a) => run(() => {
  const {project, comp, root, ...patch} = a;
  editProject(project, (p) => { ops.updateComp(p, comp, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); if (root) p.root = comp; });
  return `Updated comp ${comp}`;
})());

server.registerTool('layer_add', {
  description: `Add a layer. \`layer\` is the layer JSON without needing an id: {type: "text"|"shape"|"solid"|"image"|"video"|"audio"|"precomp"|"null", name?, inPoint?, outPoint?, transform?: {anchor,position,scale(%),rotation(deg),opacity(%),skew}, effects?, masks?, matte?, parent?, blendMode?, motionBlur?, ...type props}. Text: text,size,weight,color,font,align,maxWidth,lineHeight,tracking,stroke,shadow,box,animators. Shape: shape(rect|ellipse|polygon|path|line),size,radius,points,fill,stroke,strokeWidth,trim{start,end}. Video: src,trimIn,speed,volume,fit. Any numeric/vector/colour property can be {keyframes:[{t,v,ease}]}. index 0 = top of the stack.`,
  inputSchema: {project: projectArg, comp: z.string().optional().describe('Comp id, default root'), layer: z.record(z.string(), z.any()), index: z.number().optional()},
}, (a) => run(() => {
  const l = editProject(a.project, (p) => ops.addLayer(p, a.comp, a.layer as NewLayer, a.index ?? 0));
  return `Added ${l.type} layer "${l.id}"`;
})());

server.registerTool('layer_update', {
  description: 'Deep-merge a patch into a layer (null deletes a key). Arrays and {keyframes} objects are replaced whole. Use keyframe_set for single keyframes.',
  inputSchema: {project: projectArg, layer: z.string(), patch: z.record(z.string(), z.any())},
}, (a) => run(() => { editProject(a.project, (p) => ops.updateLayer(p, a.layer, a.patch)); return `Updated ${a.layer}`; })());

server.registerTool('layer_remove', {
  description: 'Delete a layer (also clears parent/matte links pointing at it).',
  inputSchema: {project: projectArg, layer: z.string()},
}, (a) => run(() => { editProject(a.project, (p) => ops.removeLayer(p, a.layer)); return `Removed ${a.layer}`; })());

server.registerTool('layer_move', {
  description: 'Reorder a layer in its comp stack. index 0 = top.',
  inputSchema: {project: projectArg, layer: z.string(), index: z.number()},
}, (a) => run(() => { editProject(a.project, (p) => ops.moveLayer(p, a.layer, a.index)); return `Moved ${a.layer} to index ${a.index}`; })());

server.registerTool('layer_duplicate', {
  description: 'Duplicate a layer (placed above the original), optionally shifted in time.',
  inputSchema: {project: projectArg, layer: z.string(), newId: z.string().optional(), timeShift: z.number().optional()},
}, (a) => run(() => { const l = editProject(a.project, (p) => ops.duplicateLayer(p, a.layer, a)); return `Duplicated as ${l.id}`; })());

server.registerTool('layer_shift', {
  description: 'Slide a layer in time: moves its in/out points and all of its keyframes by delta seconds.',
  inputSchema: {project: projectArg, layer: z.string(), delta: z.number()},
}, (a) => run(() => { editProject(a.project, (p) => ops.shiftLayer(p, a.layer, a.delta)); return `Shifted ${a.layer} by ${a.delta}s`; })());

server.registerTool('property_set', {
  description: 'Set a static property by dot path, e.g. "transform.position", "color", "trim.end", "effects.0.radius", "box.color". Replaces any keyframes on that path.',
  inputSchema: {project: projectArg, layer: z.string(), property: z.string(), value: json},
}, (a) => run(() => { editProject(a.project, (p) => ops.setProperty(p, a.layer, a.property, a.value)); return `Set ${a.layer}.${a.property}`; })());

server.registerTool('keyframe_set', {
  description: 'Add or replace one keyframe on a property path (e.g. "transform.position", "transform.scale", "transform.opacity", "trim.end", "box.reveal", "size", "color", "effects.0.radius"). Time is comp seconds. A static property is converted to animated, keeping its old value at the layer inPoint.',
  inputSchema: {project: projectArg, layer: z.string(), property: z.string(), time: z.number(), value: json, ease: easeArg},
}, (a) => run(() => {
  const kfs = editProject(a.project, (p) => ops.setKeyframe(p, a.layer, a.property, a.time, a.value, a.ease as Ease | undefined));
  return `${a.layer}.${a.property} keyframes: ${kfs.map((k) => `${k.t}s=${JSON.stringify(k.v)}${k.ease ? `(${JSON.stringify(k.ease)})` : ''}`).join('  ')}`;
})());

server.registerTool('keyframe_remove', {
  description: 'Remove the keyframe at a time. If one keyframe remains, the property becomes static.',
  inputSchema: {project: projectArg, layer: z.string(), property: z.string(), time: z.number()},
}, (a) => run(() => { editProject(a.project, (p) => ops.removeKeyframe(p, a.layer, a.property, a.time)); return `Removed keyframe ${a.time}s on ${a.layer}.${a.property}`; })());

server.registerTool('keyframe_ease', {
  description: 'Change the ease of the segment leaving the keyframe at `time` (AE: Keyframe Assistant / speed graph).',
  inputSchema: {project: projectArg, layer: z.string(), property: z.string(), time: z.number(), ease: easeArg},
}, (a) => run(() => { editProject(a.project, (p) => ops.setEase(p, a.layer, a.property, a.time, (a.ease ?? 'linear') as Ease)); return `Ease set`; })());

server.registerTool('preset_list', {
  description: 'List presets: text animators (text.*), kinetic typography (kinetic.*), openers (opener.*), slideshows (slides.*), transitions (transition.*), elements (element.*), with their parameters.',
  inputSchema: {},
}, () => run(() => listPresets())());

server.registerTool('preset_apply', {
  description: 'Apply a preset to the project. See preset_list for names and params.',
  inputSchema: {project: projectArg, preset: z.string(), comp: z.string().optional(), params: z.record(z.string(), z.any()).optional()},
}, (a) => run(() => {
  const preset = PRESETS[a.preset];
  if (!preset) throw new Error(`Unknown preset "${a.preset}". Use preset_list.`);
  const r = editProject(a.project, (p) => preset.apply(p, a.comp, a.params ?? {}));
  return `${a.preset}: ${r.created.length ? `created ${r.created.join(', ')}` : 'applied'}${r.note ? `. ${r.note}` : ''}`;
})());

server.registerTool('render_frame', {
  description: 'Render one frame and return it as an image so you can check layout, legibility and timing. Use scale ~0.4 for 1080x1920.',
  inputSchema: {project: projectArg, time: z.number(), comp: z.string().optional(), scale: z.number().optional()},
}, async (a) => {
  try {
    const out = path.join(framesDir(a.project), `frame-${a.time.toFixed(3)}.png`);
    await renderStill(a.project, a.time, out, {comp: a.comp, scale: a.scale ?? 0.4});
    return {content: [{type: 'image' as const, data: fs.readFileSync(out).toString('base64'), mimeType: 'image/png'}, {type: 'text' as const, text: `Saved ${out}`}]};
  } catch (e) {
    return {...text(`Error: ${(e as Error).message}`), isError: true};
  }
});

server.registerTool('render_sheet', {
  description: 'Render a contact sheet of several times in one image — the fastest way to review motion and pacing.',
  inputSchema: {project: projectArg, times: z.array(z.number()), comp: z.string().optional(), columns: z.number().optional()},
}, async (a) => {
  try {
    const out = path.join(framesDir(a.project), `sheet-${Date.now()}.png`);
    await renderContactSheet(a.project, a.times, out, {comp: a.comp, columns: a.columns, thumbWidth: 200});
    return {content: [{type: 'image' as const, data: fs.readFileSync(out).toString('base64'), mimeType: 'image/png'}, {type: 'text' as const, text: `Saved ${out}`}]};
  } catch (e) {
    return {...text(`Error: ${(e as Error).message}`), isError: true};
  }
});

server.registerTool('render_video', {
  description: 'Render the root comp (or a range) to MP4 with mixed audio. Roughly 2-4x real time on a laptop for 1080x1920.',
  inputSchema: {project: projectArg, out: z.string().describe('Output .mp4 path'), from: z.number().optional(), to: z.number().optional(), comp: z.string().optional(), workers: z.number().optional().describe('Parallel processes; only worth it for long videos (default 1)')},
}, (a) => run(async () => {
  const t0 = Date.now();
  const r = await renderVideoParallel(a.project, a.out, a);
  return `Rendered ${r.out}: ${r.seconds.toFixed(2)}s, ${r.frames} frames, ${r.audioTracks} audio tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
})());

return server;
};

// Runs the MCP server over stdio (what `dtly mcp` and the Claude Code plugin start).
export const startMcpServer = async () => {
  await createMcpServer().connect(new StdioServerTransport());
};
