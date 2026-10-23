// Preset catalogue: text animators, kinetic typography, openers, slides and transitions.
// Each preset edits a project through the same ops an agent uses, and returns what it created.
import type {Ease, NewLayer, Project, Vec2} from '../core/model.js';
import {addLayer, findLayer, getComp, OpError, setKeyframe, updateLayer} from '../ops/ops.js';
import {TEXT_ANIMATORS} from './text.js';

type Params = Record<string, unknown>;
export interface Preset {
  kind: 'text' | 'kinetic' | 'opener' | 'slides' | 'transition' | 'element';
  description: string;
  params: string; // human-readable parameter reference
  apply: (p: Project, comp: string | undefined, params: Params) => {created: string[]; note?: string};
}

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const r3 = (t: number) => Math.round(t * 1000) / 1000;
const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});

export const PRESETS: Record<string, Preset> = {};

for (const [name, def] of Object.entries(TEXT_ANIMATORS)) {
  PRESETS[`text.${name}`] = {
    kind: 'text',
    description: def.description,
    params: '{layer: textLayerId, delay?: s, stagger?: s, duration?: s, replace?: boolean}',
    apply: (p, _comp, o) => {
      const {layer} = findLayer(p, str(o.layer, ''));
      if (layer.type !== 'text') throw new OpError(`${layer.id} is not a text layer`);
      const anims = def.animators.map((a) => ({...a, ...(o.delay !== undefined && {delay: num(o.delay, 0)}), ...(o.stagger !== undefined && {stagger: num(o.stagger, 0)}), ...(o.duration !== undefined && {duration: num(o.duration, 0.5)})}));
      layer.animators = o.replace === false ? [...(layer.animators ?? []), ...anims] : [...(layer.animators ?? []).filter((a) => (a.mode === 'out') !== (anims[0].mode === 'out')), ...anims];
      return {created: [], note: `Applied ${name} to ${layer.id}`};
    },
  };
}

PRESETS['kinetic.sequence'] = {
  kind: 'kinetic',
  description: 'Classic kinetic typography: phrases appear one after another in the same spot, each with its own entrance, emphasis words bigger and coloured.',
  params: '{phrases: string[], start?: s, each?: s (default by length), position?: [x,y], size?: px, color?, accent?: color, emphasis?: string[] (words to highlight), style?: "slam"|"popIn"|"fadeUp"|"blurIn"|"cascade", font?, maxWidth?, holdLast?: boolean (default true: last phrase stays to the end of the comp)}',
  apply: (p, compId, o) => {
    const comp = getComp(p, compId);
    const phrases = (o.phrases as string[]) ?? [];
    const pos = (o.position as Vec2) ?? [comp.width / 2, comp.height / 2];
    const size = num(o.size, Math.round(comp.width / 9));
    const style = str(o.style, 'slam');
    const emphasis = new Set(((o.emphasis as string[]) ?? []).map((w) => w.toLowerCase()));
    let t = num(o.start, 0);
    const created: string[] = [];
    const holdLast = o.holdLast !== false;
    phrases.forEach((text, i) => {
      const words = text.split(/\s+/).length;
      const each = num(o.each, Math.max(0.7, 0.35 + words * 0.32));
      const last = holdLast && i === phrases.length - 1;
      const outPoint = last ? Math.max(comp.duration, t + each) : t + each;
      const isEmph = text.split(/\s+/).some((w) => emphasis.has(w.toLowerCase()));
      const layer = addLayer(p, comp.id, {
        type: 'text', name: `kinetic-${i + 1}`, text, inPoint: r3(t), outPoint: r3(outPoint),
        size: isEmph ? Math.round(size * 1.35) : size, weight: 800, font: o.font as string | undefined,
        color: isEmph ? str(o.accent, '#FFC93C') : str(o.color, '#ffffff'), maxWidth: num(o.maxWidth, comp.width * 0.86),
        transform: {position: pos, scale: kf<Vec2>([t, [100, 100]], [outPoint, [100 + 8 * ((outPoint - t) / each), 100 + 8 * ((outPoint - t) / each)]])},
        animators: [...TEXT_ANIMATORS[style in TEXT_ANIMATORS ? style : 'slam'].animators, ...(last ? [] : [{unit: 'word' as const, mode: 'out' as const, stagger: 0.03, duration: 0.18, ease: 'easeIn' as const, from: {opacity: 0, scale: 80}}])],
      } as NewLayer);
      created.push(layer.id);
      t = r3(t + each);
    });
    return {created, note: `Sequence ends at ${t.toFixed(2)}s`};
  },
};

