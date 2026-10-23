// Timeline: ruler, layer bars (move / trim), keyframe rows (drag to retime, click to edit).
import {useRef} from 'preact/hooks';
import {val} from '../../core/anim.js';
import type {Keyframe, Layer} from '../../core/model.js';
import {findLayer, moveKeyframe, setKeyframe, shiftLayer, updateLayer} from '../../ops/ops.js';
import {animatedPaths, dragEnd, dragStart, dragUpdate, edit, getPath, getState, setState, snap, useStore} from './store.js';

const LABEL_W = 230;
const TYPE_COLOR: Record<string, string> = {text: '#e0a84a', shape: '#5fb3a0', solid: '#9b7fd1', image: '#5b9bd5', video: '#d36c6c', audio: '#7fb35f', precomp: '#c78bc0', lottie: '#4fc1c9', adjustment: '#b0b0b0', null: '#888'};
const PROP_LABEL = (path: string) => path.replace(/^transform\./, '').replace(/\.(\d+)\./g, '[$1].');

const ticks = (duration: number, zoom: number) => {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  const step = steps.find((s) => s * zoom >= 60) ?? 60;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) out.push(+t.toFixed(3));
  return {out, step};
};

// Follows a drag on window, so re-renders of the dragged element can't interrupt it.
const trackPointer = (move: (e: PointerEvent) => void, done: () => void) => {
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); done(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
};

const keyShape = (k: Keyframe<unknown>) => (k.ease === 'hold' ? 'hold' : !k.ease || k.ease === 'linear' ? 'linear' : 'eased');

