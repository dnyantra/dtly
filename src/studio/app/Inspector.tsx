// Properties panel: composition settings, layer properties with stopwatches, keyframe easing, raw JSON.
import {useEffect, useState} from 'preact/hooks';
import {val} from '../../core/anim.js';
import {applyEase, EASE_NAMES} from '../../core/ease.js';
import {isAnimated, type Composition, type Ease, type Layer, type Project} from '../../core/model.js';
import {duplicateLayer, findLayer, moveLayer, removeLayer, removeKeyframe, setEase, setKeyframe, setProperty, updateComp, updateLayer} from '../../ops/ops.js';
import {PRESETS} from '../../presets/index.js';
import {ColorField, NumberField, Select, TextField, VecField} from './fields.js';
import {currentComp, dragEnd, dragStart, dragUpdate, edit, getPath, getState, setState, snap, useStore} from './store.js';

type Kind = 'num' | 'vec' | 'color';

// One animatable property: value at the playhead, stopwatch, and keyframe navigation.
const Prop = ({layer, path, label, kind, fallback, step = 1, min, max}: {layer: Layer; path: string; label: string; kind: Kind; fallback: unknown; step?: number; min?: number; max?: number}) => {
  const time = useStore((s) => s.time);
  const comp = currentComp()!;
  const raw = getPath(layer, path);
  const animated = isAnimated(raw as never);
  const value = val(raw as never, time, fallback as never) as unknown;
  const t = snap(time, comp.fps);
  const apply = (p: Project, v: unknown) => (animated ? setKeyframe(p, layer.id, path, t, v) : setProperty(p, layer.id, path, v));
  const onChange = (v: unknown, dragging: boolean) => (dragging ? dragUpdate((p) => apply(p, v)) : edit((p) => apply(p, v)));
  const keys = animated ? (raw as {keyframes: {t: number}[]}).keyframes.map((k) => k.t) : [];
  const onKey = keys.some((k) => Math.abs(k - t) < 1e-3);
  const prev = [...keys].reverse().find((k) => k < t - 1e-3);
  const next = keys.find((k) => k > t + 1e-3);
  const toggleWatch = () => edit((p) => (animated ? setProperty(p, layer.id, path, value) : setKeyframe(p, layer.id, path, t, value)));
  const toggleKey = () => edit((p) => (onKey ? removeKeyframe(p, layer.id, path, t) : setKeyframe(p, layer.id, path, t, value)));
  return (
    <div class="prop">
      <button class={`watch ${animated ? 'on' : ''}`} title={animated ? 'Stop animating (keep current value)' : 'Animate: add a keyframe at the playhead'} onClick={toggleWatch}>⏱</button>
      <label>{label}</label>
      <span class="prop-value">
        {kind === 'num' && <NumberField value={Number(value ?? 0)} step={step} min={min} max={max} onChange={onChange} onDragStart={dragStart} onDragEnd={dragEnd} />}
        {kind === 'vec' && <VecField value={(value as number[]) ?? [0, 0]} step={step} onChange={onChange} onDragStart={dragStart} onDragEnd={dragEnd} />}
        {kind === 'color' && <ColorField value={String(value ?? '#ffffff')} onChange={(v) => onChange(v, false)} />}
      </span>
      {animated && (
        <span class="keynav">
          <button disabled={prev === undefined} onClick={() => setState({time: prev!})}>◀</button>
          <button class={onKey ? 'on' : ''} title={onKey ? 'Remove keyframe here' : 'Add keyframe here'} onClick={toggleKey}>◆</button>
          <button disabled={next === undefined} onClick={() => setState({time: next!})}>▶</button>
        </span>
      )}
    </div>
  );
};

const Field = ({label, children}: {label: string; children: preact.ComponentChildren}) => (
  <div class="prop"><span class="watch-space" /><label>{label}</label><span class="prop-value">{children}</span></div>
);

