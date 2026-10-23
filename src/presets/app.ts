// App-promo presets: a phone mockup that tilts in 3D, and a cursor / finger that moves and taps.
import type {Ease, NewLayer, Vec2} from '../core/model.js';
import {addComp, addLayer, getComp, uniqueId} from '../ops/ops.js';
import type {Preset} from './index.js';

const r3 = (t: number) => Math.round(t * 1000) / 1000;
const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});
const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

const ARROW = 'M0 0 L0 34 L9 26 L15 40 L21 37 L15 24 L27 24 Z';
const FINGER = 'M14 0 C18 0 20 3 20 7 L20 24 C22 22 27 22 29 25 C31 23 36 24 37 28 C39 27 44 28 44 33 L44 48 C44 58 37 66 27 66 L22 66 C16 66 12 63 9 58 L1 44 C-1 40 2 36 6 38 L8 40 L8 7 C8 3 10 0 14 0 Z';

export const APP_PRESETS: Record<string, Preset> = {
  'element.phoneMockup': {
    kind: 'element',
    description: 'Phone mockup around a screenshot or screen recording (image or video), tilted in 3D and settling flat — for app and website promos.',
    params: '{src: image or video path (the screen), position?: [x,y], height?: px (default 70% of comp), start?, duration?: s (tilt-in), from?: [rotateX, rotateY] (default [18,-28]), to?: [rx, ry] (default [0,0]), body?: colour, trimIn?, speed?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const H = Math.round(n(o.height, comp.height * 0.7)), W = Math.round(H * 0.49);
      const bezel = Math.round(W * 0.045), radius = Math.round(W * 0.16);
      const sw = W - bezel * 2, sh = H - bezel * 2;
      const t0 = n(o.start, 0), dur = n(o.duration, 1.4);
      const id = uniqueId(p, s(o.name, 'phone'));
      const src = s(o.src, '');
      const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(src);
      addComp(p, {id, name: id, width: W, height: H, duration: comp.duration, fps: comp.fps});
      const inner: NewLayer[] = [
        {type: 'shape', name: 'sheen', shape: 'rect', size: [sw, sh], radius: radius - bezel, transform: {position: [W / 2, H / 2], opacity: 35}, blendMode: 'screen',
          fill: {linear: {from: [-sw / 2, -sh / 2], to: [sw / 2, sh / 2], stops: [[0, '#ffffff55'], [0.35, '#ffffff00'], [1, '#ffffff00']]}}} as NewLayer,
        {type: 'shape', name: 'notch', shape: 'rect', size: [Math.round(W * 0.28), Math.round(W * 0.075)], radius: Math.round(W * 0.04), fill: '#0b0b0d', transform: {position: [W / 2, bezel + Math.round(W * 0.06)]}} as NewLayer,
        {type: isVideo ? 'video' : 'image', name: 'screen', src, size: [sw, sh], fit: 'cover', transform: {position: [W / 2, H / 2]},
          masks: [{shape: 'rect', rect: [0, 0, sw, sh], radius: radius - bezel}], ...(isVideo ? {trimIn: n(o.trimIn, 0), speed: n(o.speed, 1)} : {})} as NewLayer,
        {type: 'shape', name: 'body', shape: 'rect', size: [W, H], radius, fill: s(o.body, '#16171b'), stroke: '#3a3d44', strokeWidth: Math.max(2, Math.round(W * 0.006)), transform: {position: [W / 2, H / 2]}} as NewLayer,
      ];
      for (const l of [...inner].reverse()) addLayer(p, id, l, 0);
      const [fx, fy] = (o.from as Vec2) ?? [18, -28], [tx, ty] = (o.to as Vec2) ?? [0, 0];
      const layer = addLayer(p, compId, {
        type: 'precomp', name: id, comp: id, inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]},
        effects: [
          {type: 'tilt', rotateX: kf([t0, fx, 'expoOut'], [t0 + dur, tx]), rotateY: kf([t0, fy, 'expoOut'], [t0 + dur, ty]), perspective: H * 2.2},
          {type: 'dropShadow', blur: 60, distance: 30, angle: 160, opacity: 55},
        ],
      } as NewLayer, 0);
      return {created: [layer.id], note: `Phone comp "${id}" (${W}×${H}); its "screen" layer holds ${src || 'your image/video'} — open the comp to adjust`};
    },
  },

  'element.cursor': {
    kind: 'element',
    description: 'Mouse pointer or finger that glides between points and taps, with a ripple on each tap — for app, website and UI demos.',
    params: '{points: [{t: s, x, y, tap?: boolean}], style?: "pointer"|"finger"|"dot", size?: px, color?, rippleColor?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const pts = ((o.points as {t: number; x: number; y: number; tap?: boolean}[]) ?? []).sort((a, b) => a.t - b.t);
      if (!pts.length) throw new Error('cursor needs points: [{t, x, y, tap?}]');
      const style = s(o.style, 'pointer'), size = n(o.size, Math.round(comp.width / 10));
      const created: string[] = [];
      const position = {keyframes: pts.map((pt, i) => ({t: r3(pt.t), v: [pt.x, pt.y] as Vec2, ...(i < pts.length - 1 ? {ease: 'easyEase' as Ease} : {})}))};
      const scaleK: [number, Vec2, Ease?][] = [];
      for (const pt of pts.filter((q) => q.tap)) scaleK.push([pt.t, [100, 100], 'easeIn'], [pt.t + 0.08, [82, 82], 'backOut'], [pt.t + 0.28, [100, 100]]);
      const inP = Math.max(0, pts[0].t - 0.3);
      const common = {inPoint: r3(inP), effects: [{type: 'dropShadow', blur: 10, distance: 4, opacity: 45}]};
      let layer: NewLayer;
      if (style === 'dot') layer = {type: 'shape', name: s(o.name, 'cursor'), shape: 'ellipse', size: [size * 0.6, size * 0.6], fill: s(o.color, '#ffffffdd'), stroke: '#00000055', strokeWidth: 2, transform: {position, ...(scaleK.length ? {scale: kf(...scaleK)} : {}), opacity: kf([inP, 0], [inP + 0.25, 100])}, ...common} as NewLayer;
      else {
        const path = style === 'finger' ? FINGER : ARROW, k = style === 'finger' ? size / 66 : size / 40;
        layer = {type: 'shape', name: s(o.name, 'cursor'), shape: 'path', path, fill: s(o.color, '#ffffff'), stroke: '#111111', strokeWidth: 2.2, lineJoin: 'round',
          transform: {anchor: style === 'finger' ? [14, 2] : [1, 1], position, scale: scaleK.length ? kf(...scaleK.map(([t, v, e]) => [t, [v[0] * k, v[1] * k] as Vec2, e] as [number, Vec2, Ease?])) : [k * 100, k * 100], opacity: kf([inP, 0], [inP + 0.25, 100])}, ...common} as NewLayer;
        if (!scaleK.length) (layer.transform as {scale: Vec2}).scale = [k * 100, k * 100];
      }
      const c = addLayer(p, compId, layer, 0);
      created.push(c.id);
      pts.filter((q) => q.tap).forEach((pt, i) => {
        const r = addLayer(p, compId, {type: 'shape', name: `tap-${i + 1}`, shape: 'ellipse', size: [size * 1.6, size * 1.6], stroke: s(o.rippleColor, '#ffffff'), strokeWidth: 4, fill: `${s(o.rippleColor, '#ffffff')}33`,
          inPoint: r3(pt.t), outPoint: r3(pt.t + 0.6), transform: {position: [pt.x, pt.y], scale: kf<Vec2>([pt.t, [10, 10], 'cubicOut'], [pt.t + 0.55, [100, 100]]), opacity: kf([pt.t, 90], [pt.t + 0.55, 0])}} as NewLayer, 1);
        created.push(r.id);
      });
      return {created};
    },
  },
};
