// DT.ly tools: definitions, JSON Schemas and handlers that work on one project file.
// The MCP server (src/mcp/server.ts) is a thin adapter over TOOLS; the desktop app registers
// the same handlers with its agent. Handlers never take the project path as input: the host
// supplies it in ToolContext.projectPath (the MCP adapter maps its `project` argument to it).
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import {EASE_NAMES} from '../core/ease.js';
import type {Ease, NewLayer} from '../core/model.js';
import * as ops from '../ops/ops.js';
import {editProject, readProject, writeProject} from '../ops/store.js';
import {listPresets, PRESETS} from '../presets/index.js';
import {renderContactSheet, renderStill, renderVideoParallel} from '../render/export.js';
import type {ToolContext, ToolDef, ToolResult} from './types.js';

export type {ToolContent, ToolContext, ToolDef, ToolResult} from './types.js';

/** Hints for MCP clients (tools that don't change the project; renders only write previews to .dtly/frames). */
export interface ToolAnnotations {readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean}

/** A ToolDef plus what the MCP adapter needs: the zod shape it registers and annotations. */
export interface DtlyToolDef<I = any> extends ToolDef<I> {
  /** zod raw shape of the input (without the project path). */
  shape: z.ZodRawShape;
  /** false for tools that don't work on a project (preset_list). */
  project: boolean;
  annotations?: ToolAnnotations;
}

const READ_ONLY: ToolAnnotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};

const easeArg = z
  .union([z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()]), z.object({spring: z.object({stiffness: z.number().optional(), damping: z.number().optional(), mass: z.number().optional()})})])
  .optional()
  .describe(`Ease for the segment leaving this keyframe: ${EASE_NAMES.join(', ')}; a cubic-bezier [x1,y1,x2,y2]; or {spring:{stiffness,damping}}`);
const json = z.any().describe('A JSON value (number, [x,y], colour string, object…)');

