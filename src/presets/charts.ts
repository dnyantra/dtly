// Infographic presets: bar, line, donut and progress charts, and number counters.
// Every chart is a group (null) of ordinary layers, so bars, lines, values and labels stay editable.
import type {Ease, NewLayer, Project, TextLayer, Vec2} from '../core/model.js';
import {addLayer, getComp} from '../ops/ops.js';
import type {Preset} from './index.js';

type Params = Record<string, unknown>;
type Datum = {label?: string; value: number; color?: string};
const PALETTE = ['#E8692A', '#FFC93C', '#4DA3FF', '#5FB3A0', '#C78BC0', '#E5534B', '#9BD35A', '#F28FB0'];
const r3 = (t: number) => Math.round(t * 1000) / 1000;
const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});
const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const fmtOf = (o: Params): TextLayer['format'] => ({prefix: o.prefix as string | undefined, suffix: o.suffix as string | undefined, decimals: o.decimals as number | undefined, locale: o.locale as string | undefined});

// Adds layers in stacking order (first = top) and returns their ids.
const build = (p: Project, compId: string | undefined, group: NewLayer, parts: NewLayer[]) => {
  const g = addLayer(p, compId, group, 0);
  const ids = [g.id];
  [...parts].reverse().forEach((l) => ids.push(addLayer(p, compId, {...l, parent: g.id} as NewLayer, 1).id));
  return ids;
};
const data = (o: Params): Datum[] => ((o.data as Datum[]) ?? []).map((d) => (typeof d === 'number' ? {value: d} : d));

