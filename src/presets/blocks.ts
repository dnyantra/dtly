// Graphic blocks for promos and real-estate reels (ported from the KK Park reel's gfx.mjs/build.mjs),
// parameterised by brand colours and fonts. Every block adds ordinary, editable layers to a comp.
// Layouts are designed on a 1080×1920 canvas and scaled to the comp's size.
import type {Ease, Effect, Layer, Project, Vec2} from '../core/model.js';
import {getComp, OpError} from '../ops/ops.js';
import type {Preset} from './index.js';

type Params = Record<string, unknown>;
type Draft = Record<string, any>; // a layer under construction; `id` is a local key, `parent`/`matte.layer` refer to local keys

const r3 = (t: number) => Math.round(t * 1000) / 1000;
export const kf = <T>(...k: [number, T, Ease?][]) => ({keyframes: k.map(([t, v, ease]) => (ease ? {t: r3(t), v, ease} : {t: r3(t), v}))});
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const vec = (v: unknown, d: Vec2): Vec2 => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? (v as Vec2) : d);

// ---------- brand ----------
export interface Brand {primary: string; accent: string; ink: string; heading?: string; display?: string; body?: string}
export const BRAND_PARAMS = 'brand?: {colors?: {primary, accent, ink}, fonts?: {heading, display?, body}} (as from the CustomerPro brand kit), or color/accent/ink/font overrides';
/** Brand defaults: the KK Park look (lime accent, red primary, near-black ink). Fonts default to the project font. */
export const brandOf = (o: Params): Brand => {
  const b = (o.brand ?? {}) as {colors?: Record<string, string>; fonts?: Record<string, string>};
  const c = b.colors ?? {}, f = b.fonts ?? {};
  const heading = str(o.font, f.heading ?? '') || undefined;
  return {
    primary: str(o.primary, c.primary ?? '#C8102E'),
    accent: str(o.accent, c.accent ?? '#C9E62E'),
    ink: str(o.ink, c.ink ?? '#0B0B0B'),
    heading,
    display: str(o.displayFont, f.display ?? '') || heading,
    body: str(o.bodyFont, f.body ?? '') || heading,
  };
};

// ---------- geometry: 1080×1920 design space → comp ----------
const geom = (w: number, h: number) => {
  const sx = w / 1080, sy = h / 1920, s = Math.min(sx, sy);
  return {X: (x: number) => r3(x * sx), Y: (y: number) => r3(y * sy), P: (x: number, y: number): Vec2 => [r3(x * sx), r3(y * sy)], S: (v: number) => r3(v * s), W: w, H: h};
};

const SHADOW = {color: 'rgba(0,0,0,0.6)', blur: 22, x: 0, y: 8};

// ---------- placing drafts into a comp ----------
const allIds = (p: Project) => new Set(p.comps.flatMap((c) => c.layers.map((l) => l.id)));
const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'layer';

/** Adds drafts (top first) at `index` of a comp, giving each a unique id and remapping parent/matte links. */
export const place = (p: Project, compId: string | undefined, drafts: Draft[], index = 0): string[] => {
  const comp = getComp(p, compId);
  const taken = allIds(p);
  const map = new Map<string, string>();
  for (const d of drafts) {
    const base = clean(String(d.id ?? d.name ?? d.type));
    let id = base, i = 2;
    while (taken.has(id)) id = `${base}-${i++}`;
    taken.add(id);
    map.set(String(d.id ?? id), id);
    d.__id = id;
  }
  const layers = drafts.map(({__id, ...d}) => {
    const l = {...d, id: __id} as Layer;
    if (l.parent) l.parent = map.get(l.parent) ?? l.parent;
    if (l.matte) l.matte = {...l.matte, layer: map.get(l.matte.layer) ?? l.matte.layer};
    return l;
  });
  comp.layers.splice(Math.max(0, Math.min(index, comp.layers.length)), 0, ...layers);
  return layers.map((l) => l.id);
};

// ---------- reusable drafts ----------
type G = ReturnType<typeof geom>;

const logoTileDrafts = (g: G, o: {src: string; pos: Vec2; size: number; aspect: number; t: number; pop: boolean; plate: string; key: string}): Draft[] => {
  const w = o.size, h = o.size * o.aspect;
  return [
    {id: `${o.key}-img`, type: 'image', src: o.src, size: [w, h], fit: 'fill', parent: `${o.key}-n`, transform: {position: [0, 0]}},
    {id: `${o.key}-bg`, type: 'shape', shape: 'rect', size: [w + w * 0.16, h + w * 0.16], radius: w * 0.08, fill: o.plate, parent: `${o.key}-n`,
      effects: [{type: 'dropShadow', color: 'rgba(0,0,0,0.45)', blur: 16, distance: 6, angle: 90}], transform: {position: [0, 0]}},
    {id: `${o.key}-n`, type: 'null', inPoint: o.t, transform: {position: o.pos, ...(o.pop ? {scale: kf<Vec2>([o.t, [0, 0], 'backOut'], [o.t + 0.5, [100, 100]])} : {})}},
  ];
};

