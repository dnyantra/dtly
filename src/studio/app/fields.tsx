// Inspector inputs. Numbers are "scrubby" like After Effects: drag the value sideways to change it.
import {useRef, useState} from 'preact/hooks';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1));

export const NumberField = ({value, onChange, onDragStart, onDragEnd, step = 1, min, max, title}: {
  value: number; onChange: (v: number, dragging: boolean) => void; onDragStart?: () => void; onDragEnd?: () => void; step?: number; min?: number; max?: number; title?: string;
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{x: number; v: number; moved: boolean} | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  if (editing !== null) {
    return (
      <input class="num editing" value={editing} autoFocus title={title}
        onInput={(e) => setEditing((e.target as HTMLInputElement).value)}
        onBlur={() => { const n = Number(editing); if (Number.isFinite(n)) onChange(clamp(n), false); setEditing(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} />
    );
  }
  return (
    <span class="num" title={title ?? 'Drag to scrub, click to type'}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = {x: e.clientX, v: value, moved: false};
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) > 2) { d.moved = true; onDragStart?.(); }
        if (d.moved) onChange(clamp(+(d.v + dx * step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)).toFixed(4)), true);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) onDragEnd?.();
        else setEditing(fmt(value));
      }}>
      {fmt(value)}
    </span>
  );
};

export const VecField = ({value, onChange, onDragStart, onDragEnd, step = 1, labels = ['x', 'y']}: {
  value: number[]; onChange: (v: number[], dragging: boolean) => void; onDragStart?: () => void; onDragEnd?: () => void; step?: number; labels?: string[];
}) => (
  <span class="vec">
    {value.map((n, i) => (
      <span class="vec-item" key={i}>
        <label>{labels[i]}</label>
        <NumberField value={n} step={step} onDragStart={onDragStart} onDragEnd={onDragEnd} onChange={(v, d) => onChange(value.map((x, j) => (j === i ? v : x)), d)} />
      </span>
    ))}
  </span>
);

const toHex = (c: string) => {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`;
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) return `#${m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, '0')).join('')}`;
  return '#ffffff';
};

export const ColorField = ({value, onChange}: {value: string; onChange: (v: string) => void}) => (
  <span class="color">
    <input type="color" value={toHex(value)} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    <input class="text" value={value} onChange={(e) => onChange((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
  </span>
);

export const TextField = ({value, onChange, multiline}: {value: string; onChange: (v: string) => void; multiline?: boolean}) =>
  multiline ? (
    <textarea class="text" value={value} rows={3} onChange={(e) => onChange((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
  ) : (
    <input class="text" value={value} onChange={(e) => onChange((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
  );

export const Select = ({value, options, onChange}: {value: string; options: string[]; onChange: (v: string) => void}) => (
  <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);
