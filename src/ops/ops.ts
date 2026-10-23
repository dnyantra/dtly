// Document operations: the fine-grained edits agents (via MCP) and tools make to a project.
// Every op is a pure-ish mutation of a Project object; IO lives in ./store.ts.
import {isAnimated, type Composition, type Ease, type Keyframe, type Layer, type NewLayer, type Project} from '../core/model.js';
import {importSvg, type SvgImportOptions} from '../core/svg.js';

export class OpError extends Error {}

export const newProject = (o: {name: string; width?: number; height?: number; fps?: number; duration?: number; background?: string}): Project => ({
  dtly: 1,
  name: o.name,
  root: 'main',
  comps: [{id: 'main', name: 'Main', width: o.width ?? 1080, height: o.height ?? 1920, fps: o.fps ?? 30, duration: o.duration ?? 10, background: o.background ?? '#000000', layers: []}],
});

export const getComp = (p: Project, id?: string): Composition => {
  const c = p.comps.find((c) => c.id === (id ?? p.root));
  if (!c) throw new OpError(`No composition "${id}". Comps: ${p.comps.map((c) => c.id).join(', ')}`);
  return c;
};

export const findLayer = (p: Project, layerId: string): {comp: Composition; layer: Layer; index: number} => {
  for (const comp of p.comps) {
    const index = comp.layers.findIndex((l) => l.id === layerId);
    if (index >= 0) return {comp, layer: comp.layers[index], index};
  }
  throw new OpError(`No layer "${layerId}"`);
};

const allIds = (p: Project) => new Set(p.comps.flatMap((c) => c.layers.map((l) => l.id)));
export const uniqueId = (p: Project, base: string) => {
  const ids = allIds(p);
  const clean = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'layer';
  if (!ids.has(clean)) return clean;
  let i = 2;
  while (ids.has(`${clean}-${i}`)) i++;
  return `${clean}-${i}`;
};

export const addComp = (p: Project, c: Partial<Composition> & {id: string}) => {
  if (p.comps.some((x) => x.id === c.id)) throw new OpError(`Composition "${c.id}" already exists`);
  const root = getComp(p);
  const comp: Composition = {width: root.width, height: root.height, fps: root.fps, duration: root.duration, layers: [], ...c};
  p.comps.push(comp);
  return comp;
};

export const updateComp = (p: Project, id: string, patch: Partial<Omit<Composition, 'id' | 'layers'>>) => {
  Object.assign(getComp(p, id), patch);
};

// Adds a layer. index 0 = top of the stack (After Effects order).
export const addLayer = (p: Project, compId: string | undefined, layer: NewLayer, index = 0): Layer => {
  const comp = getComp(p, compId);
  const id = layer.id ? (allIds(p).has(layer.id) ? (() => { throw new OpError(`Layer id "${layer.id}" already used`); })() : layer.id) : uniqueId(p, (layer as Layer).name ?? layer.type);
  const full = {...layer, id} as Layer;
  comp.layers.splice(Math.max(0, Math.min(index, comp.layers.length)), 0, full);
  return full;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Deep merge; `null` deletes a key. Arrays and keyframe objects are replaced wholesale.
export const deepMerge = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (isPlainObject(v) && isPlainObject(target[k]) && !('keyframes' in v)) deepMerge(target[k] as Record<string, unknown>, v);
    else target[k] = v;
  }
  return target;
};

export const updateLayer = (p: Project, layerId: string, patch: Record<string, unknown>) => {
  if ('id' in patch) throw new OpError('Cannot change a layer id; duplicate it instead');
  const {layer} = findLayer(p, layerId);
  deepMerge(layer as unknown as Record<string, unknown>, patch);
  return layer;
};

export const removeLayer = (p: Project, layerId: string) => {
  const {comp, index} = findLayer(p, layerId);
  comp.layers.splice(index, 1);
  for (const c of p.comps) for (const l of c.layers) {
    if (l.parent === layerId) delete l.parent;
    if (l.matte?.layer === layerId) delete l.matte;
  }
};

export const moveLayer = (p: Project, layerId: string, toIndex: number) => {
  const {comp, index, layer} = findLayer(p, layerId);
  comp.layers.splice(index, 1);
  comp.layers.splice(Math.max(0, Math.min(toIndex, comp.layers.length)), 0, layer);
};

// Visits every keyframe list inside a value (for shifting/scaling time).
const eachKeyframes = (v: unknown, fn: (kfs: Keyframe<unknown>[]) => void) => {
  if (Array.isArray(v)) v.forEach((x) => eachKeyframes(x, fn));
  else if (isPlainObject(v)) {
    if (Array.isArray(v.keyframes)) fn(v.keyframes as Keyframe<unknown>[]);
    Object.values(v).forEach((x) => eachKeyframes(x, fn));
  }
};