PRESETS['opener.logoReveal'] = {
  kind: 'opener',
  description: 'Brand opener: a ring draws on and bursts, the title tracks in, an accent line draws, and a tagline reveals from a mask.',
  params: '{title: string, tagline?: string, start?: s, color?: brand colour, accent?: colour, textColor?, position?: [x,y], size?: px, font?}',
  apply: (p, compId, o) => {
    const comp = getComp(p, compId);
    const t0 = num(o.start, 0);
    const [cx, cy] = (o.position as Vec2) ?? [comp.width / 2, comp.height / 2];
    const color = str(o.color, '#E8692A'), accent = str(o.accent, '#FFC93C');
    const size = num(o.size, Math.round(comp.width / 7.5));
    const r = Math.min(comp.width, comp.height) * 0.42;
    const created: string[] = [];
    const add = (l: NewLayer) => created.push(addLayer(p, comp.id, l).id);
    add({type: 'shape', name: 'reveal-ring', shape: 'ellipse', size: [r, r], stroke: color, strokeWidth: 10, inPoint: t0, outPoint: t0 + 1.6, motionBlur: {samples: 8},
      transform: {position: [cx, cy], rotation: kf([t0, -120, 'expoOut'], [t0 + 1, 0]), scale: kf<Vec2>([t0 + 0.7, [100, 100], 'expoOut'], [t0 + 1.4, [260, 260]]), opacity: kf([t0 + 0.9, 100], [t0 + 1.4, 0])},
      trim: {end: kf([t0, 0, 'expoOut'], [t0 + 0.8, 100])}} as NewLayer);
    add({type: 'shape', name: 'reveal-burst', shape: 'ellipse', size: [r * 0.9, r * 0.9], fill: color, inPoint: t0 + 0.7, outPoint: t0 + 1.5,
      transform: {position: [cx, cy], scale: kf<Vec2>([t0 + 0.7, [0, 0], 'expoOut'], [t0 + 1.2, [220, 220]]), opacity: kf([t0 + 0.9, 90], [t0 + 1.5, 0])}} as NewLayer);
    add({type: 'text', name: 'opener-title', text: str(o.title, 'TITLE'), size, weight: 800, color: str(o.textColor, '#ffffff'), font: o.font as string | undefined, inPoint: t0 + 0.8,
      maxWidth: comp.width * 0.88, transform: {position: [cx, cy]},
      animators: [{unit: 'grapheme', stagger: 0.025, duration: 1.1, ease: 'expoOut', from: {opacity: 0, tracking: 40, blur: 10}}],
      effects: [{type: 'dropShadow', blur: 30, distance: 0, opacity: 50}]} as NewLayer);
    add({type: 'shape', name: 'opener-line', shape: 'line', points: [[-comp.width * 0.3, 0], [comp.width * 0.3, 0]], stroke: accent, strokeWidth: 8, inPoint: t0 + 1.2,
      transform: {position: [cx, cy + size * 0.85]}, trim: {start: kf([t0 + 1.2, 50, 'expoOut'], [t0 + 1.9, 0]), end: kf([t0 + 1.2, 50, 'expoOut'], [t0 + 1.9, 100])}} as NewLayer);
    if (o.tagline) add({type: 'text', name: 'opener-tagline', text: str(o.tagline, ''), size: Math.round(size * 0.42), weight: 600, color: accent, font: o.font as string | undefined, inPoint: t0 + 1.5,
      transform: {position: [cx, cy + size * 1.4]}, animators: [{unit: 'line', clip: true, stagger: 0.1, duration: 0.8, ease: 'expoOut', from: {y: size * 0.6}}]} as NewLayer);
    return {created, note: `Opener settles at ${(t0 + 2.3).toFixed(1)}s`};
  },
};

