// timeline.build: a shot list + music + voiceover → a finished main comp (the KK Park build.mjs as
// one preset). One precomp per shot (background clip with a slow push + its overlay blocks), cuts
// snapped to the music's beats, transitions, voiceover layers, music ducked under each line,
// a colour look and a logo watermark. Pure: voiceover durations are passed in (no ffprobe here).
import type {Ease, Layer, NewLayer, Project, Vec2} from '../core/model.js';
import {addComp, addLayer, getComp, OpError} from '../ops/ops.js';
import type {Preset} from './index.js';
import {PRESETS} from './index.js';

type Params = Record<string, unknown>;
const r3 = (t: number) => Math.round(t * 1000) / 1000;
const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export interface ShotSpec {
  id?: string;
  src: string;
  trimIn?: number;
  dur: number;
  speed?: number;
  still?: boolean;
  push?: number; // end scale of the slow push, percent (108 for clips, 112 for stills)
  crop?: {cx?: number; cy?: number; sourceSize?: Vec2};
  transition?: string; // transition INTO this shot
  overlay?: {block: string; params?: Params} | {block: string; params?: Params}[];
}
export type At = number | {shot: string | number; offset?: number};
export interface TimelineParams {
  shots: ShotSpec[];
  music?: {src: string; beats?: number[]; trimIn?: number; fadeIn?: number; fadeOut?: number};
  transitions?: string | string[];
  transitionDuration?: number;
  vo?: {src: string; duration: number; at: At; volume?: number}[];
  duck?: {lo?: number; hi?: number; attack?: number; release?: number};
  grade?: string | false | Params;
  watermark?: Params & {src: string; from?: At; to?: At};
  duration?: number;
  oversize?: number;
  snapWindow?: number;
  minShot?: number;
  brand?: Params;
}

/**
 * Shot start times with cuts snapped to beats (the KK Park build.mjs algorithm): each cut moves to the
 * beat nearest its nominal time + half a transition, minus half a transition (so the transition is
 * centred on the beat), if that is within `window` s of the nominal cut and leaves ≥ `minShot` s for
 * the previous shot.
 */
export const snapCuts = (durs: number[], beats: number[] | undefined, o: {td?: number; window?: number; minShot?: number} = {}) => {
  const td = o.td ?? 0.3, win = o.window ?? 0.3, min = o.minShot ?? 1.0;
  const nominal: number[] = [];
  durs.reduce((a, d) => (nominal.push(a), a + d), 0);
  const plan = [...nominal];
  if (!beats?.length) return plan;
  for (let i = 1; i < plan.length; i++) {
    const want = nominal[i] + td / 2;
    const b = beats.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best), beats[0]);
    const snapped = b - td / 2;
    if (Math.abs(snapped - nominal[i]) <= win && snapped - plan[i - 1] >= min) plan[i] = snapped;
  }
  return plan;
};

/** Music volume keyframes: `hi`, dipping to `lo` under each voiceover span (overlapping dips merge). */
export const duckKeys = (spans: [number, number][], o: {lo?: number; hi?: number; attack?: number; release?: number} = {}) => {
  const lo = o.lo ?? 0.2, hi = o.hi ?? 0.55, atk = o.attack ?? 0.25, rel = o.release ?? 0.35;
  const merged: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a - atk <= last[1] + rel) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const k: [number, number][] = [[0, hi]];
  for (const [a, b] of merged) k.push([Math.max(0, a - atk), hi], [a, lo], [b, lo], [b + rel, hi]);
  const vol: [number, number][] = [];
  for (const [t, v] of k) if (!vol.length || t > vol[vol.length - 1][0] + 0.01) vol.push([r3(t), v]);
  return vol;
};

const freeCompId = (p: Project, base: string) => {
  let id = base, i = 2;
  while (p.comps.some((c) => c.id === id)) id = `${base}-${i++}`;
  return id;
};