// Slides a layer in time: in/out points and all its keyframes (like dragging the bar in AE).
export const shiftLayer = (p: Project, layerId: string, delta: number) => {
  const {layer} = findLayer(p, layerId);
  if (layer.inPoint !== undefined || delta) layer.inPoint = (layer.inPoint ?? 0) + delta;
  if (layer.outPoint !== undefined) layer.outPoint += delta;
  eachKeyframes(layer, (kfs) => kfs.forEach((k) => (k.t = +(k.t + delta).toFixed(4))));
};

export const duplicateLayer = (p: Project, layerId: string, opts: {newId?: string; timeShift?: number} = {}) => {
  const {comp, index, layer} = findLayer(p, layerId);
  const copy = structuredClone(layer);
  copy.id = opts.newId ?? uniqueId(p, layer.id);
  comp.layers.splice(index, 0, copy);
  if (opts.timeShift) shiftLayer(p, copy.id, opts.timeShift);
  return copy;
};

// Property paths: "transform.position", "trim.end", "box.reveal", "effects.0.radius", "size".
const splitPath = (path: string) => path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
const getAt = (obj: unknown, path: string) => splitPath(path).reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string | number, unknown>)[k]), obj);
const setAt = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = splitPath(path);
  let o: Record<string | number, unknown> = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null) o[k] = typeof keys[i + 1] === 'number' ? [] : {};
    o = o[k] as Record<string | number, unknown>;
  });
  o[keys[keys.length - 1]] = value;
};

const TIME_EPS = 1e-3;

export const setProperty = (p: Project, layerId: string, path: string, value: unknown) => {
  const {layer} = findLayer(p, layerId);
  setAt(layer as unknown as Record<string, unknown>, path, value);
};

// Adds or replaces the keyframe at time t. A static property becomes animated
// (its current value is kept as a keyframe at the layer's inPoint, like AE's stopwatch).
export const setKeyframe = (p: Project, layerId: string, path: string, t: number, v: unknown, ease?: Ease) => {
  const {layer} = findLayer(p, layerId);
  const cur = getAt(layer, path);
  let kfs: Keyframe<unknown>[];
  if (isAnimated(cur as never)) kfs = (cur as {keyframes: Keyframe<unknown>[]}).keyframes;
  else {
    kfs = [];
    const anchorT = layer.inPoint ?? 0;
    if (cur !== undefined && Math.abs(anchorT - t) > TIME_EPS) kfs.push({t: anchorT, v: cur});
    setAt(layer as unknown as Record<string, unknown>, path, {keyframes: kfs});
  }
  const existing = kfs.find((k) => Math.abs(k.t - t) < TIME_EPS);
  if (existing) {
    existing.v = v;
    if (ease !== undefined) existing.ease = ease;
  } else kfs.push(ease !== undefined ? {t, v, ease} : {t, v});
  kfs.sort((a, b) => a.t - b.t);
  return kfs;
};

export const removeKeyframe = (p: Project, layerId: string, path: string, t: number) => {
  const {layer} = findLayer(p, layerId);
  const cur = getAt(layer, path) as {keyframes: Keyframe<unknown>[]} | undefined;
  if (!cur || !isAnimated(cur as never)) throw new OpError(`${layerId}.${path} is not animated`);
  const i = cur.keyframes.findIndex((k) => Math.abs(k.t - t) < TIME_EPS);
  if (i < 0) throw new OpError(`No keyframe at ${t}s on ${layerId}.${path}`);
  cur.keyframes.splice(i, 1);
  // One keyframe left = a static value again (AE behaviour when you delete down to one).
  if (cur.keyframes.length === 1 && !(cur as {wiggle?: unknown}).wiggle) setAt(layer as unknown as Record<string, unknown>, path, cur.keyframes[0].v);
};

// Retimes one keyframe, keeping its value and ease (dragging a key in the timeline).
export const moveKeyframe = (p: Project, layerId: string, path: string, from: number, to: number) => {
  const {layer} = findLayer(p, layerId);
  const cur = getAt(layer, path) as {keyframes: Keyframe<unknown>[]} | undefined;
  const k = cur?.keyframes?.find((k) => Math.abs(k.t - from) < TIME_EPS);
  if (!cur || !k) throw new OpError(`No keyframe at ${from}s on ${layerId}.${path}`);
  const target = Math.round(to * 1000) / 1000;
  if (cur.keyframes.some((x) => x !== k && Math.abs(x.t - target) < TIME_EPS)) throw new OpError(`There is already a keyframe at ${target}s`);
  k.t = target;
  cur.keyframes.sort((a, b) => a.t - b.t);
};