PRESETS['opener.bars'] = {
  kind: 'opener',
  description: 'Coloured bars sweep across the frame in a stagger, uncovering a title that slams in.',
  params: '{title: string, start?: s, colors?: string[], textColor?, size?: px, font?, direction?: "left"|"right"}',
  apply: (p, compId, o) => {
    const comp = getComp(p, compId);
    const t0 = num(o.start, 0);
    const colors = (o.colors as string[]) ?? ['#E8692A', '#FFC93C', '#F6EEDF', '#1A1512'];
    const dir = o.direction === 'right' ? -1 : 1;
    const barH = comp.height / colors.length;
    const created: string[] = [];
    colors.forEach((c, i) => {
      const ts = t0 + i * 0.08;
      created.push(addLayer(p, comp.id, {type: 'solid', name: `bar-${i + 1}`, color: c, size: [comp.width, barH + 2], inPoint: t0, outPoint: t0 + 1.6,
        transform: {anchor: [0, 0], position: kf<Vec2>([ts, [-comp.width * dir, i * barH], 'expoInOut'], [ts + 0.6, [0, i * barH], 'expoInOut'], [ts + 0.85, [0, i * barH], 'expoInOut'], [ts + 1.4, [comp.width * dir, i * barH]])}} as NewLayer).id);
    });
    created.unshift(addLayer(p, comp.id, {type: 'text', name: 'bars-title', text: str(o.title, 'TITLE'), size: num(o.size, Math.round(comp.width / 8)), weight: 800, color: str(o.textColor, '#ffffff'),
      font: o.font as string | undefined, inPoint: t0 + 0.9, maxWidth: comp.width * 0.88,
      animators: TEXT_ANIMATORS.slam.animators}, 0).id);
    return {created};
  },
};

PRESETS['slides.slideshow'] = {
  kind: 'slides',
  description: 'Slider/slideshow from images and clips: each slide gets a slow Ken Burns move, an optional caption, and a transition into the next.',
  params: '{items: [{src, type?: "image"|"video", caption?, trimIn?, speed?}], start?: s, each?: s, transition?: type or list of types cycled per cut ("push"|"crossfade"|"zoom"|"wipe"|"whip"|"slideUp"), transitionDuration?: s, captionStyle?: text preset name, captionColor?, captionY?: px, plate?: colour, fitComp?: boolean (default true: comp duration = slideshow end)}',
  apply: (p, compId, o) => {
    const comp = getComp(p, compId);
    const items = (o.items as {src: string; type?: string; caption?: string; trimIn?: number; speed?: number}[]) ?? [];
    const each = num(o.each, 3), td = num(o.transitionDuration, 0.5), t0 = num(o.start, 0);
    const created: string[] = [];
    const ids: string[] = [];
    items.forEach((it, i) => {
      const start = t0 + i * (each - td);
      const end = start + each;
      const type = it.type ?? (/\.(mp4|mov|webm|m4v)$/i.test(it.src) ? 'video' : 'image');
      const zoomIn = i % 2 === 0;
      const layer = addLayer(p, comp.id, {
        type, name: `slide-${i + 1}`, src: it.src, inPoint: +start.toFixed(3), outPoint: +end.toFixed(3),
        ...(type === 'video' ? {trimIn: it.trimIn ?? 0, speed: it.speed ?? 1} : {}),
        transform: {scale: kf<Vec2>([start, zoomIn ? [104, 104] : [118, 118]], [end, zoomIn ? [118, 118] : [104, 104]])},
      } as NewLayer, comp.layers.length);
      ids.push(layer.id);
      created.push(layer.id);
      if (it.caption) {
        created.push(addLayer(p, comp.id, {type: 'text', name: `caption-${i + 1}`, text: it.caption, size: Math.round(comp.width / 15), weight: 800, color: str(o.captionColor, '#ffffff'),
          inPoint: +(start + td * 0.6).toFixed(3), outPoint: +(end - td).toFixed(3), maxWidth: comp.width * 0.84,
          transform: {position: [comp.width / 2, num(o.captionY, comp.height * 0.78)]},
          box: o.plate ? {color: str(o.plate, '#000000'), padding: [32, 16], radius: 18, reveal: kf([start + td * 0.6, 0, 'expoOut'], [start + td * 0.6 + 0.5, 100])} : undefined,
          shadow: o.plate ? undefined : {color: 'rgba(0,0,0,0.7)', blur: 18, y: 4},
          animators: [...TEXT_ANIMATORS[str(o.captionStyle, 'fadeUp')]?.animators ?? TEXT_ANIMATORS.fadeUp.animators, ...TEXT_ANIMATORS.fadeOutDown.animators]} as NewLayer, 0).id);
      }
    });
    // Transitions between consecutive slides.
    const types = Array.isArray(o.transition) ? (o.transition as string[]) : [str(o.transition, 'push')];
    for (let i = 1; i < ids.length; i++) PRESETS['transition.between'].apply(p, comp.id, {from: ids[i - 1], to: ids[i], type: types[(i - 1) % types.length], duration: td});
    const end = r3(t0 + items.length * (each - td) + td);
    if (o.fitComp !== false) comp.duration = end;
    return {created, note: `Slideshow ends at ${end}s${o.fitComp !== false ? ' (comp duration set to match)' : ''}`};
  },
};

