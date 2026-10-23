// Captions: SRT/VTT/JSON parsing, word timing and paging into short on-screen phrases.
export interface Cue { start: number; end: number; text: string }
export interface Word { text: string; start: number; end: number }

const time = (s: string) => {
  const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return NaN;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
};

// Parses SRT or WebVTT into cues.
export const parseSubtitles = (src: string): Cue[] => {
  const cues: Cue[] = [];
  for (const block of src.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({start: time(a), end: time(b.split(/\s+/).filter(Boolean)[0] ?? b), text});
  }
  return cues.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end));
};

// Spreads each cue's time across its words, weighted by length (cues only have phrase timing).
export const cuesToWords = (cues: Cue[]): Word[] =>
  cues.flatMap((c) => {
    const words = c.text.split(/\s+/).filter(Boolean);
    const weights = words.map((w) => Math.max(1, [...w].length) + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = c.start;
    return words.map((w, i) => {
      const d = ((c.end - c.start) * weights[i]) / total;
      const out = {text: w, start: +t.toFixed(3), end: +(t + d).toFixed(3)};
      t += d;
      return out;
    });
  });

// Groups words into on-screen pages: at most `maxWords` / `maxChars`, breaking after punctuation
// and on pauses, the way short-form video captions read.
export const paginate = (words: Word[], maxWords = 4, maxChars = 22): Word[][] => {
  const pages: Word[][] = [];
  let cur: Word[] = [];
  const len = (ws: Word[]) => ws.reduce((a, w) => a + [...w.text].length + 1, 0);
  for (const w of words) {
    const pause = cur.length && w.start - cur[cur.length - 1].end > 0.6;
    if (cur.length && (cur.length >= maxWords || len([...cur, w]) > maxChars || pause)) { pages.push(cur); cur = []; }
    cur.push(w);
    if (/[.!?।,;:]$/.test(w.text) && cur.length >= 2) { pages.push(cur); cur = []; }
  }
  if (cur.length) pages.push(cur);
  return pages;
};