const chipDrafts = (g: G, B: Brand, o: Params, d: {color: string; textColor: string; size: number; y: number}): Draft[] => {
  const t = num(o.start, 0.15), x = g.X(num(o.x, 80)), y = g.Y(num(o.y, d.y)), size = g.S(num(o.size, d.size));
  const kicker = typeof o.kicker === 'string' && o.kicker ? o.kicker : undefined;
  return [
    {id: 'chip', type: 'text', text: str(o.text, 'FEATURE'), font: B.heading, weight: 900, size, color: str(o.textColor, d.textColor), align: 'left', inPoint: t, maxWidth: g.S(900), lineHeight: 1.05,
      box: {color: str(o.color, d.color), padding: [g.S(26), g.S(16)], radius: g.S(8), reveal: kf([t, 0, 'expoOut'], [t + 0.45, 100])},
      transform: {position: [x, y]},
      animators: [{unit: 'word', stagger: 0.05, duration: 0.45, delay: 0.12, ease: 'expoOut', from: {opacity: 0, x: -40}}]},
    ...(kicker ? [{id: 'chip-k', type: 'text', text: kicker, font: B.display, weight: 800, size: g.S(34), color: str(o.kickerColor, '#FFFFFF'), align: 'left', tracking: g.S(4), inPoint: t + 0.1,
      shadow: {color: 'rgba(0,0,0,0.55)', blur: 18, x: 0, y: 6}, transform: {position: [x, y - size - g.S(34)]},
      animators: [{unit: 'line', clip: true, duration: 0.5, ease: 'expoOut', from: {y: 40}}]}] : []),
  ];
};

const topDim = (g: G, key: string, strength = 0.55): Draft => ({
  id: key, type: 'shape', shape: 'rect', size: [g.W, g.Y(900)], transform: {position: [g.W / 2, g.Y(450)]},
  fill: {linear: {from: [0, -g.Y(450)], to: [0, g.Y(450)], stops: [[0, `rgba(0,0,0,${strength})`], [1, 'rgba(0,0,0,0)']]}},
});

// ---------- looks ----------
export const LOOKS: Record<string, Effect[]> = {
  punch: [{type: 'contrast', amount: 106}, {type: 'saturate', amount: 108}, {type: 'colorBalance', shadows: [-0.05, 0, 0.07], highlights: [0.07, 0.03, -0.06]}, {type: 'vignette', amount: 24, softness: 0.7}],
  warm: [{type: 'temperature', amount: 18}, {type: 'curves', master: [[0, 0.02], [0.5, 0.53], [1, 0.98]]}, {type: 'saturate', amount: 105}, {type: 'vignette', amount: 18, softness: 0.7}],
  cool: [{type: 'temperature', amount: -16}, {type: 'contrast', amount: 104}, {type: 'colorBalance', shadows: [-0.03, 0, 0.06], highlights: [-0.02, 0.01, 0.04]}],
  tealOrange: [{type: 'colorBalance', shadows: [-0.08, 0.02, 0.1], midtones: [0.02, 0, -0.02], highlights: [0.1, 0.04, -0.08]}, {type: 'contrast', amount: 108}, {type: 'saturate', amount: 110}, {type: 'vignette', amount: 22, softness: 0.7}],
  filmic: [{type: 'curves', master: [[0, 0.06], [0.25, 0.22], [0.75, 0.8], [1, 0.95]]}, {type: 'saturate', amount: 92}, {type: 'colorBalance', shadows: [0, 0.02, 0.05], highlights: [0.05, 0.02, -0.03]}, {type: 'vignette', amount: 30, softness: 0.6}],
  mono: [{type: 'saturate', amount: 0}, {type: 'contrast', amount: 115}, {type: 'vignette', amount: 28, softness: 0.65}],
  vivid: [{type: 'contrast', amount: 110}, {type: 'saturate', amount: 125}, {type: 'exposure', stops: 0.05}],
};

// ---------- presets ----------
const block = (description: string, params: string, apply: (p: Project, compId: string | undefined, o: Params, g: G, B: Brand) => {created: string[]; note?: string}): Preset => ({
  kind: 'block', description, params: `${params}; ${BRAND_PARAMS}; index?: stack position (default 0 = top)`,
  apply: (p, compId, o) => { const c = getComp(p, compId); return apply(p, c.id, o, geom(c.width, c.height), brandOf(o)); },
});