const set = (layer: Layer, patch: Record<string, unknown>) => edit((p) => updateLayer(p, layer.id, patch));
const num = (layer: Layer, label: string, key: string, value: number | undefined, fallback: number, step = 1) => (
  <Field label={label}><NumberField value={value ?? fallback} step={step} onChange={(v, d) => (d ? dragUpdate((p) => updateLayer(p, layer.id, {[key]: v})) : set(layer, {[key]: v}))} onDragStart={dragStart} onDragEnd={dragEnd} /></Field>
);

const Section = ({title, children, open = true}: {title: string; children: preact.ComponentChildren; open?: boolean}) => (
  <details class="section" open={open}><summary>{title}</summary>{children}</details>
);

const JsonEditor = ({value, onApply, rows = 8}: {value: unknown; onApply: (v: unknown) => void; rows?: number}) => {
  const text = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(text); setError(''); }, [text]);
  return (
    <div class="json">
      <textarea rows={rows} value={draft} spellcheck={false} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => e.stopPropagation()} />
      <div class="row">
        {error && <span class="error">{error}</span>}
        <button disabled={draft === text} onClick={() => { try { onApply(JSON.parse(draft)); setError(''); } catch (e) { setError((e as Error).message); } }}>Apply</button>
      </div>
    </div>
  );
};

const KeyPanel = () => {
  const key = useStore((s) => s.key);
  const project = useStore((s) => s.project);
  if (!key || !project) return null;
  let k: {t: number; v: unknown; ease?: Ease} | undefined;
  try {
    const {layer} = findLayer(project, key.layer);
    k = (getPath(layer, key.path) as {keyframes: {t: number; v: unknown; ease?: Ease}[]})?.keyframes?.find((x) => Math.abs(x.t - key.t) < 1e-3);
  } catch { /* layer gone */ }
  if (!k) return null;
  const ease = k.ease ?? 'linear';
  const mode = typeof ease === 'string' ? ease : Array.isArray(ease) ? 'bezier' : 'spring';
  const setE = (e: Ease) => edit((p) => setEase(p, key.layer, key.path, key.t, e));
  return (
    <Section title={`Keyframe · ${key.path} @ ${key.t}s`}>
      <Field label="Ease out">
        <Select value={mode} options={[...EASE_NAMES, 'bezier', 'spring']} onChange={(m) => setE(m === 'bezier' ? [0.25, 0.1, 0.25, 1] : m === 'spring' ? {spring: {stiffness: 170, damping: 18}} : (m as Ease))} />
      </Field>
      {Array.isArray(ease) && (
        <Field label="Bezier"><VecField value={ease} step={0.01} labels={['x1', 'y1', 'x2', 'y2']} onChange={(v, d) => (d ? dragUpdate((p) => setEase(p, key.layer, key.path, key.t, v as Ease)) : setE(v as Ease))} onDragStart={dragStart} onDragEnd={dragEnd} /></Field>
      )}
      {mode === 'spring' && typeof ease === 'object' && !Array.isArray(ease) && (
        <Field label="Spring"><VecField value={[ease.spring.stiffness ?? 170, ease.spring.damping ?? 18]} labels={['stiff', 'damp']} onChange={(v) => setE({spring: {stiffness: v[0], damping: v[1]}})} /></Field>
      )}
      <EaseGraph ease={ease} />
      <Field label="Value"><JsonEditor value={k.v} rows={2} onApply={(v) => edit((p) => setKeyframe(p, key.layer, key.path, key.t, v))} /></Field>
      <div class="row"><button onClick={() => { edit((p) => removeKeyframe(p, key.layer, key.path, key.t)); setState({key: null}); }}>Delete keyframe</button></div>
    </Section>
  );
};

// Small speed-graph style preview of the ease curve.
const EaseGraph = ({ease}: {ease: Ease}) => {
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    const y = applyEase(ease, x);
    pts.push(`${(x * 180 + 10).toFixed(1)},${(110 - y * 90).toFixed(1)}`);
  }
  return (
    <svg class="ease-graph" viewBox="0 0 200 130">
      <line x1="10" y1="110" x2="190" y2="110" /><line x1="10" y1="20" x2="190" y2="20" class="guide" />
      <polyline points={pts.join(' ')} />
    </svg>
  );
};