export const TIMELINE_PRESETS: Record<string, Preset> = {
  'timeline.build': {
    kind: 'timeline',
    description: 'Builds a whole reel in one call: one precomp per shot (clip with a slow push + its overlay blocks), cuts snapped to the music beats (within 0.3 s, at least 1 s per shot), transitions centred on the cuts, voiceover layers, music ducked under each line, a colour look and a logo watermark. Refine afterwards with layer tools.',
    params: '{shots: [{id?, src, trimIn?: s, dur: s on screen (before snapping), speed?, still?: boolean, push?: % (108), crop?: {cx?, cy?: 0-1 framing centre, sourceSize: [w,h]}, transition?: type into this shot, overlay?: {block: "block.*" preset, params} or a list (applied in order, later on top)}], music?: {src, beats?: number[] (from a .beats.json), trimIn?, fadeIn? (0.1), fadeOut? (2)}, transitions?: type or list cycled per cut (see transition.between; default "crossfade"), transitionDuration?: s (0.3), vo?: [{src, duration: s (measure it; presets do not probe files), at: {shot: id or index, offset: s} or seconds, volume? (1)}], duck?: {lo? (0.2), hi? (0.55), attack? (0.25), release? (0.35)}, grade?: look name for grade.look ("punch") or {look, …} or false, watermark?: {src, from?: at (default shot 2), to?: at (default last shot + 0.2 s), position?, size?, aspect?}, duration?: s (default: sum of shot durs), oversize?: clip size factor (1.1, as segment_prepare makes them), snapWindow? (0.3), minShot? (1.0), brand?: passed to every overlay block}',
    apply: (p, compId, raw) => {
      const o = raw as unknown as TimelineParams;
      const main = getComp(p, compId);
      const shots = Array.isArray(o.shots) ? o.shots : [];
      if (!shots.length) throw new OpError('timeline.build needs shots: [{src, dur}, …]');
      shots.forEach((s, i) => { if (!s?.src || !(s.dur > 0)) throw new OpError(`shot ${i + 1}: needs src and dur > 0`); });
      const W = main.width, H = main.height;
      const TD = num(o.transitionDuration, 0.3), os = num(o.oversize, 1.1);
      const ids = shots.map((s, i) => s.id ?? `shot${i + 1}`);
      if (new Set(ids).size !== ids.length) throw new OpError('timeline.build: shot ids must be unique');
      const plan = snapCuts(shots.map((s) => s.dur), o.music?.beats, {td: TD, window: o.snapWindow, minShot: o.minShot});
      const DUR = r3(num(o.duration, plan[plan.length - 1] + shots[shots.length - 1].dur));
      if (DUR <= plan[plan.length - 1]) throw new OpError(`timeline.build: duration ${DUR}s ends before the last shot starts (${r3(plan[plan.length - 1])}s)`);
      const startOf = (s: string | number) => {
        const i = typeof s === 'number' ? s : ids.indexOf(s);
        if (i < 0 || i >= plan.length) throw new OpError(`timeline.build: no shot "${s}"`);
        return plan[i];
      };
      const at = (a: At | undefined, d: number) => (a === undefined ? d : typeof a === 'number' ? a : startOf(a.shot) + (a.offset ?? 0));
      const brand = o.brand ? {brand: o.brand} : {};
      const created: string[] = [];
      const warnings: string[] = [];

      main.duration = DUR;
      main.markers = [...(main.markers ?? []).filter((m) => !ids.includes(m.label)), ...plan.map((t, i) => ({t: r3(t), label: ids[i]}))].sort((a, b) => a.t - b.t);

      // One precomp per shot: the clip with a slow push, overlay blocks on top.
      const layerIds: string[] = [];
      shots.forEach((s, i) => {
        const last = i === shots.length - 1;
        const len = last ? DUR - plan[i] : plan[i + 1] - plan[i];
        const compDur = r3(len + (last ? 0 : TD));
        const cid = freeCompId(p, `c-${ids[i]}`);
        addComp(p, {id: cid, name: ids[i], width: W, height: H, fps: main.fps, duration: compDur, background: '#000000'});
        const still = s.still ?? /\.(png|jpe?g|webp|gif)$/i.test(s.src);
        const push = num(s.push, still ? 112 : 108);
        const k = 1 / os;
        const plate: Record<string, unknown> = {type: still ? 'image' : 'video', name: 'bg', src: s.src, fit: 'cover', size: [r3(W * os), r3(H * os)],
          ...(still ? {} : {volume: 0, ...(s.trimIn ? {trimIn: s.trimIn} : {}), ...(s.speed && s.speed !== 1 ? {speed: s.speed} : {})}),
          transform: {scale: kf<Vec2>([0, [r3(100 * k), r3(100 * k)], 'linear'], [compDur, [r3(push * k), r3(push * k)]])}};
        if (s.crop && (s.crop.cx !== undefined || s.crop.cy !== undefined)) {
          if (!s.crop.sourceSize) warnings.push(`${ids[i]}: crop needs sourceSize [w,h]; centred instead`);
          else {
            const [sw, sh] = s.crop.sourceSize, bw = W * os, bh = H * os;
            const f = Math.max(bw / sw, bh / sh), dw = sw * f, dh = sh * f;
            const ax = Math.min(dw - bw / 2, Math.max(bw / 2, (s.crop.cx ?? 0.5) * dw)), ay = Math.min(dh - bh / 2, Math.max(bh / 2, (s.crop.cy ?? 0.5) * dh));
            plate.size = [r3(dw), r3(dh)];
            (plate.transform as Record<string, unknown>).anchor = [r3(ax), r3(ay)];
            (plate.transform as Record<string, unknown>).position = [W / 2, H / 2];
          }
        }
        addLayer(p, cid, plate as NewLayer, 0);
        const overlays = s.overlay ? (Array.isArray(s.overlay) ? s.overlay : [s.overlay]) : [];
        for (const ov of overlays) {
          const preset = PRESETS[ov.block];
          if (!preset) throw new OpError(`shot ${ids[i]}: unknown overlay block "${ov.block}". Use preset_list.`);
          preset.apply(p, cid, {...brand, ...(ov.params ?? {})});
        }
        const id = addLayer(p, main.id, {type: 'precomp', id: freeLayerId(p, `shot-${ids[i]}`), comp: cid, inPoint: r3(plan[i]), outPoint: r3(last ? DUR : plan[i + 1] + TD)} as NewLayer, 0).id;
        layerIds.push(id);
      });
      created.push(...layerIds);

      // Transitions, centred on the snapped cuts.
      const types = o.transitions === undefined ? ['crossfade'] : Array.isArray(o.transitions) ? o.transitions : [o.transitions];
      for (let i = 1; i < shots.length; i++) {
        const type = shots[i].transition ?? types[(i - 1) % types.length] ?? 'crossfade';
        if (type === 'cut' || type === 'none') continue;
        PRESETS['transition.between'].apply(p, main.id, {from: layerIds[i - 1], to: layerIds[i], type, duration: TD});
      }

      // Look and watermark above everything.
      if (o.grade !== false && o.grade !== undefined) {
        const g = typeof o.grade === 'string' ? {look: o.grade} : o.grade;
        created.push(...PRESETS['grade.look'].apply(p, main.id, {...g, index: 0}).created);
      }
      if (o.watermark?.src) {
        const {from, to, ...wm} = o.watermark;
        const a = at(from, shots.length > 1 ? plan[1] : 0), b = at(to, shots.length > 1 ? plan[plan.length - 1] + 0.2 : DUR);
        created.push(...PRESETS['block.watermark'].apply(p, main.id, {...wm, from: r3(a), to: r3(b), index: 0}).created);
      }

      // Voiceover and ducked music at the bottom of the stack.
      const spans: [number, number][] = [];
      (o.vo ?? []).forEach((v, i) => {
        if (!v?.src || !(v.duration > 0)) throw new OpError(`vo ${i + 1}: needs src and duration > 0 (measure the file; presets don't probe)`);
        const a = at(v.at, 0);
        spans.push([a, a + v.duration]);
        if (i && a < spans[i - 1][1]) warnings.push(`vo ${i + 1} overlaps vo ${i}`);
        if (a + v.duration > DUR) warnings.push(`vo ${i + 1} runs past the end`);
        created.push(addLayer(p, main.id, {type: 'audio', id: freeLayerId(p, `vo-${i + 1}`), src: v.src, inPoint: r3(a), outPoint: r3(a + v.duration), volume: num(v.volume, 1)} as NewLayer, main.layers.length).id);
      });
      if (o.music?.src) {
        const hi = num(o.duck?.hi, 0.55);
        const vol = spans.length ? kf(...duckKeys(spans, o.duck).map(([t, v]) => [t, v, 'linear'] as [number, number, Ease])) : hi;
        created.push(addLayer(p, main.id, {type: 'audio', id: freeLayerId(p, 'music'), src: o.music.src, trimIn: num(o.music.trimIn, 0), inPoint: 0, outPoint: DUR,
          volume: vol, fadeIn: num(o.music.fadeIn, 0.1), fadeOut: num(o.music.fadeOut, 2.0)} as NewLayer, main.layers.length).id);
      }

      const snapped = plan.filter((t, i) => i > 0 && Math.abs(t - shots.slice(0, i).reduce((a, s) => a + s.dur, 0)) > 1e-9).length;
      return {created, note: `${shots.length} shots, ${DUR}s, ${snapped}/${shots.length - 1} cuts on the beat. Cuts: ${plan.map((t, i) => `${ids[i]}@${t.toFixed(2)}`).join(' ')}${warnings.length ? `. Warnings: ${warnings.join('; ')}` : ''}`};
    },
  },
};

const freeLayerId = (p: Project, base: string) => {
  const ids = new Set(p.comps.flatMap((c) => c.layers.map((l: Layer) => l.id)));
  let id = base, i = 2;
  while (ids.has(id)) id = `${base}-${i++}`;
  return id;
};
