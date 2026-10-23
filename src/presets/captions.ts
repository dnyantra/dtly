// Captions preset: short-form style captions with the spoken word highlighted.
import {cuesToWords, paginate, parseSubtitles, type Cue, type Word} from '../core/captions.js';
import type {NewLayer, Vec2} from '../core/model.js';
import {addLayer, getComp} from '../ops/ops.js';
import type {Preset} from './index.js';

const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const r3 = (t: number) => Math.round(t * 1000) / 1000;

export const CAPTION_PRESETS: Record<string, Preset> = {
  'captions.add': {
    kind: 'captions',
    description: 'Captions with the current word highlighted (Reels/Shorts style), from word timings, cues or SRT/VTT text. Pages of a few words appear in sync; every page is an editable text layer.',
    params: '{words?: [{text, start, end}], cues?: [{start, end, text}], srt?: string (SRT or VTT text), offset?: s, maxWords?: 4, maxChars?: 22, position?: [x,y] (default lower third), size?, color?, highlight?: colour, mode?: "current"|"spoken", box?: highlight plate colour, plate?: colour behind the whole line, uppercase?: boolean, style?: "pop"|"fade"|"none", font?, name?}',
    apply: (p, compId, o) => {
      const comp = getComp(p, compId);
      let words: Word[] = (o.words as Word[]) ?? [];
      if (!words.length) {
        const cues: Cue[] = (o.cues as Cue[]) ?? (typeof o.srt === 'string' ? parseSubtitles(o.srt) : []);
        words = cuesToWords(cues);
      }
      if (!words.length) throw new Error('No captions: pass words, cues or srt');
      const off = n(o.offset, 0);
      const pages = paginate(words.map((w) => ({...w, start: w.start + off, end: w.end + off})), n(o.maxWords, 4), n(o.maxChars, 22));
      const pos = (o.position as Vec2) ?? [comp.width / 2, comp.height * 0.72];
      const size = n(o.size, Math.round(comp.width / 13));
      const style = s(o.style, 'pop');
      const created: string[] = [];
      pages.forEach((page, i) => {
        const start = page[0].start, next = pages[i + 1]?.[0].start;
        const end = Math.min(next ?? Infinity, page[page.length - 1].end + 0.35);
        const text = page.map((w) => (o.uppercase ? w.text.toUpperCase() : w.text)).join(' ');
        const layer = addLayer(p, comp.id, {
          type: 'text', name: `${s(o.name, 'caption')}-${i + 1}`, text, size, weight: 800, color: s(o.color, '#ffffff'), font: o.font as string | undefined,
          inPoint: r3(start), outPoint: r3(Math.max(end, start + 0.3)), maxWidth: comp.width * 0.86,
          transform: {position: pos},
          stroke: {color: '#000000', width: Math.max(4, Math.round(size * 0.1))},
          ...(o.plate ? {box: {color: s(o.plate, '#000000aa'), padding: [Math.round(size * 0.35), Math.round(size * 0.18)], radius: Math.round(size * 0.25)}} : {}),
          karaoke: {words: page.map((w) => [r3(w.start), r3(w.end)] as [number, number]), color: s(o.highlight, '#FFC93C'), mode: o.mode === 'spoken' ? 'spoken' : 'current', ...(o.box ? {box: s(o.box, '#E8692A')} : {})},
          animators: style === 'none' ? [] : style === 'fade'
            ? [{unit: 'line', duration: 0.18, ease: 'easeOut', from: {opacity: 0}}]
            : [{unit: 'word', stagger: 0.04, duration: 0.22, ease: 'backOut', from: {opacity: 0, scale: 70}}],
        } as NewLayer, 0);
        created.push(layer.id);
      });
      return {created, note: `${pages.length} caption pages from ${words.length} words`};
    },
  },
};