PRESETS['transition.between'] = {
  kind: 'transition',
  description: 'Animates two overlapping layers (clips, images or precomps) so one hands over to the other at the overlap.',
  params: '{from: layerId (outgoing), to: layerId (incoming, must start before `from` ends), type: "push"|"crossfade"|"zoom"|"wipe"|"whip"|"slideUp", duration?: s}',
  apply: (p, compId, o) => {
    const a = findLayer(p, str(o.from, '')), b = findLayer(p, str(o.to, ''));
    const comp = a.comp;
    const d = num(o.duration, 0.5);
    const t1 = b.layer.inPoint ?? 0, t2 = t1 + d;
    const W = comp.width, H = comp.height;
    const center: Vec2 = [W / 2, H / 2];
    const type = str(o.type, 'push');
    const pos = (id: string, ...k: [number, Vec2, Ease?][]) => k.forEach(([t, v, e]) => setKeyframe(p, id, 'transform.position', t, v, e));
    // Incoming must sit above the outgoing layer for overlays like wipe/crossfade.
    if (b.index > a.index) { comp.layers.splice(b.index, 1); comp.layers.splice(a.index, 0, b.layer); }
    switch (type) {
      case 'crossfade':
        setKeyframe(p, b.layer.id, 'transform.opacity', t1, 0, 'easyEase'); setKeyframe(p, b.layer.id, 'transform.opacity', t2, 100);
        break;
      case 'zoom':
        setKeyframe(p, a.layer.id, 'transform.opacity', t1, 100, 'easeIn'); setKeyframe(p, a.layer.id, 'transform.opacity', t2, 0);
        updateLayer(p, a.layer.id, {effects: [...(a.layer.effects ?? []), {type: 'blur', radius: kf([t1, 0, 'easeIn'], [t2, 25])}]});
        setKeyframe(p, b.layer.id, 'transform.opacity', t1, 0, 'easeOut'); setKeyframe(p, b.layer.id, 'transform.opacity', t2, 100);
        break;
      case 'wipe':
        updateLayer(p, b.layer.id, {masks: [{shape: 'rect', rect: kf<[number, number, number, number]>([t1, [0, 0, 0, H], 'expoInOut'], [t2, [0, 0, W * 1.2, H]])}]});
        break;
      case 'slideUp':
        pos(a.layer.id, [t1, center, 'expoInOut'], [t2, [W / 2, -H / 2]]);
        pos(b.layer.id, [t1, [W / 2, H * 1.5], 'expoInOut'], [t2, center]);
        break;
      case 'whip':
        pos(a.layer.id, [t1, center, 'expoIn'], [t2, [-W / 2, H / 2]]);
        pos(b.layer.id, [t1, [W * 1.5, H / 2], 'expoOut'], [t2, center]);
        for (const id of [a.layer.id, b.layer.id]) updateLayer(p, id, {motionBlur: {samples: 12, shutter: 360}});
        break;
      default: // push
        pos(a.layer.id, [t1, center, 'expoInOut'], [t2, [-W / 2, H / 2]]);
        pos(b.layer.id, [t1, [W * 1.5, H / 2], 'expoInOut'], [t2, center]);
    }
    return {created: [], note: `${type} from ${a.layer.id} to ${b.layer.id} at ${t1}s–${t2}s`};
  },
};

