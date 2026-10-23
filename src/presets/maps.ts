// Map presets: an animated route from real coordinates, with pins, labels and a travelling marker.
import {distanceKm, fitView, viewToPx, type LatLon, type MapView} from '../core/geo.js';
import type {Ease, NewLayer, Vec2} from '../core/model.js';
import {pointAt, parsePath} from '../core/path.js';
import {addLayer, getComp} from '../ops/ops.js';
import type {Preset} from './index.js';

const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const r3 = (t: number) => Math.round(t * 1000) / 1000;
const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});
const PIN = 'M0 0 C-6 -10 -18 -16 -18 -28 C-18 -38 -10 -46 0 -46 C10 -46 18 -38 18 -28 C18 -16 6 -10 0 0 Z';

export const MAP_PRESETS: Record<string, Preset> = {
  'map.route': {
    kind: 'map',
    description: 'Animated map route from real coordinates: the path draws on, a marker travels along it, start/end pins drop in with labels. Optional real map background (see `dtly map-tiles`).',
    params: '{route: [[lat, lon], ...], labels?: string[] (one per point, "" to skip), start?, duration?, color?, width?, dashed?: boolean, smooth?: true, marker?: "dot"|"pin"|"none", background?: {src, bounds: [[latNW, lonNW], [latSE, lonSE]]}, size?: [w,h], position?, pinColor?, labelColor?, showDistance?: boolean, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const route = (o.route as LatLon[]) ?? [];
      if (route.length < 2) throw new Error('map.route needs at least two [lat, lon] points');
      const bg = o.background as {src: string; bounds: [LatLon, LatLon]} | undefined;
      const [W, H] = (o.size as Vec2) ?? [comp.width, comp.height];
      const toPx = bg ? viewToPx({bounds: bg.bounds, size: [W, H]} as MapView) : fitView(route, W, H).toPx;
      const pts = route.map((ll) => { const [x, y] = toPx(ll); return [x - W / 2, y - H / 2] as Vec2; });
      const t0 = n(o.start, 0), dur = n(o.duration, 3), color = s(o.color, '#E8692A'), lw = n(o.width, Math.round(comp.width / 90));
      let d = `M${pts[0][0]} ${pts[0][1]}`;
      if (o.smooth !== false && pts.length > 2) {
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
          d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
        }
      } else for (const q of pts.slice(1)) d += ` L${q[0]} ${q[1]}`;
      const created: string[] = [];
      const group = addLayer(p, compId, {type: 'null', name: s(o.name, 'route'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]}} as NewLayer, 0);
      created.push(group.id);
      const groupIndex = getComp(p, compId).layers.indexOf(group);
      // Parts are added top-down, each directly below the previous one.
      const add = (l: NewLayer) => created.push(addLayer(p, compId, {...l, parent: group.id} as NewLayer, groupIndex + created.length).id);
      const labels = (o.labels as string[]) ?? [];
      const fs = Math.round(comp.width / 26);
      // Pins and labels at each named stop (top of stack, added first).
      pts.forEach((pt, i) => {
        const isEnd = i === 0 || i === pts.length - 1;
        if (!isEnd && !labels[i]) return;
        const at = t0 + (i === 0 ? 0 : (dur * i) / (pts.length - 1));
        if (labels[i]) add({type: 'text', name: `label-${i + 1}`, text: labels[i], size: fs, weight: 800, color: s(o.labelColor, '#ffffff'), inPoint: r3(at),
          box: {color: '#000000aa', padding: [Math.round(fs * 0.45), Math.round(fs * 0.2)], radius: Math.round(fs * 0.3)},
          transform: {position: [pt[0], pt[1] - fs * 2.6]}, animators: [{unit: 'line', duration: 0.4, ease: 'backOut', from: {opacity: 0, y: 30, scale: 80}}]} as NewLayer);
        add({type: 'shape', name: `pin-${i + 1}`, shape: 'path', path: PIN, fill: i === pts.length - 1 ? s(o.pinColor, color) : '#ffffff', stroke: '#00000066', strokeWidth: 2,
          inPoint: r3(at), transform: {anchor: [0, 0], position: pt, scale: kf<Vec2>([at, [0, 0], 'backOut'], [at + 0.45, [100 * fs / 30, 100 * fs / 30]])},
          effects: [{type: 'dropShadow', blur: 8, distance: 4, opacity: 40}]} as NewLayer);
      });
      // Travelling marker: position keyframes sampled along the path, in step with the draw-on.
      if (o.marker !== 'none') {
        const path = parsePath(d), N = 40;
        const keys = Array.from({length: N + 1}, (_, k) => ({t: r3(t0 + (dur * k) / N), v: pointAt(path, k / N).p}));
        add({type: 'shape', name: 'marker', shape: 'ellipse', size: [lw * 2.6, lw * 2.6], fill: '#ffffff', stroke: color, strokeWidth: lw * 0.6, inPoint: t0, outPoint: r3(t0 + dur + 0.2),
          transform: {position: {keyframes: keys}}, effects: [{type: 'glow', color, radius: 18, strength: 70}]} as NewLayer);
      }
      add({type: 'shape', name: 'route-line', shape: 'path', path: d, stroke: color, strokeWidth: lw, ...(o.dashed ? {dash: [lw * 2, lw * 1.6], lineCap: 'butt'} : {}), inPoint: t0,
        transform: {anchor: [0, 0], position: [0, 0]}, trim: {end: kf([t0, 0, 'linear'], [t0 + dur, 100])}} as NewLayer);
      add({type: 'shape', name: 'route-casing', shape: 'path', path: d, stroke: '#00000055', strokeWidth: lw * 1.9, inPoint: t0,
        transform: {anchor: [0, 0], position: [0, 0]}, trim: {end: kf([t0, 0, 'linear'], [t0 + dur, 100])}} as NewLayer);
      if (o.showDistance) {
        const km = route.slice(1).reduce((a, q, i) => a + distanceKm(route[i], q), 0);
        add({type: 'text', name: 'distance', text: '{value}', value: kf([t0, 0], [t0 + dur, Math.round(km)]), format: {suffix: ' km'}, size: Math.round(fs * 1.4), weight: 800, color: s(o.labelColor, '#ffffff'), inPoint: t0,
          box: {color: '#000000aa', padding: [fs * 0.5, fs * 0.25], radius: fs * 0.3}, transform: {position: [0, H / 2 - fs * 4]}} as NewLayer);
      }
      if (bg) add({type: 'image', name: 'map', src: bg.src, size: [W, H], fit: 'fill', inPoint: t0, transform: {position: [0, 0], anchor: [W / 2, H / 2]}} as NewLayer);
      return {created, note: bg ? 'Route drawn over the map image' : 'No background: add a map image (dtly map-tiles) or a solid underneath'};
    },
  },
};