export const BLOCK_PRESETS: Record<string, Preset> = {
  'block.titlePlate': block(
    'Title plate: a small kicker, a tilted headline on a brand-colour plate that wipes in with a pop, and a sub-chip in the second colour, over a soft top shade.',
    '{title: string ("\\n" for lines), kicker?: string, sub?: string, start?: s (0.15), y?: px (plate centre, 500), rotation?: deg (-3), color?: plate colour (brand accent), textColor? (ink), subColor? (brand primary), size?: px (92), shade?: boolean (true)}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.15), y = num(o.y, 500), rot = num(o.rotation, -3), size = num(o.size, 92);
      const lines = str(o.title, 'TITLE').split('\n').length;
      const D: Draft[] = [];
      if (o.kicker) D.push({id: 'kick', type: 'text', text: str(o.kicker, ''), font: B.display, weight: 800, size: g.S(40), color: '#FFFFFF', align: 'center', tracking: g.S(8), inPoint: t,
        shadow: SHADOW, transform: {position: g.P(540, y - 170 - (lines - 2) * size * 0.5), rotation: rot}, animators: [{unit: 'grapheme', stagger: 0.025, duration: 0.45, ease: 'expoOut', from: {opacity: 0, y: 30}}]});
      D.push({id: 'plate', type: 'text', text: str(o.title, 'TITLE'), font: B.heading, weight: 900, size: g.S(size), color: str(o.textColor, B.ink), align: 'center', lineHeight: 1.02, inPoint: t + 0.2, maxWidth: g.S(980),
        box: {color: str(o.color, B.accent), padding: [g.S(40), g.S(26)], radius: g.S(12), reveal: kf([t + 0.2, 0, 'expoOut'], [t + 0.7, 100])},
        transform: {position: g.P(540, y), rotation: rot, scale: kf<Vec2>([t + 0.2, [70, 70], 'backOut'], [t + 0.75, [100, 100]])},
        effects: [{type: 'dropShadow', color: 'rgba(0,0,0,0.5)', blur: 24, distance: 10, angle: 90}],
        animators: [{unit: 'word', stagger: 0.06, duration: 0.45, delay: 0.2, ease: 'expoOut', from: {opacity: 0, y: 40}}]});
      if (o.sub) D.push({id: 'sub', type: 'text', text: str(o.sub, ''), font: B.heading, weight: 900, size: g.S(44), color: '#FFFFFF', align: 'center', tracking: g.S(3), inPoint: t + 0.75,
        box: {color: str(o.subColor, B.primary), padding: [g.S(26), g.S(14)], radius: g.S(8), reveal: kf([t + 0.75, 0, 'expoOut'], [t + 1.15, 100])},
        transform: {position: g.P(540, y + 190 + (lines - 2) * size * 0.5), rotation: rot}, animators: [{unit: 'word', stagger: 0.05, duration: 0.4, delay: 0.1, ease: 'expoOut', from: {opacity: 0, y: 20}}]});
      if (o.shade !== false) D.push(topDim(g, 'topdim'));
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.chip': block(
    'Feature chip: text on a coloured plate that wipes in at the lower left, words sliding in; optional kicker line above it.',
    '{text: string, kicker?: string, start?: s (0.15), x?: px (80, left edge), y?: px (1460), size?: px (54), color?: plate (brand accent), textColor? (ink), kickerColor? (#FFFFFF)}',
    (p, comp, o, g, B) => ({created: place(p, comp, chipDrafts(g, B, o, {color: B.accent, textColor: B.ink, size: 54, y: 1460}), num(o.index, 0))}),
  ),

  'block.kickerChip': block(
    'Feature chip with a kicker: small white line ("INSIDE THE SOCIETY") revealed above a bold plate chip ("BOX CRICKET TURF") — the KK Park amenity callout.',
    '{text: string, kicker: string, start?: s (0.15), x?: px (80), y?: px (1430), size?: px (58), color?: plate (brand accent), textColor? (ink), kickerColor?}',
    (p, comp, o, g, B) => {
      if (!o.kicker) throw new OpError('block.kickerChip needs a kicker (use block.chip without one)');
      return {created: place(p, comp, chipDrafts(g, B, o, {color: B.accent, textColor: B.ink, size: 58, y: 1430}), num(o.index, 0))};
    },
  ),

  'block.areaReveal': block(
    'Area reveal: a traced outline of a site draws on with a glow and fills, while a big number counts up (e.g. 1,80,000) with a unit chip (SQ.FT) and a kicker; the shot dims slightly behind it.',
    '{points: [[x,y],…] outline in comp px (traced on the frame), value: number, unit?: string ("SQ.FT"), kicker?: string ("SPREAD ACROSS"), start?: s (0.15), labelPos?: [x,y] (centre of the number, [400,930]), rotation?: deg (-7), size?: px (176), decimals?: 0, locale?: "en-IN", prefix?, color?: outline + unit plate (brand accent), stroke?: number outline (brand primary), dim?: 0-100 (28), countDuration?: s (1.6)}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.15), rot = num(o.rotation, -7), size = num(o.size, 176);
      const pts = (Array.isArray(o.points) ? o.points : []) as Vec2[];
      if (pts.length < 3) throw new OpError('block.areaReveal needs points: at least 3 [x,y] corners of the outline (comp px)');
      const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length, cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
      const d = 'M ' + pts.map(([x, y]) => `${r3(x - cx)} ${r3(y - cy)}`).join(' L ') + ' Z';
      const [lx, ly] = vec(o.labelPos, g.P(400, 930));
      const color = str(o.color, B.accent);
      const rgb = color.match(/^#([0-9a-f]{6})$/i) ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : [201, 230, 46];
      const S = g.S(1);
      const D: Draft[] = [
        {id: 'sq-k', type: 'text', text: str(o.kicker, 'SPREAD ACROSS'), font: B.display, weight: 800, size: g.S(40), color: '#FFFFFF', align: 'center', tracking: g.S(8), inPoint: t + 0.5,
          shadow: SHADOW, transform: {position: [lx, ly - 140 * S], rotation: rot}, animators: [{unit: 'line', clip: true, duration: 0.5, ease: 'expoOut', from: {y: 50}}]},
        {id: 'sq-n', type: 'text', text: '{value}', font: B.heading, weight: 900, size: g.S(size), color: '#FFFFFF', align: 'center', inPoint: t + 0.6,
          value: kf([t + 0.6, 0, 'expoOut'], [t + 0.6 + num(o.countDuration, 1.6), num(o.value, 0)]),
          format: {decimals: num(o.decimals, 0), locale: str(o.locale, 'en-IN'), ...(o.prefix ? {prefix: str(o.prefix, '')} : {})},
          stroke: {color: str(o.stroke, B.primary), width: g.S(5)}, shadow: {color: 'rgba(0,0,0,0.7)', blur: 30, x: 0, y: 12},
          transform: {position: [lx, ly], rotation: rot, scale: kf<Vec2>([t + 0.6, [50, 50], 'backOut'], [t + 1.1, [100, 100]])}},
        ...(o.unit === '' ? [] : [{id: 'sq-u', type: 'text', text: str(o.unit, 'SQ.FT'), font: B.heading, weight: 900, size: g.S(72), color: str(o.textColor, B.ink), align: 'center', tracking: g.S(4), inPoint: t + 1.3,
          box: {color, padding: [g.S(34), g.S(14)], radius: g.S(8), reveal: kf([t + 1.3, 0, 'expoOut'], [t + 1.7, 100])},
          transform: {position: [lx + 20 * S, ly + 150 * S], rotation: rot}, animators: [{unit: 'grapheme', stagger: 0.04, duration: 0.4, delay: 0.1, ease: 'expoOut', from: {opacity: 0, y: 20}}]}]),
        {id: 'sq-line', type: 'shape', shape: 'path', path: d, fill: 'rgba(0,0,0,0)', stroke: color, strokeWidth: g.S(9), lineJoin: 'round', inPoint: t,
          trim: {end: kf([t, 0, 'easyEase'], [t + 1.3, 100])}, effects: [{type: 'glow', color, radius: 26, strength: 0.9}], transform: {position: [r3(cx), r3(cy)]}},
        {id: 'sq-fill', type: 'shape', shape: 'path', path: d, fill: `rgba(${rgb.join(',')},0.30)`, inPoint: t + 1.0,
          transform: {position: [r3(cx), r3(cy)], opacity: kf([t + 1.0, 0], [t + 1.5, 100])}},
      ];
      const dim = num(o.dim, 28);
      if (dim > 0) D.push({id: 'sq-dim', type: 'solid', color: '#000000', size: [g.W, g.H], transform: {opacity: kf([t, 0], [t + 0.6, dim])}});
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.badge': block(
    'Location badge: a white sign with a place name and a coloured chip (e.g. "5 MIN"), on a stem that draws down to a glowing dot; pops in.',
    '{name: string, chip?: string, at?: [x,y] (dot position, [540,1000]), stem?: px (150), start?: s (0.2), color?: chip + dot (brand primary), textColor? (#111111), plate? (#FFFFFF)}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.2), stem = g.S(num(o.stem, 150)), color = str(o.color, B.primary), S = g.S(1);
      const D: Draft[] = [
        {id: 'badge-name', type: 'text', text: str(o.name, 'PLACE'), font: B.display, weight: 800, size: g.S(44), color: str(o.textColor, '#111111'), align: 'center', parent: 'badge',
          box: {color: str(o.plate, '#FFFFFF'), padding: [g.S(26), g.S(16)], radius: g.S(10)}, shadow: {color: 'rgba(0,0,0,0.35)', blur: 16, x: 0, y: 6},
          transform: {position: [0, -stem - 70 * S]}},
        ...(o.chip ? [{id: 'badge-chip', type: 'text', text: str(o.chip, ''), font: B.heading, weight: 900, size: g.S(38), color: '#FFFFFF', align: 'center', parent: 'badge',
          box: {color, padding: [g.S(18), g.S(10)], radius: g.S(8)}, transform: {position: [0, -stem - 8 * S]}, inPoint: t + 0.25,
          animators: [{unit: 'line', duration: 0.35, ease: 'backOut', from: {opacity: 0, scale: 0.4}}]}] : []),
        {id: 'badge-stem', type: 'shape', shape: 'line', points: [[0, -stem + 18 * S], [0, 0]], stroke: '#FFFFFF', strokeWidth: g.S(5), parent: 'badge',
          trim: {end: kf([t, 0, 'expoOut'], [t + 0.4, 100])}, transform: {position: [0, 0]}},
        {id: 'badge-dot', type: 'shape', shape: 'ellipse', size: [g.S(26), g.S(26)], fill: color, stroke: '#FFFFFF', strokeWidth: g.S(5), parent: 'badge',
          effects: [{type: 'glow', color, radius: 20, strength: 0.8}], transform: {position: [0, 0]}},
        {id: 'badge', type: 'null', inPoint: t, transform: {position: vec(o.at, g.P(540, 1000)), scale: kf<Vec2>([t, [0, 0], 'backOut'], [t + 0.45, [100, 100]])}},
      ];
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.price': block(
    'Price: a kicker ("STARTING FROM"), a big counter rolling up to the price (₹ 1.25 Cr*) and a small T&C note on a dark blurred panel.',
    '{value: number, prefix?: "₹", unit?: " Cr*", decimals?: 2, locale?: "en-IN", kicker?: "STARTING FROM", note?: "*All inclusive. T&C apply.", y?: px (900), start?: s (0.2), color?: number (#FFFFFF), accent?: kicker (brand accent), panel?: colour (rgba(8,10,14,0.82)) or "" for none, numberFont?}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.2), y = num(o.y, 900), value = num(o.value, 0);
      const D: Draft[] = [
        {id: 'price-k', type: 'text', text: str(o.kicker, 'STARTING FROM'), font: B.display, weight: 800, size: g.S(44), color: B.accent, align: 'center', tracking: g.S(8), inPoint: t,
          shadow: SHADOW, transform: {position: g.P(540, y - 150)}, animators: [{unit: 'line', clip: true, duration: 0.6, ease: 'expoOut', from: {y: 50}}]},
        {id: 'price', type: 'text', text: '{value}', font: str(o.numberFont, '') || B.heading, weight: 800, size: g.S(190), color: str(o.color, '#FFFFFF'), align: 'center', inPoint: t + 0.1,
          value: kf([t + 0.1, value * 0.6, 'expoOut'], [t + 1.3, value]), format: {prefix: str(o.prefix, '₹'), suffix: str(o.unit, ' Cr*'), decimals: num(o.decimals, 2), locale: str(o.locale, 'en-IN')},
          shadow: {color: 'rgba(0,0,0,0.6)', blur: 30, x: 0, y: 10},
          transform: {position: g.P(540, y), scale: kf<Vec2>([t + 0.1, [60, 60], 'backOut'], [t + 0.6, [100, 100]])}},
        ...(o.note === '' ? [] : [{id: 'price-n', type: 'text', text: str(o.note, '*All inclusive. T&C apply.'), font: B.body, weight: 600, size: g.S(30), color: 'rgba(255,255,255,0.85)', align: 'center', inPoint: t + 0.8,
          shadow: SHADOW, transform: {position: g.P(540, y + 140)}, animators: [{unit: 'line', duration: 0.5, ease: 'easeOut', from: {opacity: 0}}]}]),
      ];
      if (o.panel !== '') D.push({id: 'price-bg', type: 'shape', shape: 'rect', size: [g.S(980), g.S(480)], radius: g.S(40), fill: str(o.panel, 'rgba(8,10,14,0.82)'), inPoint: t, effects: [{type: 'blur', radius: 24}],
        transform: {position: g.P(540, y), opacity: kf([t, 0, 'easeOut'], [t + 0.5, 100])}});
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.bigName': block(
    'Big name: the project or brand name resolves letter by letter from the centre, an accent line draws out under it and a subtitle rises, over a top shade.',
    '{title: string, sub?: string, start?: s (0.2), y?: px (400), size?: px (150), color?: (#FFFFFF), accent?: line + sub (brand accent), tracking?: px (14), shade?: boolean (true)}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.2), y = num(o.y, 400), accent = B.accent;
      const D: Draft[] = [];
      if (o.sub) D.push({id: 'bn-sub', type: 'text', text: str(o.sub, ''), font: B.display, weight: 800, size: g.S(40), color: accent, align: 'center', tracking: g.S(6), inPoint: t + 0.7,
        shadow: SHADOW, transform: {position: g.P(540, y + 160)}, animators: [{unit: 'line', clip: true, duration: 0.6, ease: 'expoOut', from: {y: 50}}]});
      D.push(
        {id: 'bn-line', type: 'shape', shape: 'line', points: [[-g.S(230), 0], [g.S(230), 0]], stroke: accent, strokeWidth: g.S(5), inPoint: t + 0.5,
          trim: {start: kf([t + 0.5, 50, 'expoOut'], [t + 1.1, 0]), end: kf([t + 0.5, 50, 'expoOut'], [t + 1.1, 100])}, transform: {position: g.P(540, y + 95)}},
        {id: 'bn', type: 'text', text: str(o.title, 'NAME'), font: B.display, weight: 800, size: g.S(num(o.size, 150)), color: str(o.color, '#FFFFFF'), align: 'center', tracking: g.S(num(o.tracking, 14)), inPoint: t,
          maxWidth: g.S(1040), shadow: {color: 'rgba(0,0,0,0.6)', blur: 30, x: 0, y: 8}, transform: {position: g.P(540, y)},
          animators: [{unit: 'grapheme', stagger: 0.04, duration: 0.9, ease: 'expoOut', order: 'center', from: {opacity: 0, tracking: 30, blur: 14, scale: 1.25}}]},
      );
      if (o.shade !== false) D.push(topDim(g, 'bn-dim', 0.6));
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.endCard': block(
    'End card: the shot darkens, the logo tile pops in, the name resolves, a tagline, a call-to-action pill that taps and glows, "CALL NOW", phone numbers, address and website animate in one after another.',
    '{name: string, logo?: image path, logoAspect?: h/w (1), tagline?: string, cta?: string ("BOOK YOUR SITE VISIT"), callLabel?: string ("CALL NOW"), phones?: string[] (joined with " | "), address?: string, website?: string, start?: s (0.2), accent?: (brand accent), ctaText? (ink), dim?: colour (#071006), dimOpacity?: 0-100 (82)}',
    (p, comp, o, g, B) => {
      const t = num(o.start, 0.2), accent = B.accent;
      const phones = Array.isArray(o.phones) ? (o.phones as string[]).join('  |  ') : str(o.phones, '');
      const D: Draft[] = [];
      if (o.website) D.push({id: 'e-web', type: 'text', text: str(o.website, ''), font: B.display, weight: 800, size: g.S(36), color: accent, align: 'center', tracking: g.S(2), inPoint: t + 1.6,
        transform: {position: g.P(540, 1560)}, animators: [{unit: 'line', duration: 0.5, from: {opacity: 0}}]});
      if (o.address) D.push({id: 'e-addr', type: 'text', text: str(o.address, ''), font: B.body, weight: 600, size: g.S(32), color: '#FFFFFF', maxWidth: g.S(960),
        align: 'center', lineHeight: 1.3, inPoint: t + 1.3, transform: {position: g.P(540, 1460)}, animators: [{unit: 'line', clip: true, duration: 0.6, ease: 'expoOut', from: {y: 40}}]});
      if (phones) D.push({id: 'e-ph', type: 'text', text: phones, font: B.heading, weight: 900, size: g.S(64), color: '#FFFFFF', align: 'center', inPoint: t + 1.0, maxWidth: g.S(1040),
        shadow: SHADOW, transform: {position: g.P(540, 1330)}, animators: [{unit: 'grapheme', stagger: 0.02, duration: 0.45, ease: 'expoOut', from: {opacity: 0, y: 40}}]});
      if (phones && o.callLabel !== '') D.push({id: 'e-call', type: 'text', text: str(o.callLabel, 'CALL NOW'), font: B.display, weight: 800, size: g.S(34), color: accent, align: 'center', tracking: g.S(10), inPoint: t + 0.9,
        transform: {position: g.P(540, 1250)}, animators: [{unit: 'line', duration: 0.4, from: {opacity: 0}}]});
      if (o.cta !== '') D.push({id: 'e-cta', type: 'text', text: str(o.cta, 'BOOK YOUR SITE VISIT'), font: B.heading, weight: 900, size: g.S(54), color: str(o.ctaText, B.ink), align: 'center', inPoint: t + 0.6,
        box: {color: accent, padding: [g.S(46), g.S(26)], radius: g.S(60), reveal: kf([t + 0.6, 0, 'expoOut'], [t + 1.0, 100])},
        transform: {position: g.P(540, 1110), scale: kf<Vec2>([t + 2.2, [100, 100]], [t + 2.3, [93, 93], 'backOut'], [t + 2.6, [100, 100]])},
        effects: [{type: 'glow', color: accent, radius: kf([t + 2.2, 0], [t + 2.4, 40, 'easeOut'], [t + 3.2, 14]), strength: 0.7}]});
      if (o.tagline) D.push({id: 'e-tag', type: 'text', text: str(o.tagline, ''), font: B.display, weight: 800, size: g.S(38), color: accent, align: 'center', lineHeight: 1.25, tracking: g.S(3), maxWidth: g.S(1000),
        inPoint: t + 0.5, shadow: SHADOW, transform: {position: g.P(540, 930)}, animators: [{unit: 'line', clip: true, duration: 0.6, ease: 'expoOut', from: {y: 50}}]});
      D.push({id: 'e-name', type: 'text', text: str(o.name, 'NAME'), font: B.display, weight: 800, size: g.S(num(o.size, 120)), color: '#FFFFFF', align: 'center', tracking: g.S(12), inPoint: t + 0.3, maxWidth: g.S(1040),
        shadow: SHADOW, transform: {position: g.P(540, 790)}, animators: [{unit: 'grapheme', stagger: 0.04, duration: 0.6, ease: 'expoOut', order: 'center', from: {opacity: 0, scale: 1.4, blur: 10}}]});
      if (o.logo) D.push(...logoTileDrafts(g, {src: str(o.logo, ''), pos: g.P(540, 520), size: g.S(250), aspect: num(o.logoAspect, 1), t: t + 0.1, pop: true, plate: '#FFFFFF', key: 'elogo'}));
      D.push({id: 'e-dim', type: 'solid', color: str(o.dim, '#071006'), size: [g.W, g.H], transform: {opacity: kf([t, 0, 'easeOut'], [t + 0.5, num(o.dimOpacity, 82)])}});
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.logoTile': block(
    'Logo tile: the logo on a white rounded tile with a soft shadow, grouped under a null that pops in. Move or scale the null to place it.',
    '{src: image path, position?: [x,y] ([540,520]), size?: px logo width (250), aspect?: logo h/w (1), start?: s (0), pop?: boolean (true), plate?: tile colour (#FFFFFF), outPoint?: s}',
    (p, comp, o, g) => {
      const D = logoTileDrafts(g, {src: str(o.src, ''), pos: vec(o.position, g.P(540, 520)), size: g.S(num(o.size, 250)), aspect: num(o.aspect, 1), t: num(o.start, 0), pop: o.pop !== false, plate: str(o.plate, '#FFFFFF'), key: 'logo'});
      if (typeof o.outPoint === 'number') D.forEach((d) => (d.outPoint = o.outPoint));
      const ids = place(p, comp, D, num(o.index, 0));
      return {created: ids, note: `Group null: ${ids[ids.length - 1]}`};
    }),

  'block.textMaskIntro': block(
    'Text-mask intro: on a brand-colour card a kicker and the name grow in; then the shot shows through the letters, which zoom past the camera until the shot fills the frame. Takes over the bottom video layer of the comp (or uses src).',
    '{text: string ("K K PARK"), kicker?: string ("PRESENTING"), logo?: image path (tile under the name), logoAspect?: h/w, src?: video (default: the comp\'s bottom video layer, which is replaced), trimIn?, speed?, start?: s when the mask starts (1.15), background?: card colour (brand primary), kickerColor? (brand accent), size?: px (128), tracking?: px (10)}',
    (p, comp, o, g, B) => {
      const c = getComp(p, comp);
      const reveal = num(o.start, 1.15), len = c.duration;
      let src = str(o.src, ''), trimIn = num(o.trimIn, 0), speed = num(o.speed, 1);
      let plate: Layer | undefined;
      if (!src) {
        plate = [...c.layers].reverse().find((l) => l.type === 'video');
        if (!plate || plate.type !== 'video') throw new OpError('block.textMaskIntro needs src, or a video layer in the comp to take over');
        src = plate.src; trimIn = plate.trimIn ?? 0; speed = plate.speed ?? 1;
      }
      const vsize: Vec2 = plate?.type === 'video' && plate.size ? plate.size : [g.W, g.H];
      const k = (g.W / vsize[0]) * 100; // keep the shot covering the frame when the plate is oversized
      if (plate) c.layers.splice(c.layers.indexOf(plate), 1);
      const word = {type: 'text', text: str(o.text, 'NAME'), font: B.display, weight: 800, size: g.S(num(o.size, 128)), align: 'center', tracking: g.S(num(o.tracking, 10)), maxWidth: g.S(1040)};
      const zoom = kf<Vec2>([reveal, [125 * k / 100, 125 * k / 100], 'expoOut'], [len, [k, k]]);
      const video = {type: 'video', src, fit: 'cover', size: vsize, volume: 0, inPoint: reveal, trimIn: r3(trimIn), ...(speed !== 1 ? {speed} : {})};
      const out = r3(reveal);
      const D: Draft[] = [];
      if (o.logo) D.push(...logoTileDrafts(g, {src: str(o.logo, ''), pos: g.P(540, 1460), size: g.S(150), aspect: num(o.logoAspect, 1), t: 0.25, pop: true, plate: '#FFFFFF', key: 'ilogo'})
        .map((l) => (l.type === 'null' ? {...l, outPoint: out, transform: {...l.transform, opacity: kf([reveal - 0.2, 100], [reveal, 0])}} : {...l, outPoint: out})));
      if (o.kicker !== '') D.push({id: 'intro-kicker', type: 'text', text: str(o.kicker, 'PRESENTING'), font: B.display, weight: 800, size: g.S(36), color: str(o.kickerColor, B.accent), align: 'center', tracking: g.S(14), inPoint: 0.15, outPoint: out,
        transform: {position: g.P(540, 820), opacity: kf([reveal - 0.2, 100], [reveal, 0])}, animators: [{unit: 'grapheme', stagger: 0.03, duration: 0.4, ease: 'expoOut', from: {opacity: 0, y: 20}}]});
      D.push(
        {...word, id: 'intro-white', color: '#FFFFFF', outPoint: out, shadow: {color: 'rgba(0,0,0,0.35)', blur: 14, x: 0, y: 4},
          transform: {position: g.P(540, 960), scale: kf<Vec2>([0, [70, 70], 'expoOut'], [reveal, [100, 100]])},
          animators: [{unit: 'grapheme', stagger: 0.05, duration: 0.5, ease: 'expoOut', from: {opacity: 0, scale: 1.8, blur: 10}}]},
        {...video, id: 'intro-full', transform: {opacity: kf([reveal + 1.1, 0, 'easeIn'], [reveal + 1.6, 100]), scale: zoom}},
        {...video, id: 'intro-fill', matte: {layer: 'intro-matte', mode: 'alpha'}, transform: {scale: zoom}},
        {...word, id: 'intro-matte', color: '#FFFFFF', inPoint: reveal,
          transform: {position: g.P(540, 960), scale: kf<Vec2>([reveal, [100, 100], 'easeIn'], [reveal + 0.45, [140, 140], 'expoIn'], [reveal + 1.65, [2600, 2600]])}},
        {id: 'intro-card', type: 'solid', color: str(o.background, B.primary), size: [g.W, g.H]},
      );
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'block.watermark': block(
    'Watermark: a small logo tile in a corner that pops in at `from` and fades out at `to` (e.g. hidden under the end card).',
    '{src: image path, from?: s (0), to?: s (comp end), position?: [x,y] ([985,140]), size?: px (84), aspect?: logo h/w (1), fade?: s (0.2), plate?: (#FFFFFF), opacity?: 0-100 (100)}',
    (p, comp, o, g) => {
      const c = getComp(p, comp);
      const from = num(o.from, 0), to = num(o.to, c.duration), fade = num(o.fade, 0.2), op = num(o.opacity, 100);
      const D = logoTileDrafts(g, {src: str(o.src, ''), pos: vec(o.position, g.P(985, 140)), size: g.S(num(o.size, 84)), aspect: num(o.aspect, 1), t: from, pop: true, plate: str(o.plate, '#FFFFFF'), key: 'wm'});
      D.forEach((d) => (d.outPoint = r3(to)));
      const nul = D[D.length - 1];
      if (to < c.duration) nul.transform.opacity = kf([to - fade * 2, op], [to - fade, 0]);
      else if (op !== 100) nul.transform.opacity = op;
      return {created: place(p, comp, D, num(o.index, 0))};
    }),

  'grade.look': {
    kind: 'block',
    description: `Colour look as an adjustment layer (affects everything below it): ${Object.keys(LOOKS).join(', ')}. "punch" is the KK Park grade (contrast, saturation, split-tone, vignette). Edit its effects afterwards like any layer.`,
    params: `{look?: ${Object.keys(LOOKS).map((k) => `"${k}"`).join('|')} (punch), effects?: Effect[] (custom, replaces the look), vignette?: 0-100 (override), from?: s, to?: s, index?: stack position (default 0 = top), name?}`,
    apply: (p, compId, o) => {
      const look = str(o.look, 'punch');
      const base = Array.isArray(o.effects) ? (o.effects as Effect[]) : LOOKS[look];
      if (!base) throw new OpError(`Unknown look "${look}". Looks: ${Object.keys(LOOKS).join(', ')}`);
      let effects = structuredClone(base);
      if (typeof o.vignette === 'number') effects = [...effects.filter((e) => e.type !== 'vignette'), ...(o.vignette > 0 ? [{type: 'vignette', amount: o.vignette, softness: 0.7} as Effect] : [])];
      const d: Draft = {id: str(o.name, 'grade'), type: 'adjustment', effects};
      if (typeof o.from === 'number') d.inPoint = o.from;
      if (typeof o.to === 'number') d.outPoint = o.to;
      return {created: place(p, compId, [d], num(o.index, 0))};
    },
  },
};

