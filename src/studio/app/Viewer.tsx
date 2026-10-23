// Live preview: the shared Renderer drawing into a <canvas>, plus a selection overlay.
import {useEffect, useRef, useState} from 'preact/hooks';
import {val} from '../../core/anim.js';
import {isAnimated, type Vec2} from '../../core/model.js';
import {setKeyframe, setProperty} from '../../ops/ops.js';
import {Renderer} from '../../render/renderer.js';
import {hitTest, layerQuad} from './geometry.js';
import {BrowserHost} from './host.js';
import {currentComp, dragEnd, dragStart, dragUpdate, getState, setState, snap, useStore} from './store.js';

export const host = new BrowserHost();
let renderer: Renderer | null = null;
// Frames render off-screen and are shown only when complete (no half-drawn frames while seeking video).
const back = document.createElement('canvas');

export const Viewer = () => {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const compId = useStore((s) => s.comp);
  const selected = useStore((s) => s.layer);
  const playing = useStore((s) => s.playing);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({w: 400, h: 600});
  const [renderMs, setRenderMs] = useState(0);
  const busy = useRef(false);
  const pending = useRef(false);
  const comp = project?.comps.find((c) => c.id === compId);

  // Fit the comp into the available space.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({w: el.clientWidth - 24, h: el.clientHeight - 24}));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = comp ? Math.min(box.w / comp.width, box.h / comp.height) : 1;

  const draw = async () => {
    if (busy.current) { pending.current = true; return; }
    const s = getState();
    const c = currentComp();
    if (!s.project || !c || !canvas.current) return;
    busy.current = true;
    try {
      if (!renderer) renderer = new Renderer(s.project, host);
      renderer.project = s.project;
      host.playing = s.playing;
      const el = canvas.current;
      if (back.width !== c.width || back.height !== c.height) { back.width = c.width; back.height = c.height; }
      const ctx = back.getContext('2d')!;
      const t0 = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      if (!c.background) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); }
      await renderer.renderComp(ctx, c, s.time);
      host.endFrame();
      if (el.width !== c.width || el.height !== c.height) { el.width = c.width; el.height = c.height; }
      el.getContext('2d')!.drawImage(back, 0, 0);
      el.dataset.time = String(s.time);
      setRenderMs(performance.now() - t0);
      drawOverlay();
    } catch (e) {
      setState({message: `Preview error: ${(e as Error).message}`});
    } finally {
      busy.current = false;
      if (pending.current) { pending.current = false; draw(); }
    }
  };

  const drawOverlay = () => {
    const s = getState();
    const c = currentComp();
    const o = overlay.current;
    if (!o || !c || !renderer) return;
    if (o.width !== c.width || o.height !== c.height) { o.width = c.width; o.height = c.height; }
    const ctx = o.getContext('2d')!;
    ctx.clearRect(0, 0, o.width, o.height);
    const layer = c.layers.find((l) => l.id === s.layer);
    if (!layer || s.playing || !renderer.isActive(layer, c, s.time)) return;
    const quad = layerQuad(layer, c, s.time, renderer, ctx);
    const lw = 2 / scale;
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = lw;
    if (quad) {
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.stroke();
    }
    const [px, py] = val(layer.transform?.position, s.time, [c.width / 2, c.height / 2] as Vec2);
    ctx.beginPath();
    ctx.arc(px, py, 6 / scale, 0, Math.PI * 2);
    ctx.moveTo(px - 12 / scale, py); ctx.lineTo(px + 12 / scale, py);
    ctx.moveTo(px, py - 12 / scale); ctx.lineTo(px, py + 12 / scale);
    ctx.stroke();
  };

  useEffect(() => { draw(); }, [project, time, compId, playing]);
  useEffect(() => { drawOverlay(); }, [selected, scale]);

  // Click selects the topmost layer; dragging moves the selected layer (keyframing if animated).
  const toComp = (e: PointerEvent): Vec2 => {
    const r = overlay.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * comp!.width, ((e.clientY - r.top) / r.height) * comp!.height];
  };
  const drag = useRef<{start: Vec2; pos: Vec2; layer: string; moved: boolean} | null>(null);
  const onDown = (e: PointerEvent) => {
    if (!comp || !renderer) return;
    const pt = toComp(e);
    const s = getState();
    const ctx = overlay.current!.getContext('2d')!;
    const target = hitTest(pt, comp, s.time, renderer, ctx);
    setState({layer: target, key: null});
    if (!target) return;
    const layer = comp.layers.find((l) => l.id === target)!;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {start: pt, pos: val(layer.transform?.position, s.time, [comp.width / 2, comp.height / 2] as Vec2), layer: target, moved: false};
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !comp) return;
    const pt = toComp(e);
    const dx = pt[0] - d.start[0], dy = pt[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
    if (!d.moved) { d.moved = true; dragStart(); }
    const t = snap(getState().time, comp.fps);
    const next: Vec2 = [Math.round(d.pos[0] + dx), Math.round(d.pos[1] + (e.shiftKey ? 0 : dy))];
    dragUpdate((p) => {
      const layer = p.comps.find((c) => c.id === comp.id)!.layers.find((l) => l.id === d.layer)!;
      if (isAnimated(layer.transform?.position)) setKeyframe(p, d.layer, 'transform.position', t, next);
      else setProperty(p, d.layer, 'transform.position', next);
    });
  };
  const onUp = () => { if (drag.current?.moved) dragEnd(); drag.current = null; };

  if (!comp) return <div class="viewer" ref={wrap} />;
  const style = {width: `${comp.width * scale}px`, height: `${comp.height * scale}px`};
  return (
    <div class="viewer" ref={wrap}>
      <div class="stage" style={style}>
        <canvas ref={canvas} class="frame" style={style} />
        <canvas ref={overlay} class="overlay" style={style} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
      </div>
      <div class="viewer-info">{comp.width}×{comp.height} · {Math.round(scale * 100)}% · {renderMs.toFixed(0)} ms/frame</div>
    </div>
  );
};
