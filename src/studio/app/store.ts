// Editor state: one project, history, autosave and live reload from disk.
import {useEffect, useState} from 'preact/hooks';
import {isAnimated, type Keyframe, type Layer, type Project} from '../../core/model.js';
import {config} from './config.js';

export interface KeySel { layer: string; path: string; t: number }
export interface State {
  project: Project | null;
  rev: number;
  comp: string;
  time: number;
  playing: boolean;
  loop: boolean;
  layer: string | null;
  key: KeySel | null;
  expanded: Record<string, boolean>;
  zoom: number; // timeline px per second
  status: 'loading' | 'saved' | 'saving' | 'error' | 'reloaded';
  message: string;
  warnings: string[];
  render: {active: boolean; done?: number; total?: number; out?: string; error?: string};
}

let state: State = {
  project: null, rev: 0, comp: 'main', time: 0, playing: false, loop: true, layer: null, key: null, expanded: {},
  zoom: 120, status: 'loading', message: '', warnings: [], render: {active: false},
};
const listeners = new Set<() => void>();
export const getState = () => state;
export const setState = (patch: Partial<State>) => {
  state = {...state, ...patch};
  listeners.forEach((l) => l());
};
export const useStore = <T,>(select: (s: State) => T): T => {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return select(state);
};

const api = (path: string, init: RequestInit = {}) =>
  fetch(path, {...init, headers: {'Content-Type': 'application/json', 'X-DTLY-Token': config.token, ...(init.headers ?? {})}});

// --- history -----------------------------------------------------------------------------
const undoStack: string[] = [];
const redoStack: string[] = [];
const MAX_HISTORY = 200;

let saveTimer: number | undefined;
const scheduleSave = () => {
  setState({status: 'saving'});
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 250);
};
const save = async () => {
  if (!state.project) return;
  try {
    const r = await api('/api/project', {method: 'PUT', body: JSON.stringify({project: state.project})});
    if (!r.ok) throw new Error(await r.text());
    const {rev, warnings} = (await r.json()) as {rev: number; warnings: string[]};
    setState({rev, warnings, status: 'saved', message: ''});
  } catch (e) {
    setState({status: 'error', message: `Save failed: ${(e as Error).message}`});
  }
};

// Apply an edit (usually a DT.ly op) to a copy of the project, as one undo step.
export const edit = (fn: (p: Project) => void) => {
  if (!state.project) return;
  const before = JSON.stringify(state.project);
  const next = JSON.parse(before) as Project;
  try {
    fn(next);
  } catch (e) {
    setState({message: (e as Error).message});
    return;
  }
  undoStack.push(before);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  setState({project: next, message: ''});
  scheduleSave();
};

// Drags re-apply from the snapshot on every move, then commit as a single undo step.
let dragBase: string | null = null;
export const dragStart = () => { dragBase = state.project ? JSON.stringify(state.project) : null; };
export const dragUpdate = (fn: (p: Project) => void) => {
  if (!dragBase) return;
  const next = JSON.parse(dragBase) as Project;
  try { fn(next); } catch { return; }
  setState({project: next});
};
export const dragEnd = () => {
  if (dragBase && JSON.stringify(state.project) !== dragBase) {
    undoStack.push(dragBase);
    redoStack.length = 0;
    scheduleSave();
  }
  dragBase = null;
};

export const undo = () => {
  const prev = undoStack.pop();
  if (!prev || !state.project) return;
  redoStack.push(JSON.stringify(state.project));
  setState({project: JSON.parse(prev)});
  scheduleSave();
};
export const redo = () => {
  const next = redoStack.pop();
  if (!next || !state.project) return;
  undoStack.push(JSON.stringify(state.project));
  setState({project: JSON.parse(next)});
  scheduleSave();
};

// --- loading & live reload ----------------------------------------------------------------
export const load = async (fromDisk = false) => {
  const r = await api('/api/project');
  const {rev, project} = (await r.json()) as {rev: number; project: Project};
  if (fromDisk && state.project) {
    undoStack.push(JSON.stringify(state.project)); // an external edit can be undone here too
    redoStack.length = 0;
  }
  const comp = project.comps.some((c) => c.id === state.comp) ? state.comp : project.root;
  const layer = state.layer && project.comps.some((c) => c.layers.some((l) => l.id === state.layer)) ? state.layer : null;
  setState({project, rev, comp, layer, key: layer ? state.key : null, status: fromDisk ? 'reloaded' : 'saved', message: fromDisk ? 'Reloaded: the file changed on disk' : ''});
};

export const connectEvents = () => {
  const es = new EventSource(`/api/events?token=${config.token}`);
  es.addEventListener('project', (e) => {
    const {rev} = JSON.parse((e as MessageEvent).data) as {rev: number};
    if (rev > state.rev) load(true);
  });
  es.addEventListener('render', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as {done?: number; total?: number; finished?: boolean; out?: string; error?: string; took?: number};
    if (d.error) setState({render: {active: false, error: d.error}});
    else if (d.finished) setState({render: {active: false, out: d.out}, message: `Rendered ${d.out} in ${d.took?.toFixed(1)}s`});
    else setState({render: {active: true, done: d.done, total: d.total}});
  });
};

export const startRender = async () => {
  setState({render: {active: true, done: 0}});
  const r = await api('/api/render', {method: 'POST', body: JSON.stringify({comp: state.comp})});
  if (!r.ok) setState({render: {active: false, error: await r.text()}});
};

// --- helpers --------------------------------------------------------------------------------
export const currentComp = () => state.project?.comps.find((c) => c.id === state.comp) ?? state.project?.comps[0];
export const selectedLayer = (): Layer | undefined => currentComp()?.layers.find((l) => l.id === state.layer);

// Every animated property on a layer, as dot paths ("transform.position", "effects.0.radius").
export const animatedPaths = (layer: Layer): {path: string; keyframes: Keyframe<unknown>[]}[] => {
  const out: {path: string; keyframes: Keyframe<unknown>[]}[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' && x !== null && walk(x, `${path}.${i}`));
    else if (typeof v === 'object' && v !== null) {
      if (isAnimated(v as never)) out.push({path, keyframes: (v as {keyframes: Keyframe<unknown>[]}).keyframes});
      else for (const [k, x] of Object.entries(v)) if (k !== 'animators') walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(layer, '');
  return out;
};

export const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);

export const snap = (t: number, fps: number) => Math.round(t * fps) / fps;