export const CHART_PRESETS: Record<string, Preset> = {
  'chart.bar': {
    kind: 'chart',
    description: 'Bar chart: bars grow from the baseline one after another while their values count up; labels underneath.',
    params: '{data: [{label, value, color?}], position?: [x,y] (centre), size?: [w,h], start?: s, duration?: s, stagger?: s, color?, colors?: string[], max?, prefix?, suffix?, decimals?, locale? (en-IN), textColor?, showValues?: true, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const d = data(o), t0 = n(o.start, 0), dur = n(o.duration, 0.9), stg = n(o.stagger, 0.12);
      const [W, H] = (o.size as Vec2) ?? [comp.width * 0.8, comp.height * 0.3];
      const max = n(o.max, Math.max(...d.map((x) => x.value), 1));
      const gap = W / Math.max(1, d.length), barW = gap * 0.62, base = H / 2;
      const fs = Math.round(Math.min(gap * 0.32, comp.width / 22));
      const text = s(o.textColor, '#ffffff');
      const parts: NewLayer[] = [{type: 'shape', name: 'axis', shape: 'line', points: [[-W / 2, base], [W / 2, base]], stroke: text, strokeWidth: 3, transform: {anchor: [0, 0], position: [0, 0], opacity: 60}, inPoint: t0, trim: {end: kf([t0, 0, 'expoOut'], [t0 + 0.6, 100])}} as NewLayer];
      d.forEach((x, i) => {
        const h = (x.value / max) * H, cx = -W / 2 + gap * (i + 0.5), ts = t0 + 0.2 + i * stg;
        const color = x.color ?? (o.colors as string[] | undefined)?.[i] ?? s(o.color, PALETTE[i % PALETTE.length]);
        parts.push({type: 'shape', name: `bar-${i + 1}`, shape: 'rect', size: [barW, h], radius: Math.min(12, barW / 6), fill: color, inPoint: t0,
          transform: {anchor: [0, h / 2], position: [cx, base], scale: kf<Vec2>([ts, [100, 0], 'expoOut'], [ts + dur, [100, 100]])}} as NewLayer);
        if (o.showValues !== false) parts.push({type: 'text', name: `value-${i + 1}`, text: '{value}', value: kf([ts, 0, 'expoOut'], [ts + dur, x.value]), format: fmtOf(o), size: fs, weight: 800, color: text, inPoint: t0,
          transform: {position: [cx, base - h - fs * 0.8], opacity: kf([ts, 0], [ts + 0.25, 100])}} as NewLayer);
        if (x.label) parts.push({type: 'text', name: `label-${i + 1}`, text: x.label, size: Math.round(fs * 0.8), weight: 600, color: text, inPoint: t0, maxWidth: gap * 0.95,
          transform: {position: [cx, base + fs * 0.95]}, animators: [{unit: 'line', delay: ts - t0, duration: 0.5, ease: 'cubicOut', from: {opacity: 0, y: 20}}]} as NewLayer);
      });
      return {created: build(p, compId, {type: 'null', name: s(o.name, 'bar-chart'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]}} as NewLayer, parts)};
    },
  },

  'chart.line': {
    kind: 'chart',
    description: 'Line chart: a smooth line draws on across the points, dots pop in as it passes them, an area fill fades in underneath.',
    params: '{data: [{label?, value}] or numbers, position?, size?: [w,h], start?, duration?, color?, area?: true, showValues?: false, prefix?, suffix?, decimals?, locale?, textColor?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const d = data(o), t0 = n(o.start, 0), dur = n(o.duration, 1.6), color = s(o.color, PALETTE[0]), text = s(o.textColor, '#ffffff');
      const [W, H] = (o.size as Vec2) ?? [comp.width * 0.8, comp.height * 0.28];
      const max = n(o.max, Math.max(...d.map((x) => x.value), 1)), min = n(o.min, Math.min(0, ...d.map((x) => x.value)));
      const pts: Vec2[] = d.map((x, i) => [-W / 2 + (W * i) / Math.max(1, d.length - 1), H / 2 - ((x.value - min) / (max - min || 1)) * H]);
      // Catmull-Rom → cubic bezier for a smooth line through every point.
      let path = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
        path += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
      }
      const fs = Math.round(comp.width / 30);
      const parts: NewLayer[] = [];
      pts.forEach((pt, i) => {
        const ts = t0 + (dur * i) / Math.max(1, pts.length - 1);
        parts.push({type: 'shape', name: `dot-${i + 1}`, shape: 'ellipse', size: [22, 22], fill: '#ffffff', stroke: color, strokeWidth: 6, inPoint: t0,
          transform: {position: pt, scale: kf<Vec2>([ts - 0.05, [0, 0], 'backOut'], [ts + 0.35, [100, 100]])}} as NewLayer);
        if (o.showValues) parts.push({type: 'text', name: `value-${i + 1}`, text: '{value}', value: d[i].value, format: fmtOf(o), size: fs, weight: 800, color: text, inPoint: r3(ts),
          transform: {position: [pt[0], pt[1] - fs * 1.1]}, animators: [{unit: 'line', duration: 0.4, ease: 'backOut', from: {opacity: 0, scale: 50}}]} as NewLayer);
        if (d[i].label) parts.push({type: 'text', name: `label-${i + 1}`, text: d[i].label!, size: Math.round(fs * 0.8), weight: 600, color: text, inPoint: t0,
          transform: {position: [pt[0], H / 2 + fs * 1.2], opacity: kf([ts - 0.1, 0], [ts + 0.2, 70])}} as NewLayer);
      });
      parts.push({type: 'shape', name: 'line', shape: 'path', path, stroke: color, strokeWidth: 8, transform: {anchor: [0, 0], position: [0, 0]}, inPoint: t0,
        trim: {end: kf([t0, 0, 'easyEase'], [t0 + dur, 100])}} as NewLayer);
      if (o.area !== false) parts.push({type: 'shape', name: 'area', shape: 'path', path: `${path} L${pts[pts.length - 1][0]} ${H / 2} L${pts[0][0]} ${H / 2} Z`, inPoint: t0,
        fill: {linear: {from: [0, -H / 2], to: [0, H / 2], stops: [[0, `${color}88`], [1, `${color}00`]]}}, transform: {anchor: [0, 0], position: [0, 0]},
        // Revealed left to right in step with the line drawing on.
        masks: [{shape: 'rect', rect: kf<[number, number, number, number]>([t0, [-W / 2 - 10, -H, 0, H * 2], 'easyEase'], [t0 + dur, [-W / 2 - 10, -H, W + 20, H * 2]])}]} as NewLayer);
      parts.push({type: 'shape', name: 'axis', shape: 'line', points: [[-W / 2, H / 2], [W / 2, H / 2]], stroke: text, strokeWidth: 3, inPoint: t0, transform: {anchor: [0, 0], position: [0, 0], opacity: 50}, trim: {end: kf([t0, 0, 'expoOut'], [t0 + 0.6, 100])}} as NewLayer);
      return {created: build(p, compId, {type: 'null', name: s(o.name, 'line-chart'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]}} as NewLayer, parts)};
    },
  },

  'chart.donut': {
    kind: 'chart',
    description: 'Donut / pie chart: segments sweep round one after another; the centre shows the total (or a title) and a legend lists each part.',
    params: '{data: [{label, value, color?}], position?, diameter?, thickness? (diameter/2 = pie), start?, duration?, stagger?, centerText?: string | "total", prefix?, suffix?, decimals?, locale?, legend?: true, textColor?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const d = data(o), t0 = n(o.start, 0), dur = n(o.duration, 0.8), stg = n(o.stagger, 0.25), text = s(o.textColor, '#ffffff');
      const D = n(o.diameter, comp.width * 0.55), th = Math.min(n(o.thickness, D * 0.18), D / 2);
      const total = d.reduce((a, x) => a + x.value, 0) || 1;
      const parts: NewLayer[] = [];
      let acc = 0;
      d.forEach((x, i) => {
        const a0 = (acc / total) * 100, a1 = ((acc + x.value) / total) * 100, ts = t0 + i * stg;
        acc += x.value;
        parts.push({type: 'shape', name: `segment-${i + 1}`, shape: 'ellipse', size: [D - th, D - th], stroke: x.color ?? PALETTE[i % PALETTE.length], strokeWidth: th, lineCap: 'butt', inPoint: t0,
          trim: {start: a0, end: kf([ts, a0, 'cubicOut'], [ts + dur, a1])}, transform: {position: [0, 0]}} as NewLayer);
      });
      const centre = o.centerText ?? 'total';
      if (centre && th < D / 2) parts.unshift(centre === 'total'
        ? {type: 'text', name: 'total', text: '{value}', value: kf([t0, 0, 'expoOut'], [t0 + stg * d.length + dur, total]), format: fmtOf(o), size: Math.round(D * 0.16), weight: 800, color: text, inPoint: t0, transform: {position: [0, 0]}} as NewLayer
        : {type: 'text', name: 'center', text: String(centre), size: Math.round(D * 0.12), weight: 800, color: text, inPoint: t0, maxWidth: D - th * 2.2, transform: {position: [0, 0]}, animators: [{unit: 'word', stagger: 0.08, duration: 0.5, ease: 'backOut', from: {opacity: 0, scale: 60}}]} as NewLayer);
      if (o.legend !== false) {
        const fs = Math.round(comp.width / 30), rowH = fs * 1.6;
        d.forEach((x, i) => {
          const y = D / 2 + fs * 2 + i * rowH, ts = t0 + i * stg;
          parts.push({type: 'shape', name: `legend-dot-${i + 1}`, shape: 'ellipse', size: [fs * 0.7, fs * 0.7], fill: x.color ?? PALETTE[i % PALETTE.length], inPoint: t0, transform: {position: [-D * 0.42, y], opacity: kf([ts, 0], [ts + 0.3, 100])}} as NewLayer);
          parts.push({type: 'text', name: `legend-${i + 1}`, text: `${x.label ?? `Part ${i + 1}`}  ·  ${Math.round((x.value / total) * 100)}%`, size: fs, weight: 600, align: 'left', color: text, inPoint: t0,
            transform: {position: [-D * 0.42 + fs, y]}, animators: [{unit: 'line', delay: ts - t0, duration: 0.5, ease: 'cubicOut', from: {opacity: 0, x: -30}}]} as NewLayer);
        });
      }
      return {created: build(p, compId, {type: 'null', name: s(o.name, 'donut-chart'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height * 0.42]}} as NewLayer, parts)};
    },
  },

  'chart.progress': {
    kind: 'chart',
    description: 'Progress ring (or bar) that fills to a percentage while the number counts up in the middle.',
    params: '{value: 0-100, style?: "ring"|"bar", label?, position?, diameter? (ring) | size?: [w,h] (bar), thickness?, start?, duration?, color?, trackColor?, textColor?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const v = n(o.value, 75), t0 = n(o.start, 0), dur = n(o.duration, 1.4), color = s(o.color, PALETTE[0]), track = s(o.trackColor, '#ffffff22'), text = s(o.textColor, '#ffffff');
      const parts: NewLayer[] = [];
      if (o.style === 'bar') {
        const [W, H] = (o.size as Vec2) ?? [comp.width * 0.75, 36];
        parts.push({type: 'text', name: 'percent', text: '{value}', value: kf([t0, 0, 'expoOut'], [t0 + dur, v]), format: {suffix: '%'}, size: Math.round(H * 1.6), weight: 800, align: 'right', color: text, inPoint: t0, transform: {position: [W / 2, -H * 1.6]}} as NewLayer);
        if (o.label) parts.push({type: 'text', name: 'label', text: String(o.label), size: Math.round(H * 1.1), weight: 600, align: 'left', color: text, inPoint: t0, transform: {position: [-W / 2, -H * 1.6]}} as NewLayer);
        parts.push({type: 'shape', name: 'fill', shape: 'rect', size: [W, H], radius: H / 2, fill: color, inPoint: t0, transform: {anchor: [-W / 2, 0], position: [-W / 2, 0], scale: kf<Vec2>([t0, [0, 100], 'expoOut'], [t0 + dur, [v, 100]])}} as NewLayer);
        parts.push({type: 'shape', name: 'track', shape: 'rect', size: [W, H], radius: H / 2, fill: track, inPoint: t0, transform: {position: [0, 0]}} as NewLayer);
      } else {
        const D = n(o.diameter, comp.width * 0.5), th = n(o.thickness, D * 0.09);
        parts.push({type: 'text', name: 'percent', text: '{value}', value: kf([t0, 0, 'expoOut'], [t0 + dur, v]), format: {suffix: '%'}, size: Math.round(D * 0.24), weight: 800, color: text, inPoint: t0, transform: {position: [0, o.label ? -D * 0.05 : 0]}} as NewLayer);
        if (o.label) parts.push({type: 'text', name: 'label', text: String(o.label), size: Math.round(D * 0.08), weight: 600, color: text, inPoint: t0, maxWidth: D * 0.7, transform: {position: [0, D * 0.15]}} as NewLayer);
        parts.push({type: 'shape', name: 'ring', shape: 'ellipse', size: [D, D], stroke: color, strokeWidth: th, inPoint: t0, trim: {end: kf([t0, 0, 'expoOut'], [t0 + dur, v])}, transform: {position: [0, 0]}} as NewLayer);
        parts.push({type: 'shape', name: 'track', shape: 'ellipse', size: [D, D], stroke: track, strokeWidth: th, inPoint: t0, transform: {position: [0, 0]}} as NewLayer);
      }
      return {created: build(p, compId, {type: 'null', name: s(o.name, 'progress'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]}} as NewLayer, parts)};
    },
  },

  'element.counter': {
    kind: 'element',
    description: 'A big number that counts up (₹4,999 · 10,000+ customers · 98%), with an optional caption under it.',
    params: '{to: number, from?: 0, start?, duration?, prefix?, suffix?, decimals?, locale? (en-IN groups as 1,00,000), label?, size?, color?, labelColor?, position?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      const t0 = n(o.start, 0), dur = n(o.duration, 1.5), size = n(o.size, Math.round(comp.width / 6));
      const parts: NewLayer[] = [{type: 'text', name: 'number', text: '{value}', value: kf([t0, n(o.from, 0), 'expoOut'], [t0 + dur, n(o.to, 100)]), format: fmtOf(o), size, weight: 800, color: s(o.color, '#ffffff'), inPoint: t0,
        transform: {position: [0, 0], scale: kf<Vec2>([t0, [70, 70], 'backOut'], [t0 + 0.5, [100, 100]])}, animators: [{unit: 'line', duration: 0.3, from: {opacity: 0}}]} as NewLayer];
      if (o.label) parts.push({type: 'text', name: 'caption', text: String(o.label), size: Math.round(size * 0.32), weight: 600, color: s(o.labelColor, '#ffffffcc'), inPoint: t0, maxWidth: comp.width * 0.8,
        transform: {position: [0, size * 0.85]}, animators: [{unit: 'word', delay: 0.3, stagger: 0.06, duration: 0.5, ease: 'cubicOut', from: {opacity: 0, y: 24}}]} as NewLayer);
      return {created: build(p, compId, {type: 'null', name: s(o.name, 'counter'), inPoint: t0, transform: {position: (o.position as Vec2) ?? [comp.width / 2, comp.height / 2]}} as NewLayer, parts)};
    },
  },
};
