// DT.ly's shared tools (@dnyantra/dtly/tools, contracts.md §3) registered with the director. Only the
// project, look and preset tools are offered (D7): no project_create, studio_open, render_video (export is
// the app's job) or map_tiles (network). Mutating tools run through ProjectStore (staging + rev check).
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {dtlyRoot} from '../dtly.js';
import {projectFile} from '../projects.js';
import type {AgentToolDef, ToolOutput} from './agent.js';
import {findReadPaths, findWritePaths, PathRefused, type Guard} from './guard.js';
import type {ProjectStore} from './project-store.js';

interface DtlyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {readOnlyHint?: boolean};
  handler(input: unknown, ctx: {projectPath: string; allowRead(p: string): boolean; allowWrite?(p: string): boolean}): Promise<ToolOutput>;
}

export const DTLY_OFFERED = [
  'project_describe', 'project_validate', 'layer_get', 'comp_add', 'comp_update',
  'layer_add', 'layer_update', 'layer_remove', 'layer_move', 'layer_duplicate', 'layer_shift', 'property_set',
  'keyframe_set', 'keyframe_remove', 'keyframe_move', 'keyframe_ease', 'svg_import', 'captions_add',
  'preset_list', 'preset_apply', 'render_frame', 'render_sheet',
];
const READ_ONLY = new Set(['project_describe', 'project_validate', 'layer_get', 'preset_list', 'render_frame', 'render_sheet']);

let mod: Promise<{TOOLS: DtlyToolDef[]}> | undefined;
export const loadDtlyTools = () => (mod ??= import(pathToFileURL(path.join(dtlyRoot(), 'dist/tools/index.js')).href) as Promise<{TOOLS: DtlyToolDef[]}>);

export const dtlyTools = async (o: {dir: string; guard: Guard; store: ProjectStore}): Promise<AgentToolDef[]> => {
  const {TOOLS} = await loadDtlyTools();
  const ctx = (projectPath: string) => ({projectPath, allowRead: o.guard.allowRead, allowWrite: o.guard.allowWrite});
  return TOOLS.filter((t) => DTLY_OFFERED.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    async execute(input) {
      // Host-side guard (in addition to DT.ly's own allowRead/allowWrite checks).
      for (const p of findWritePaths(input)) o.guard.checkWrite(p);
      for (const p of findReadPaths(input)) if (!o.guard.allowRead(path.resolve(o.dir, p))) throw new PathRefused(p, false);
      if (READ_ONLY.has(t.name) || t.annotations?.readOnlyHint) return t.handler(input, ctx(projectFile(o.dir)));
      return o.store.mutate((stage) => t.handler(input, ctx(stage)));
    },
  }));
};