PRESETS['element.lowerThird'] = {
  kind: 'element',
  description: 'Lower third: an accent bar wipes in, then name and title slide out from behind it.',
  params: '{name: string, title?: string, start?: s, duration?: s, color?, textColor?, y?: px, font?}',
  apply: (p, compId, o) => {
    const comp = getComp(p, compId);
    const t0 = num(o.start, 0), dur = num(o.duration, 4), y = num(o.y, comp.height * 0.72);
    const color = str(o.color, '#E8692A');
    const x = comp.width * 0.08;
    const created: string[] = [];
    const bar = addLayer(p, comp.id, {type: 'solid', name: 'lt-bar', color, size: [12, 170], inPoint: t0, outPoint: t0 + dur,
      transform: {anchor: [0, 0], position: [x, y], scale: kf<Vec2>([t0, [100, 0], 'expoOut'], [t0 + 0.5, [100, 100]], [t0 + dur - 0.5, [100, 100], 'expoIn'], [t0 + dur, [100, 0]])}} as NewLayer);
    created.push(bar.id);
    const mk = (text: string, size: number, dy: number, delay: number, c: string, name: string) =>
      created.push(addLayer(p, comp.id, {type: 'text', name, text, size, weight: 800, align: 'left', color: c, font: o.font as string | undefined, inPoint: t0 + delay, outPoint: t0 + dur,
        transform: {position: [x + 34, y + dy]}, masks: [{shape: 'rect', rect: [0, -200, comp.width, 400]}],
        animators: [{unit: 'line', duration: 0.7, ease: 'expoOut', from: {x: -comp.width * 0.6}}, {unit: 'line', mode: 'out', duration: 0.5, ease: 'expoIn', from: {x: -comp.width * 0.6}}]} as NewLayer).id);
    mk(str(o.name, 'Name'), Math.round(comp.width / 15), 55, 0.25, str(o.textColor, '#ffffff'), 'lt-name');
    if (o.title) mk(str(o.title, ''), Math.round(comp.width / 28), 125, 0.4, color, 'lt-title');
    return {created};
  },
};

PRESETS['element.highlightWord'] = {
  kind: 'element',
  description: 'Adds a background plate that wipes in behind an existing text layer (marker highlight).',
  params: '{layer: textLayerId, color?, at?: s, duration?: s, padding?: [x,y], radius?}',
  apply: (p, _c, o) => {
    const {layer} = findLayer(p, str(o.layer, ''));
    if (layer.type !== 'text') throw new OpError(`${layer.id} is not a text layer`);
    const at = num(o.at, layer.inPoint ?? 0), d = num(o.duration, 0.45);
    layer.box = {color: str(o.color, '#E8692A'), padding: (o.padding as [number, number]) ?? [26, 10], radius: num(o.radius, 14), reveal: kf([at, 0, 'expoOut'], [at + d, 100])};
    return {created: []};
  },
};

export const listPresets = () =>
  Object.entries(PRESETS).map(([name, p]) => `${name} [${p.kind}] — ${p.description}\n    params: ${p.params}`).join('\n');
