import {applyEase} from './ease.js';
import {parseColor, rgbaString} from './color.js';
import type {TextAnimator, TextLayer} from './model.js';
import {val} from './anim.js';

type Ctx = CanvasRenderingContext2D;

export interface Unit {
  text: string;
  x: number; // left edge, relative to block origin
  y: number; // baseline
  w: number;
  line: number;
  word: number;
  grapheme: number; // index of first grapheme
}
export interface TextLayout {
  lines: {text: string; x: number; y: number; w: number}[];
  graphemes: Unit[];
  words: Unit[];
  width: number;
  height: number;
  top: number; // block top relative to origin
  size: number;
}

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
export const graphemes = (s: string) => [...segmenter.segment(s)].map((g) => g.segment);

export const fontString = (layer: TextLayer, size: number, fallbackFamily: string) =>
  `${layer.weight ?? 700} ${size}px "${layer.font ?? fallbackFamily}"`;

const layoutCache = new Map<string, TextLayout>();

// Lays text out once, measuring each grapheme at its position inside the shaped line,
// so per-letter animation of Devanagari keeps conjuncts and matras in place.
export const layoutText = (ctx: Ctx, layer: TextLayer, size: number, tracking: number, font: string): TextLayout => {
  const key = [layer.text, font, tracking, layer.maxWidth, layer.align, layer.lineHeight].join('|');
  const hit = layoutCache.get(key);
  if (hit) return hit;
  ctx.font = font;
  // skia (and some browsers) drop trailing whitespace from measureText, so measure with a sentinel.
  const sentinel = ctx.measureText('|').width;
  const advance = (s: string) => (/\s$/.test(s) ? ctx.measureText(`${s}|`).width - sentinel : ctx.measureText(s).width);
  const measure = (s: string) => advance(s) + tracking * Math.max(0, graphemes(s).length - 1);
  const lineHeight = (layer.lineHeight ?? 1.25) * size;

  const rawLines: string[] = [];
  for (const para of layer.text.split('\n')) {
    if (!layer.maxWidth) {
      rawLines.push(para);
      continue;
    }
    let cur = '';
    for (const word of para.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure(next) > layer.maxWidth) {
        rawLines.push(cur);
        cur = word;
      } else cur = next;
    }
    rawLines.push(cur);
  }

  const align = layer.align ?? 'center';
  const top = -(rawLines.length * lineHeight) / 2;
  const out: TextLayout = {lines: [], graphemes: [], words: [], width: 0, height: rawLines.length * lineHeight, top, size};
  let gi = 0, wi = 0;
  rawLines.forEach((line, li) => {
    const w = measure(line);
    out.width = Math.max(out.width, w);
    const x0 = align === 'left' ? 0 : align === 'right' ? -w : -w / 2;
    // Baseline sits ~78% down the line box, which centres Latin and Devanagari well.
    const y = top + li * lineHeight + lineHeight * 0.5 + size * 0.32;
    out.lines.push({text: line, x: x0, y, w});
    const gs = graphemes(line);
    let prefix = '';
    let wordStart: number | null = null, wordText = '';
    const flushWord = (endX: number) => {
      if (wordStart !== null) out.words.push({text: wordText, x: wordStart, y, w: endX - wordStart, line: li, word: wi++, grapheme: gi});
      wordStart = null;
      wordText = '';
    };
    gs.forEach((g, i) => {
      const x = x0 + (prefix ? advance(prefix) : 0) + tracking * i;
      const gw = ctx.measureText(g).width;
      if (g === ' ') flushWord(x);
      else {
        if (wordStart === null) wordStart = x;
        wordText += g;
        out.graphemes.push({text: g, x, y, w: gw, line: li, word: wi, grapheme: gi++});
      }
      prefix += g;
    });
    flushWord(x0 + w);
  });
  if (layoutCache.size > 500) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
};

const rank = (i: number, n: number, order: TextAnimator['order'], seed = 1) => {
  switch (order) {
    case 'reverse': return n - 1 - i;
    case 'center': return Math.abs(i - (n - 1) / 2);
    case 'edges': return (n - 1) / 2 - Math.abs(i - (n - 1) / 2);
    case 'random': {
      const ids = [...Array(n).keys()].sort((a, b) => Math.sin(a * 91.7 + seed) - Math.sin(b * 91.7 + seed));
      return ids.indexOf(i);
    }
    default: return i;
  }
};

export interface UnitState { opacity: number; x: number; y: number; scale: number; rotation: number; blur: number; tracking: number; color?: string }