// Matches Renderer.layerSize: boxed layers anchor at their centre, others at the origin.
const defaultAnchor = (layer: Layer, comp: Composition): number[] => {
  if (layer.type === 'solid' || layer.type === 'image' || layer.type === 'video') return [(layer.size?.[0] ?? comp.width) / 2, (layer.size?.[1] ?? comp.height) / 2];
  if (layer.type === 'precomp') {
    const c = getState().project?.comps.find((x) => x.id === layer.comp);
    return [(c?.width ?? comp.width) / 2, (c?.height ?? comp.height) / 2];
  }
  return [0, 0];
};

const LayerPanel = ({layer, comp}: {layer: Layer; comp: Composition}) => {
  const others = comp.layers.filter((l) => l.id !== layer.id);
  const idx = comp.layers.indexOf(layer);
  const fonts = ['Baloo 2', 'Mukta', ...Object.keys(getState().project?.fonts ?? {})];
  return (
    <>
      <Section title={`${layer.type} · ${layer.id}`}>
        <Field label="Name"><TextField value={layer.name ?? ''} onChange={(v) => set(layer, {name: v || null})} /></Field>
        {num(layer, 'In', 'inPoint', layer.inPoint, 0, 1 / comp.fps)}
        {num(layer, 'Out', 'outPoint', layer.outPoint, comp.duration, 1 / comp.fps)}
        <Field label="Parent"><Select value={layer.parent ?? '(none)'} options={['(none)', ...others.map((l) => l.id)]} onChange={(v) => set(layer, {parent: v === '(none)' ? null : v})} /></Field>
        <Field label="Blend"><Select value={layer.blendMode ?? 'normal'} options={['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'softLight', 'difference']} onChange={(v) => set(layer, {blendMode: v === 'normal' ? null : v})} /></Field>
        <Field label="Motion blur"><input type="checkbox" checked={!!layer.motionBlur} onChange={(e) => set(layer, {motionBlur: (e.target as HTMLInputElement).checked ? {samples: 8} : null})} /></Field>
        <div class="row">
          <button disabled={idx <= 0} onClick={() => edit((p) => moveLayer(p, layer.id, idx - 1))}>Up</button>
          <button disabled={idx >= comp.layers.length - 1} onClick={() => edit((p) => moveLayer(p, layer.id, idx + 1))}>Down</button>
          <button onClick={() => edit((p) => { const c = duplicateLayer(p, layer.id); setState({layer: c.id}); })}>Duplicate</button>
          <button class="danger" onClick={() => { edit((p) => removeLayer(p, layer.id)); setState({layer: null, key: null}); }}>Delete</button>
        </div>
      </Section>

      {layer.type !== 'audio' && (
        <Section title="Transform">
          <Prop layer={layer} path="transform.position" label="Position" kind="vec" fallback={[comp.width / 2, comp.height / 2]} />
          <Prop layer={layer} path="transform.scale" label="Scale %" kind="vec" fallback={[100, 100]} />
          <Prop layer={layer} path="transform.rotation" label="Rotation °" kind="num" fallback={0} />
          <Prop layer={layer} path="transform.opacity" label="Opacity %" kind="num" fallback={100} min={0} max={100} />
          <Prop layer={layer} path="transform.anchor" label="Anchor" kind="vec" fallback={defaultAnchor(layer, comp)} />
          <Prop layer={layer} path="transform.skew" label="Skew °" kind="num" fallback={0} />
        </Section>
      )}

      {layer.type === 'text' && (
        <Section title="Text">
          <Field label="Text"><TextField multiline value={layer.text} onChange={(v) => set(layer, {text: v})} /></Field>
          <Prop layer={layer} path="size" label="Size" kind="num" fallback={72} min={1} />
          <Prop layer={layer} path="color" label="Color" kind="color" fallback="#ffffff" />
          <Prop layer={layer} path="tracking" label="Tracking" kind="num" fallback={0} />
          <Field label="Font"><Select value={layer.font ?? 'Baloo 2'} options={fonts} onChange={(v) => set(layer, {font: v})} /></Field>
          <Field label="Weight"><Select value={String(layer.weight ?? 700)} options={['400', '500', '600', '700', '800']} onChange={(v) => set(layer, {weight: Number(v)})} /></Field>
          <Field label="Align"><Select value={layer.align ?? 'center'} options={['left', 'center', 'right']} onChange={(v) => set(layer, {align: v})} /></Field>
          {num(layer, 'Max width', 'maxWidth', layer.maxWidth, 0, 5)}
          {num(layer, 'Line height', 'lineHeight', layer.lineHeight, 1.25, 0.01)}
          <Field label="Animators"><JsonEditor value={layer.animators ?? []} rows={6} onApply={(v) => set(layer, {animators: v})} /></Field>
          <div class="presets">
            {Object.entries(PRESETS).filter(([, pr]) => pr.kind === 'text').map(([name]) => (
              <button key={name} title={PRESETS[name].description} onClick={() => edit((p) => PRESETS[name].apply(p, comp.id, {layer: layer.id}))}>{name.slice(5)}</button>
            ))}
          </div>
        </Section>
      )}

      {layer.type === 'shape' && (
        <Section title="Shape">
          <Field label="Shape"><Select value={layer.shape} options={['rect', 'ellipse', 'polygon', 'path', 'line']} onChange={(v) => set(layer, {shape: v})} /></Field>
          {(layer.shape === 'rect' || layer.shape === 'ellipse') && <Prop layer={layer} path="size" label="Size" kind="vec" fallback={[200, 200]} />}
          {(layer.shape === 'rect' || layer.shape === 'polygon') && <Prop layer={layer} path="radius" label="Radius" kind="num" fallback={layer.shape === 'rect' ? 0 : 100} />}
          {(typeof layer.fill === 'string' || isAnimated(layer.fill as never) || layer.fill === undefined) && <Prop layer={layer} path="fill" label="Fill" kind="color" fallback="#ffffff" />}
          <Prop layer={layer} path="stroke" label="Stroke" kind="color" fallback="#ffffff" />
          <Prop layer={layer} path="strokeWidth" label="Stroke width" kind="num" fallback={4} min={0} />
          <Prop layer={layer} path="trim.start" label="Trim start %" kind="num" fallback={0} min={0} max={100} />
          <Prop layer={layer} path="trim.end" label="Trim end %" kind="num" fallback={100} min={0} max={100} />
        </Section>
      )}

      {layer.type === 'solid' && (
        <Section title="Solid"><Prop layer={layer} path="color" label="Color" kind="color" fallback="#000000" /></Section>
      )}

      {(layer.type === 'image' || layer.type === 'video') && (
        <Section title={layer.type === 'video' ? 'Video' : 'Image'}>
          <Field label="Source"><TextField value={layer.src} onChange={(v) => set(layer, {src: v})} /></Field>
          <Field label="Fit"><Select value={layer.fit ?? 'cover'} options={['cover', 'contain', 'fill']} onChange={(v) => set(layer, {fit: v})} /></Field>
          {layer.type === 'video' && num(layer, 'Trim in (s)', 'trimIn', layer.trimIn, 0, 0.05)}
          {layer.type === 'video' && num(layer, 'Speed', 'speed', layer.speed, 1, 0.01)}
          {layer.type === 'video' && <Prop layer={layer} path="volume" label="Volume" kind="num" fallback={0} step={0.01} min={0} max={1} />}
        </Section>
      )}

      {layer.type === 'audio' && (
        <Section title="Audio">
          <Field label="Source"><TextField value={layer.src} onChange={(v) => set(layer, {src: v})} /></Field>
          {num(layer, 'Trim in (s)', 'trimIn', layer.trimIn, 0, 0.05)}
          <Prop layer={layer} path="volume" label="Volume" kind="num" fallback={1} step={0.01} min={0} max={1} />
          {num(layer, 'Fade in (s)', 'fadeIn', layer.fadeIn, 0, 0.05)}
          {num(layer, 'Fade out (s)', 'fadeOut', layer.fadeOut, 0, 0.05)}
        </Section>
      )}

      {layer.type === 'precomp' && (
        <Section title="Precomp">
          <Field label="Comp"><Select value={layer.comp} options={getState().project!.comps.filter((c) => c.id !== comp.id).map((c) => c.id)} onChange={(v) => set(layer, {comp: v})} /></Field>
          {num(layer, 'Time offset', 'timeOffset', layer.timeOffset, 0, 0.05)}
          <div class="row"><button onClick={() => setState({comp: layer.comp, layer: null, key: null, time: 0})}>Open comp</button></div>
        </Section>
      )}

      <Section title="Effects, masks & matte (JSON)" open={false}>
        <Field label="Effects"><JsonEditor value={layer.effects ?? []} rows={5} onApply={(v) => set(layer, {effects: v})} /></Field>
        <Field label="Masks"><JsonEditor value={layer.masks ?? []} rows={4} onApply={(v) => set(layer, {masks: v})} /></Field>
        <Field label="Matte"><JsonEditor value={layer.matte ?? null} rows={2} onApply={(v) => set(layer, {matte: v})} /></Field>
      </Section>
      <Section title="Layer JSON" open={false}>
        <JsonEditor value={layer} rows={16} onApply={(v) => edit((p) => {
          const next = v as Layer;
          if (next.id !== layer.id) throw new Error('The id cannot change here');
          const c = p.comps.find((x) => x.id === comp.id)!;
          c.layers[c.layers.findIndex((l) => l.id === layer.id)] = next;
        })} />
      </Section>
    </>
  );
};

const CompPanel = ({comp}: {comp: Composition}) => {
  const project = getState().project!;
  const up = (patch: Partial<Composition>) => edit((p) => updateComp(p, comp.id, patch));
  return (
    <Section title={`Composition · ${comp.id}`}>
      <Field label="Name"><TextField value={comp.name ?? ''} onChange={(v) => up({name: v || undefined})} /></Field>
      <Field label="Size"><VecField value={[comp.width, comp.height]} labels={['w', 'h']} onChange={(v) => up({width: Math.round(v[0]), height: Math.round(v[1])})} /></Field>
      <Field label="FPS"><NumberField value={comp.fps} onChange={(v) => up({fps: Math.max(1, Math.round(v))})} /></Field>
      <Field label="Duration (s)"><NumberField value={comp.duration} step={0.1} min={0.1} onChange={(v) => up({duration: v})} /></Field>
      <Field label="Background"><ColorField value={comp.background ?? '#000000'} onChange={(v) => up({background: v})} /></Field>
      <Field label="Markers"><JsonEditor value={comp.markers ?? []} rows={3} onApply={(v) => up({markers: v as Composition['markers']})} /></Field>
      {project.root !== comp.id && <div class="row"><button onClick={() => edit((p) => { p.root = comp.id; })}>Render this comp</button></div>}
    </Section>
  );
};

export const Inspector = () => {
  const project = useStore((s) => s.project);
  const compId = useStore((s) => s.comp);
  const layerId = useStore((s) => s.layer);
  const comp = project?.comps.find((c) => c.id === compId);
  if (!comp) return <aside class="inspector" />;
  const layer = comp.layers.find((l) => l.id === layerId);
  return (
    <aside class="inspector">
      <KeyPanel />
      {layer ? <LayerPanel key={layer.id} layer={layer} comp={comp} /> : <CompPanel comp={comp} />}
    </aside>
  );
};