export const Timeline = () => {
  const project = useStore((s) => s.project);
  const compId = useStore((s) => s.comp);
  const time = useStore((s) => s.time);
  const zoom = useStore((s) => s.zoom);
  const sel = useStore((s) => s.layer);
  const key = useStore((s) => s.key);
  const expanded = useStore((s) => s.expanded);
  const tracks = useRef<HTMLDivElement>(null);
  const comp = project?.comps.find((c) => c.id === compId);
  if (!comp) return <div class="timeline" />;

  const width = comp.duration * zoom + 120;
  const fps = comp.fps;
  const xToTime = (clientX: number) => {
    const r = tracks.current!.getBoundingClientRect();
    return Math.max(0, Math.min(comp.duration, (clientX - r.left - LABEL_W + tracks.current!.scrollLeft) / zoom));
  };
  // Snap to frames, and to the playhead when close.
  const snapT = (t: number) => {
    const ct = getState().time;
    return Math.abs(t - ct) * zoom < 6 ? ct : snap(t, fps);
  };

  const scrub = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setState({time: snap(xToTime(e.clientX), fps), playing: false});
  };
  const scrubMove = (e: PointerEvent) => {
    if ((e.buttons & 1) === 0) return;
    setState({time: snap(xToTime(e.clientX), fps)});
  };

  const barDrag = (e: PointerEvent, layer: Layer, mode: 'move' | 'in' | 'out') => {
    e.stopPropagation();
    setState({layer: layer.id, key: null});
    const x0 = e.clientX;
    const inP = layer.inPoint ?? 0, outP = layer.outPoint ?? comp.duration;
    let started = false;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      if (!started) { if (Math.abs(ev.clientX - x0) < 3) return; started = true; dragStart(); }
      dragUpdate((p) => {
        if (mode === 'move') {
          const target = snapT(inP + dt);
          shiftLayer(p, layer.id, target - inP);
        } else if (mode === 'in') updateLayer(p, layer.id, {inPoint: Math.min(outP - 1 / fps, Math.max(0, snapT(inP + dt)))});
        else updateLayer(p, layer.id, {outPoint: Math.max(inP + 1 / fps, snapT(outP + dt))});
      });
    };
    trackPointer(move, () => { if (started) dragEnd(); });
  };

  const keyDrag = (e: PointerEvent, layer: Layer, path: string, k: Keyframe<unknown>) => {
    e.stopPropagation();
    setState({layer: layer.id, key: {layer: layer.id, path, t: k.t}, time: e.altKey ? getState().time : k.t, playing: false});
    const x0 = e.clientX, t0 = k.t;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) { if (Math.abs(ev.clientX - x0) < 3) return; started = true; dragStart(); }
      const to = Math.max(0, snapT(t0 + (ev.clientX - x0) / zoom));
      dragUpdate((p) => moveKeyframe(p, layer.id, path, t0, to));
      setState({key: {layer: layer.id, path, t: to}, time: to});
    };
    trackPointer(move, () => { if (started) dragEnd(); });
  };

  // Double-click a property row: add a keyframe there with the value the property has at that time.
  const addKeyAt = (e: MouseEvent, layer: Layer, path: string) => {
    const t = snap(xToTime(e.clientX), fps);
    const cur = getPath(layer, path);
    const v = val(cur as never, t, undefined as never);
    edit((p) => setKeyframe(p, layer.id, path, t, v));
    setState({key: {layer: layer.id, path, t}, time: t});
  };

  const {out: tickList} = ticks(comp.duration, zoom);
  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setState({zoom: Math.min(2000, Math.max(10, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))});
  };

  return (
    <div class="timeline">
      <div class="tl-scroll" ref={tracks} onWheel={onWheel}>
        <div class="tl-inner" style={{width: `${LABEL_W + width}px`}}>
          <div class="tl-ruler-row">
            <div class="tl-label tl-corner">{comp.name ?? comp.id} · {comp.fps} fps</div>
            <div class="tl-ruler" style={{width: `${width}px`}} onPointerDown={scrub} onPointerMove={scrubMove}>
              {tickList.map((t) => <div key={t} class="tick" style={{left: `${t * zoom}px`}}><span>{t}s</span></div>)}
              {(comp.markers ?? []).map((m) => <div key={m.t} class="marker" style={{left: `${m.t * zoom}px`}} title={m.label} />)}
              <div class="tl-end" style={{left: `${comp.duration * zoom}px`}} />
            </div>
          </div>
          {comp.layers.map((layer, idx) => {
            const inP = layer.inPoint ?? 0, outP = layer.outPoint ?? comp.duration;
            const props = animatedPaths(layer);
            const open = expanded[layer.id];
            return (
              <div key={layer.id} class={`tl-group ${sel === layer.id ? 'selected' : ''}`}>
                <div class="tl-row layer-row">
                  <div class="tl-label" onPointerDown={() => setState({layer: layer.id, key: null})}>
                    <button class={`twirl ${open ? 'open' : ''} ${props.length ? '' : 'empty'}`} onClick={(e) => { e.stopPropagation(); setState({expanded: {...expanded, [layer.id]: !open}}); }}>▸</button>
                    <button class={`eye ${layer.hidden ? 'off' : ''}`} title="Show/hide" onClick={(e) => { e.stopPropagation(); edit((p) => updateLayer(p, layer.id, {hidden: layer.hidden ? null : true})); }}>●</button>
                    <span class="idx">{idx + 1}</span>
                    <span class="chip" style={{background: TYPE_COLOR[layer.type]}} />
                    <span class="name" title={layer.id}>{layer.name ?? layer.id}</span>
                  </div>
                  <div class="tl-track" style={{width: `${width}px`}} onPointerDown={scrub} onPointerMove={scrubMove}>
                    <div class={`bar ${layer.hidden ? 'hidden' : ''}`} style={{left: `${inP * zoom}px`, width: `${Math.max(2, (outP - inP) * zoom)}px`, background: TYPE_COLOR[layer.type]}}
                      onPointerDown={(e) => barDrag(e, layer, 'move')}>
                      <span class="handle in" onPointerDown={(e) => barDrag(e, layer, 'in')} />
                      <span class="bar-name">{layer.type === 'text' ? layer.text.split('\n')[0] : layer.name ?? layer.id}</span>
                      <span class="handle out" onPointerDown={(e) => barDrag(e, layer, 'out')} />
                    </div>
                    {!open && props.flatMap((pr) => pr.keyframes.map((k) => <span key={`${pr.path}${k.t}`} class="mini-key" style={{left: `${k.t * zoom}px`}} />))}
                  </div>
                </div>
                {open && props.map((pr) => (
                  <div key={pr.path} class="tl-row prop-row">
                    <div class="tl-label prop-label" title={pr.path}>{PROP_LABEL(pr.path)}</div>
                    <div class="tl-track" style={{width: `${width}px`}} onPointerDown={scrub} onPointerMove={scrubMove} onDblClick={(e) => addKeyAt(e, layer, pr.path)}>
                      {pr.keyframes.map((k, i) => {
                        const next = pr.keyframes[i + 1];
                        return next ? <span key={`seg${k.t}`} class={`seg ${keyShape(k)}`} style={{left: `${k.t * zoom}px`, width: `${(next.t - k.t) * zoom}px`}} /> : null;
                      })}
                      {pr.keyframes.map((k, ki) => {
                        const active = key && key.layer === layer.id && key.path === pr.path && Math.abs(key.t - k.t) < 1e-3;
                        return <span key={ki} class={`key ${keyShape(k)} ${active ? 'active' : ''}`} style={{left: `${k.t * zoom}px`}} title={`${k.t}s = ${JSON.stringify(k.v)}${k.ease ? ` · ${typeof k.ease === 'string' ? k.ease : JSON.stringify(k.ease)}` : ''}`}
                          onPointerDown={(e) => keyDrag(e, layer, pr.path, k)} />;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          <div class="playhead" style={{left: `${LABEL_W + time * zoom}px`}} />
        </div>
      </div>
    </div>
  );
};

// Helpers used by keyboard shortcuts.
export const keyTimes = (layerId: string) => {
  const s = getState();
  if (!s.project) return [];
  const {layer} = findLayer(s.project, layerId);
  return [...new Set(animatedPaths(layer).flatMap((p) => p.keyframes.map((k) => k.t)))].sort((a, b) => a - b);
};