// Combined animator state for one unit at local layer time `lt` (seconds since inPoint).
export const unitState = (animators: TextAnimator[], unitIndex: Record<TextAnimator['unit'], number>, counts: Record<TextAnimator['unit'], number>, lt: number, layerDur: number, baseColor: string): UnitState => {
  const s: UnitState = {opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, blur: 0, tracking: 0};
  for (const a of animators) {
    const n = counts[a.unit], i = unitIndex[a.unit];
    const stagger = a.stagger ?? 0.05, dur = a.duration ?? 0.5, delay = a.delay ?? 0;
    const r = rank(i, n, a.order, a.seed);
    const maxRank = a.order === 'center' || a.order === 'edges' ? (n - 1) / 2 : n - 1;
    let p: number;
    if (a.mode === 'out') {
      const start = layerDur - delay - dur - (maxRank - r) * stagger;
      p = 1 - applyEase(a.ease ?? 'easeIn', Math.min(1, Math.max(0, (lt - start) / dur)), dur);
    } else {
      const start = delay + r * stagger;
      p = applyEase(a.ease ?? 'cubicOut', Math.min(1, Math.max(0, (lt - start) / dur)), dur);
    }
    const q = 1 - p; // amount of the "from" offset still applied
    const f = a.from;
    if (f.opacity !== undefined) s.opacity *= (f.opacity + (100 - f.opacity) * p) / 100;
    if (f.x) s.x += f.x * q;
    if (f.y) s.y += f.y * q;
    if (f.scale !== undefined) s.scale *= (f.scale + (100 - f.scale) * p) / 100;
    if (f.rotation) s.rotation += f.rotation * q;
    if (f.blur) s.blur += f.blur * q;
    if (f.tracking) s.tracking += f.tracking * q;
    if (f.color) {
      const c0 = parseColor(f.color), c1 = parseColor(baseColor);
      if (c0 && c1) s.color = rgbaString(c0.map((v, k) => v + (c1[k] - v) * p) as [number, number, number, number]);
    }
  }
  return s;
};

const roundRect = (ctx: Ctx, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

// Draws a text layer in its own layer space (origin = alignment point, vertically centred).
export const drawText = (ctx: Ctx, layer: TextLayer, t: number, inPoint: number, outPoint: number, fallbackFamily: string) => {
  const size = val(layer.size, t, 72);
  const tracking = val(layer.tracking, t, 0);
  const color = val(layer.color, t, '#ffffff');
  const font = fontString(layer, size, fallbackFamily);
  const L = layoutText(ctx, layer, size, tracking, font);
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (layer.box) {
    const [px, py] = layer.box.padding ?? [24, 12];
    const reveal = val(layer.box.reveal, t, 100) / 100;
    const x0 = Math.min(...L.lines.map((l) => l.x)) - px;
    const bw = L.width + px * 2, bh = L.height + py * 2;
    if (reveal > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, L.top - py, bw * reveal, bh);
      ctx.clip();
      ctx.fillStyle = val(layer.box.color, t, '#000');
      roundRect(ctx, x0, L.top - py, bw, bh, layer.box.radius ?? 12);
      ctx.fill();
      ctx.restore();
    }
  }

  if (layer.shadow) {
    ctx.shadowColor = layer.shadow.color;
    ctx.shadowBlur = layer.shadow.blur;
    ctx.shadowOffsetX = layer.shadow.x ?? 0;
    ctx.shadowOffsetY = layer.shadow.y ?? 0;
  }
  const paint = (s: string, x: number, y: number, fill: string) => {
    if (layer.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = layer.stroke.width;
      ctx.strokeStyle = layer.stroke.color;
      ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(s, x, y);
  };

  const animators = layer.animators ?? [];
  if (animators.length === 0) {
    for (const l of L.lines) paint(l.text, l.x, l.y, color);
    return;
  }

  // Draw at the finest unit any animator needs; coarser units keep whole-word shaping.
  const finest = animators.some((a) => a.unit === 'grapheme') ? 'grapheme' : animators.some((a) => a.unit === 'word') ? 'word' : 'line';
  const units: Unit[] = finest === 'grapheme' ? L.graphemes : finest === 'word' ? L.words : L.lines.map((l, i) => ({...l, line: i, word: 0, grapheme: 0}));
  const counts = {grapheme: L.graphemes.length, word: L.words.length, line: L.lines.length};
  const lt = t - inPoint, dur = outPoint - inPoint;
  const clip = animators.some((a) => a.clip);
  const lineHeight = L.height / L.lines.length;
  const lineCounts = new Map<number, number>();
  for (const u of units) lineCounts.set(u.line, (lineCounts.get(u.line) ?? 0) + 1);
  const lineIdx = new Map<number, number>();

  for (const u of units) {
    const idxInLine = lineIdx.get(u.line) ?? 0;
    lineIdx.set(u.line, idxInLine + 1);
    const st = unitState(animators, {grapheme: u.grapheme, word: u.word, line: u.line}, counts, lt, dur, color);
    if (st.opacity <= 0.001) continue;
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(-1e5, L.top + u.line * lineHeight, 2e5, lineHeight);
      ctx.clip();
    }
    const spread = st.tracking * (idxInLine - ((lineCounts.get(u.line) ?? 1) - 1) / 2);
    const cx = u.x + u.w / 2 + st.x + spread;
    const cy = u.y - size * 0.35 + st.y;
    ctx.translate(cx, cy);
    if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
    if (st.scale !== 1) ctx.scale(st.scale, st.scale);
    ctx.globalAlpha *= st.opacity;
    if (st.blur > 0.1) ctx.filter = `blur(${st.blur.toFixed(2)}px)`;
    paint(u.text, -u.w / 2, size * 0.35, st.color ?? color);
    ctx.restore();
  }
};