const text = (s: string): ToolResult => ({content: [{type: 'text', text: s}]});
const projectDir = (ctx: ToolContext) => path.dirname(ctx.projectPath);
/** A preview file in <project>/.dtly/frames, checked with the write guard before the folder is created. */
const previewFile = (ctx: ToolContext, name: string) => {
  const out = writable(ctx, path.join(projectDir(ctx), '.dtly', 'frames', name));
  fs.mkdirSync(path.dirname(out), {recursive: true});
  return out;
};
/** Resolves a path relative to the project folder and checks it with the host's guard. */
const readable = (ctx: ToolContext, p: string) => {
  const abs = path.resolve(projectDir(ctx), p);
  if (!ctx.allowRead(abs)) throw new Error(`Reading ${p} is not allowed`);
  return abs;
};
/** Resolves an output path relative to the project folder and checks it with the host's write guard (if any). */
const writable = (ctx: ToolContext, p: string) => {
  const abs = path.resolve(projectDir(ctx), p);
  if (ctx.allowWrite && !ctx.allowWrite(abs)) throw new Error(`Writing ${p} is not allowed`);
  return abs;
};
const image = (file: string): ToolResult => ({content: [{type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/png'}, {type: 'text', text: `Saved ${file}`}]});

const studios = new Map<string, {url: string; close: () => void}>();

type Spec<S extends z.ZodRawShape> = {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  project?: boolean;
  shape: S;
  run: (a: z.infer<z.ZodObject<S>>, ctx: ToolContext) => string | ToolResult | Promise<string | ToolResult>;
};

const jsonSchema = (shape: z.ZodRawShape) => {
  const {$schema: _, ...s} = z.toJSONSchema(z.object(shape).strict(), {io: 'input'}) as Record<string, unknown>;
  return s;
};

const tool = <S extends z.ZodRawShape>(s: Spec<S>): DtlyToolDef<z.infer<z.ZodObject<S>>> => {
  const parser = z.object(s.shape).strict();
  return {
    name: s.name,
    description: s.description,
    inputSchema: jsonSchema(s.shape),
    shape: s.shape,
    project: s.project !== false,
    ...(s.annotations && {annotations: s.annotations}),
    async handler(input, ctx) {
      try {
        const r = await s.run(parser.parse(input ?? {}) as z.infer<z.ZodObject<S>>, ctx);
        return typeof r === 'string' ? text(r) : r;
      } catch (e) {
        const err = e as Error;
        const msg = err instanceof z.ZodError ? `Invalid input: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` : err.message;
        return {...text(`Error: ${msg}`), isError: true};
      }
    },
  };
};

export const TOOLS: DtlyToolDef[] = [
  tool({
    name: 'project_create',
    description: 'Create a new DT.ly project with a root composition "main". Defaults: 1080x1920 (9:16), 30 fps, 10 s.',
    shape: {name: z.string(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), duration: z.number().optional(), background: z.string().optional()},
    run: (a, ctx) => {
      if (fs.existsSync(ctx.projectPath)) throw new Error(`${ctx.projectPath} already exists`);
      writeProject(ctx.projectPath, ops.newProject(a));
      return `Created ${ctx.projectPath}\n${ops.describe(readProject(ctx.projectPath))}`;
    },
  }),
  tool({
    name: 'project_describe',
    annotations: READ_ONLY,
    description: 'Outline of the project: comps, layer stack (index 0 = top), timing, and which properties are animated with keyframe times. Call this before editing.',
    shape: {},
    run: (_a, ctx) => ops.describe(readProject(ctx.projectPath)),
  }),
  tool({
    name: 'project_validate',
    annotations: READ_ONLY,
    description: 'Static checks: broken parent/matte/precomp references, bad in/out points, keyframes outside the comp.',
    shape: {},
    run: (_a, ctx) => { const w = ops.validate(readProject(ctx.projectPath)); return w.length ? w.join('\n') : 'No problems found.'; },
  }),
  tool({
    name: 'layer_get',
    annotations: READ_ONLY,
    description: 'Full JSON of one layer, including every property and keyframe.',
    shape: {layer: z.string()},
    run: (a, ctx) => JSON.stringify(ops.findLayer(readProject(ctx.projectPath), a.layer).layer, null, 2),
  }),
  tool({
    name: 'comp_add',
    description: 'Add a composition (use for precomps/scenes). Size, fps and duration default to the root comp.',
    shape: {id: z.string(), name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), duration: z.number().optional(), background: z.string().optional()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.addComp(p, a)); return `Added comp ${a.id}`; },
  }),
  tool({
    name: 'comp_update',
    description: 'Change a composition: duration, size, fps, background, name, markers. Set root:true to make it the rendered comp.',
    shape: {comp: z.string(), duration: z.number().optional(), width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), background: z.string().optional(), name: z.string().optional(), markers: z.array(z.object({t: z.number(), label: z.string()})).optional(), root: z.boolean().optional()},
    run: (a, ctx) => {
      const {comp, root, ...patch} = a;
      editProject(ctx.projectPath, (p) => { ops.updateComp(p, comp, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); if (root) p.root = comp; });
      return `Updated comp ${comp}`;
    },
  }),
  tool({
    name: 'layer_add',
    description: `Add a layer. \`layer\` is the layer JSON without needing an id: {type: "text"|"shape"|"solid"|"image"|"video"|"audio"|"lottie"|"adjustment"|"precomp"|"null", name?, inPoint?, outPoint?, transform?: {anchor,position,scale(%),rotation(deg),opacity(%),skew}, effects?, masks?, matte?, parent?, blendMode?, motionBlur?, ...type props}. Text: text,size,weight,color,font,align,maxWidth,lineHeight,tracking,stroke,shadow,box,animators. Shape: shape(rect|ellipse|polygon|star|path|line),size,radius,innerRadius,sides,path (SVG d; keyframe different paths to morph),fill (colour or {linear|radial gradient}),stroke,strokeWidth,dash,trim{start,end,offset},repeater{copies,position,rotation,scale,startOpacity,endOpacity}. Video: src,trimIn,speed,volume,fit. Lottie: src (.json), size, loop, speed, timeOffset, frames. Any numeric/vector/colour property can be {keyframes:[{t,v,ease}]}. index 0 = top of the stack.`,
    shape: {comp: z.string().optional().describe('Comp id, default root'), layer: z.record(z.string(), z.any()), index: z.number().optional()},
    run: (a, ctx) => {
      const l = editProject(ctx.projectPath, (p) => ops.addLayer(p, a.comp, a.layer as NewLayer, a.index ?? 0));
      return `Added ${l.type} layer "${l.id}"`;
    },
  }),
  tool({
    name: 'layer_update',
    description: 'Deep-merge a patch into a layer (null deletes a key). Arrays and {keyframes} objects are replaced whole. Use keyframe_set for single keyframes.',
    shape: {layer: z.string(), patch: z.record(z.string(), z.any())},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.updateLayer(p, a.layer, a.patch)); return `Updated ${a.layer}`; },
  }),
  tool({
    name: 'layer_remove',
    description: 'Delete a layer (also clears parent/matte links pointing at it).',
    shape: {layer: z.string()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.removeLayer(p, a.layer)); return `Removed ${a.layer}`; },
  }),
  tool({
    name: 'layer_move',
    description: 'Reorder a layer in its comp stack. index 0 = top.',
    shape: {layer: z.string(), index: z.number()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.moveLayer(p, a.layer, a.index)); return `Moved ${a.layer} to index ${a.index}`; },
  }),
  tool({
    name: 'layer_duplicate',
    description: 'Duplicate a layer (placed above the original), optionally shifted in time.',
    shape: {layer: z.string(), newId: z.string().optional(), timeShift: z.number().optional()},
    run: (a, ctx) => { const l = editProject(ctx.projectPath, (p) => ops.duplicateLayer(p, a.layer, a)); return `Duplicated as ${l.id}`; },
  }),
  tool({
    name: 'layer_shift',
    description: 'Slide a layer in time: moves its in/out points and all of its keyframes by delta seconds.',
    shape: {layer: z.string(), delta: z.number()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.shiftLayer(p, a.layer, a.delta)); return `Shifted ${a.layer} by ${a.delta}s`; },
  }),
  tool({
    name: 'property_set',
    description: 'Set a static property by dot path, e.g. "transform.position", "color", "trim.end", "effects.0.radius", "box.color". Replaces any keyframes on that path.',
    shape: {layer: z.string(), property: z.string(), value: json},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.setProperty(p, a.layer, a.property, a.value)); return `Set ${a.layer}.${a.property}`; },
  }),
  tool({
    name: 'keyframe_set',
    description: 'Add or replace one keyframe on a property path (e.g. "transform.position", "transform.scale", "transform.opacity", "trim.end", "box.reveal", "size", "color", "effects.0.radius"). Time is comp seconds. A static property is converted to animated, keeping its old value at the layer inPoint.',
    shape: {layer: z.string(), property: z.string(), time: z.number(), value: json, ease: easeArg},
    run: (a, ctx) => {
      const kfs = editProject(ctx.projectPath, (p) => ops.setKeyframe(p, a.layer, a.property, a.time, a.value, a.ease as Ease | undefined));
      return `${a.layer}.${a.property} keyframes: ${kfs.map((k) => `${k.t}s=${JSON.stringify(k.v)}${k.ease ? `(${JSON.stringify(k.ease)})` : ''}`).join('  ')}`;
    },
  }),
  tool({
    name: 'keyframe_remove',
    description: 'Remove the keyframe at a time. If one keyframe remains, the property becomes static.',
    shape: {layer: z.string(), property: z.string(), time: z.number()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.removeKeyframe(p, a.layer, a.property, a.time)); return `Removed keyframe ${a.time}s on ${a.layer}.${a.property}`; },
  }),
  tool({
    name: 'keyframe_move',
    description: 'Retime one keyframe (keeps its value and ease), like dragging a key in the timeline.',
    shape: {layer: z.string(), property: z.string(), from: z.number(), to: z.number()},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.moveKeyframe(p, a.layer, a.property, a.from, a.to)); return `Moved ${a.layer}.${a.property} key ${a.from}s → ${a.to}s`; },
  }),
  tool({
    name: 'keyframe_ease',
    description: 'Change the ease of the segment leaving the keyframe at `time` (AE: Keyframe Assistant / speed graph).',
    shape: {layer: z.string(), property: z.string(), time: z.number(), ease: easeArg},
    run: (a, ctx) => { editProject(ctx.projectPath, (p) => ops.setEase(p, a.layer, a.property, a.time, (a.ease ?? 'linear') as Ease)); return `Ease set`; },
  }),
  tool({
    name: 'svg_import',
    description: 'Add an SVG file (logo, icon, illustration) as editable shape layers grouped under a null layer: every path keeps its fill, stroke and gradient, and can be recoloured, trimmed (draw-on), morphed or animated. Animate the returned group to move the whole graphic.',
    shape: {file: z.string().describe('SVG path, absolute or relative to the project file'), comp: z.string().optional(), width: z.number().optional().describe('Width in px (default 600)'), position: z.tuple([z.number(), z.number()]).optional(), name: z.string().optional(), color: z.string().optional().describe('Colour for currentColor (icon sets)'), inPoint: z.number().optional()},
    run: (a, ctx) => {
      const file = readable(ctx, a.file);
      const r = editProject(ctx.projectPath, (p) => ops.addSvg(p, a.comp, fs.readFileSync(file, 'utf8'), {name: a.name ?? path.basename(file, '.svg'), width: a.width, position: a.position as [number, number] | undefined, color: a.color, inPoint: a.inPoint}));
      return `Added group "${r.group}" (${Math.round(r.size[0])}×${Math.round(r.size[1])} px) with ${r.parts} parts: ${r.ids.join(', ')}`;
    },
  }),
  tool({
    name: 'captions_add',
    description: 'Add captions with the current word highlighted. Source: an .srt/.vtt/.json file, or an audio/video file transcribed with Sarvam AI (any Indian language or English; needs SARVAM_API_KEY in the environment). Each caption page becomes an editable text layer.',
    shape: {source: z.string().describe('Path (relative to the project) to .srt/.vtt/.json or an audio/video file'), language: z.string().optional().describe('BCP-47, e.g. mr-IN, hi-IN, en-IN (default auto)'), comp: z.string().optional(), maxWords: z.number().optional(), position: z.tuple([z.number(), z.number()]).optional(), size: z.number().optional(), highlight: z.string().optional(), box: z.string().optional(), plate: z.string().optional(), mode: z.enum(['current', 'spoken']).optional(), uppercase: z.boolean().optional(), offset: z.number().optional(), style: z.enum(['pop', 'fade', 'none']).optional()},
    run: async (a, ctx) => {
      const {loadCaptions} = await import('../render/transcribe.js');
      const {source, language, comp, ...style} = a;
      const src = await loadCaptions(readable(ctx, source), language);
      const r = editProject(ctx.projectPath, (p) => PRESETS['captions.add'].apply(p, comp, {...src, ...style}));
      return `Added ${r.created.length} caption layers (${r.note ?? ''}): ${r.created.slice(0, 6).join(', ')}${r.created.length > 6 ? '…' : ''}`;
    },
  }),
  tool({
    name: 'map_tiles',
    description: 'Stitch a real map background image from a slippy-map tile provider (URL template with {z}/{x}/{y}) for a route or bounds, and return its bounds for preset map.route ({background: {src, bounds}}). The user must pick the provider and follow its licence and attribution rules (e.g. MapTiler/Mapbox with their key; OpenStreetMap tiles only for light use with "© OpenStreetMap contributors").',
    shape: {out: z.string().describe('Output .png path, relative to the project'), tiles: z.string(), route: z.array(z.tuple([z.number(), z.number()])).optional(), bounds: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]).optional(), size: z.tuple([z.number(), z.number()]).optional(), attribution: z.string().optional()},
    run: async (a, ctx) => {
      const {stitchMap} = await import('../render/tiles.js');
      const view = await stitchMap(writable(ctx, a.out), {tiles: a.tiles, route: a.route as [number, number][] | undefined, bounds: a.bounds as never, size: (a.size as [number, number]) ?? [1080, 1920], attribution: a.attribution});
      return `Saved ${a.out}. Background for map.route: ${JSON.stringify({src: a.out, bounds: view.bounds})}`;
    },
  }),
  tool({
    name: 'preset_list',
    annotations: READ_ONLY,
    project: false,
    description: 'List presets: text animators (text.*), kinetic typography (kinetic.*), openers (opener.*), slideshows (slides.*), transitions (transition.*), elements (element.*), graphic blocks (block.*), colour looks (grade.*) and the timeline builder (timeline.build), with their parameters.',
    shape: {},
    run: () => listPresets(),
  }),
  tool({
    name: 'preset_apply',
    description: 'Apply a preset to the project. See preset_list for names and params.',
    shape: {preset: z.string(), comp: z.string().optional(), params: z.record(z.string(), z.any()).optional()},
    run: (a, ctx) => {
      const preset = PRESETS[a.preset];
      if (!preset) throw new Error(`Unknown preset "${a.preset}". Use preset_list.`);
      const r = editProject(ctx.projectPath, (p) => preset.apply(p, a.comp, a.params ?? {}));
      return `${a.preset}: ${r.created.length ? `created ${r.created.join(', ')}` : 'applied'}${r.note ? `. ${r.note}` : ''}`;
    },
  }),
  tool({
    name: 'studio_open',
    description: 'Open DT.ly Studio (browser preview + timeline editor) for a project and return its URL. The human sees your edits live as you make them with the other tools, and can tweak the timeline themselves; their edits save to the same file. Call project_describe again after they say they changed something.',
    shape: {open: z.boolean().optional().describe('Also open it in the default browser (default true)'), port: z.number().optional()},
    run: async (a, ctx) => {
      const file = ctx.projectPath;
      let s = studios.get(file);
      if (!s) {
        const {startStudio} = await import('../studio/server.js');
        s = await startStudio({project: file, port: a.port ?? 0});
        studios.set(file, s);
      }
      if (a.open !== false) {
        const {spawn} = await import('node:child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawn(opener, [s.url], {stdio: 'ignore', detached: true}).unref();
      }
      return `DT.ly Studio for ${path.basename(file)}: ${s.url}`;
    },
  }),
  tool({
    name: 'render_frame',
    annotations: READ_ONLY,
    description: 'Render one frame and return it as an image so you can check layout, legibility and timing. Use scale ~0.4 for 1080x1920.',
    shape: {time: z.number(), comp: z.string().optional(), scale: z.number().optional()},
    run: async (a, ctx) => {
      const out = previewFile(ctx, `frame-${a.time.toFixed(3)}.png`);
      await renderStill(ctx.projectPath, a.time, out, {comp: a.comp, scale: a.scale ?? 0.4});
      return image(out);
    },
  }),
  tool({
    name: 'render_sheet',
    annotations: READ_ONLY,
    description: 'Render a contact sheet of several times in one image — the fastest way to review motion and pacing.',
    shape: {times: z.array(z.number()), comp: z.string().optional(), columns: z.number().optional()},
    run: async (a, ctx) => {
      const out = previewFile(ctx, `sheet-${Date.now()}.png`);
      await renderContactSheet(ctx.projectPath, a.times, out, {comp: a.comp, columns: a.columns, thumbWidth: 200});
      return image(out);
    },
  }),
  tool({
    name: 'render_video',
    description: 'Render the root comp (or a range) to MP4 with mixed audio. Roughly 2-4x real time on a laptop for 1080x1920.',
    shape: {out: z.string().describe('Output .mp4 path'), from: z.number().optional(), to: z.number().optional(), comp: z.string().optional(), workers: z.number().optional().describe('Parallel processes; only worth it for long videos (default 1)')},
    run: async (a, ctx) => {
      const t0 = Date.now();
      const out = writable(ctx, a.out);
      fs.mkdirSync(path.dirname(out), {recursive: true});
      const r = await renderVideoParallel(ctx.projectPath, out, a);
      return `Rendered ${r.out}: ${r.seconds.toFixed(2)}s, ${r.frames} frames, ${r.audioTracks} audio tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    },
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export const toolByName = (name: string): DtlyToolDef | undefined => byName.get(name);