export const setEase = (p: Project, layerId: string, path: string, t: number, ease: Ease) => {
  const {layer} = findLayer(p, layerId);
  const cur = getAt(layer, path) as {keyframes: Keyframe<unknown>[]} | undefined;
  const k = cur?.keyframes?.find((k) => Math.abs(k.t - t) < TIME_EPS);
  if (!k) throw new OpError(`No keyframe at ${t}s on ${layerId}.${path}`);
  k.ease = ease;
};

// Adds an SVG as a group (null layer) of editable shape layers parented to it.
export const addSvg = (p: Project, compId: string | undefined, svg: string, opts: SvgImportOptions = {}) => {
  const {layers, size, parts} = importSvg(svg, opts);
  const [group, ...shapes] = layers;
  const g = addLayer(p, compId, group, 0);
  // Insert the parts below the group's position so their stacking matches the SVG.
  const ids = shapes.reverse().map((l) => addLayer(p, compId, {...l, parent: g.id} as NewLayer, 1).id);
  return {group: g.id, parts, size, ids};
};

// Static checks an agent should run before rendering.
export const validate = (p: Project): string[] => {
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const c of p.comps) {
    for (const l of c.layers) {
      if (ids.has(l.id)) warnings.push(`Duplicate layer id "${l.id}"`);
      ids.add(l.id);
      const inP = l.inPoint ?? 0, outP = l.outPoint ?? c.duration;
      if (outP <= inP) warnings.push(`${c.id}/${l.id}: outPoint (${outP}) is not after inPoint (${inP})`);
      if (inP >= c.duration) warnings.push(`${c.id}/${l.id}: starts after the comp ends (${c.duration}s)`);
      if (l.parent && !c.layers.some((x) => x.id === l.parent)) warnings.push(`${c.id}/${l.id}: parent "${l.parent}" not in the same comp`);
      if (l.matte && !c.layers.some((x) => x.id === l.matte!.layer)) warnings.push(`${c.id}/${l.id}: matte "${l.matte.layer}" not in the same comp`);
      if (l.type === 'precomp' && !p.comps.some((x) => x.id === l.comp)) warnings.push(`${c.id}/${l.id}: unknown comp "${l.comp}"`);
      eachKeyframes(l, (kfs) => {
        if (kfs.length === 0) warnings.push(`${c.id}/${l.id}: empty keyframe list`);
        kfs.forEach((k) => { if (k.t < 0 || k.t > c.duration + 1) warnings.push(`${c.id}/${l.id}: keyframe at ${k.t}s is outside the comp`); });
      });
    }
  }
  if (!p.comps.some((c) => c.id === p.root)) warnings.push(`Root comp "${p.root}" does not exist`);
  return warnings;
};

// Compact, agent-readable outline of the project.
export const describe = (p: Project): string => {
  const lines = [`Project "${p.name}" — root: ${p.root}`];
  for (const c of p.comps) {
    lines.push(`\nComp ${c.id}${c.name ? ` (${c.name})` : ''}: ${c.width}x${c.height} @${c.fps}fps, ${c.duration}s, bg ${c.background ?? 'transparent'}`);
    if (c.markers?.length) lines.push(`  markers: ${c.markers.map((m) => `${m.t}s ${m.label}`).join(', ')}`);
    c.layers.forEach((l, i) => {
      const animated: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (isPlainObject(v)) {
          if (Array.isArray(v.keyframes)) animated.push(`${path}@[${(v.keyframes as Keyframe<unknown>[]).map((k) => k.t).join(',')}]`);
          else Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
        } else if (Array.isArray(v)) v.forEach((x, j) => isPlainObject(x) && walk(x, `${path}.${j}`));
      };
      walk(l, '');
      const extra =
        l.type === 'text' ? ` "${l.text.replace(/\n/g, ' / ').slice(0, 60)}"${l.animators?.length ? ` animators:${l.animators.map((a) => a.unit).join('+')}` : ''}`
        : l.type === 'video' || l.type === 'image' || l.type === 'audio' || l.type === 'lottie' ? ` ${l.src}`
        : l.type === 'precomp' ? ` → ${l.comp}`
        : l.type === 'shape' ? ` ${l.shape}` : '';
      lines.push(`  [${i}] ${l.id} (${l.type})${extra} ${l.inPoint ?? 0}–${l.outPoint ?? c.duration}s${l.parent ? ` parent:${l.parent}` : ''}${l.matte ? ` matte:${l.matte.layer}` : ''}${l.hidden ? ' hidden' : ''}${animated.length ? `\n      animated: ${animated.join('  ')}` : ''}`);
    });
  }
  return lines.join('\n');
};
