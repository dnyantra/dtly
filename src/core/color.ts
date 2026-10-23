export type RGBA = [number, number, number, number];

const NAMED: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', transparent: '#00000000', gray: '#808080', grey: '#808080',
};

export const parseColor = (c: string): RGBA | null => {
  const s = (NAMED[c.trim().toLowerCase()] ?? c).trim();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
};

export const rgbaString = ([r, g, b, a]: RGBA) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.max(0, Math.min(1, a)).toFixed(4)})`;

export const withAlpha = (c: string, alpha: number) => {
  const p = parseColor(c);
  return p ? rgbaString([p[0], p[1], p[2], p[3] * alpha]) : c;
};
