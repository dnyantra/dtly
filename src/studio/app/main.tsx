// DT.ly Studio — browser preview and timeline editor.
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import type {NewLayer} from '../../core/model.js';
import {addComp, addLayer, removeKeyframe, removeLayer, shiftLayer, duplicateLayer, updateLayer} from '../../ops/ops.js';
import {PRESETS} from '../../presets/index.js';
import {config} from './config.js';
import {AudioPreview, loadFonts} from './host.js';
import {Inspector} from './Inspector.js';
import {connectEvents, currentComp, edit, getState, load, redo, selectedLayer, setState, snap, startRender, undo, useStore} from './store.js';
import {keyTimes, Timeline} from './Timeline.js';
import {host, Viewer} from './Viewer.js';
import './styles.css';

const audio = new AudioPreview();

// --- playback -------------------------------------------------------------------------------
let raf = 0;
const play = () => {
  const comp = currentComp();
  if (!comp) return;
  if (getState().time >= comp.duration - 1 / comp.fps) setState({time: 0});
  const start = performance.now() - getState().time * 1000;
  setState({playing: true});
  const tick = (now: number) => {
    const s = getState();
    const c = currentComp();
    if (!s.playing || !c) return;
    let t = (now - start) / 1000;
    if (t >= c.duration) {
      if (s.loop) { t = 0; stop(); setState({time: 0}); play(); return; }
      stop();
      setState({time: snap(c.duration - 1 / c.fps, c.fps)});
      return;
    }
    setState({time: t});
    audio.sync(s.project!, c, t, true);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
};
const stop = () => {
  cancelAnimationFrame(raf);
  const c = currentComp();
  setState({playing: false, time: c ? snap(getState().time, c.fps) : getState().time});
  audio.stop();
  host.stopAll();
};
const toggle = () => (getState().playing ? stop() : play());

// --- adding layers --------------------------------------------------------------------------
const addAndSelect = (layer: NewLayer) => {
  const comp = currentComp()!;
  let id = '';
  edit((p) => { id = addLayer(p, comp.id, {inPoint: snap(getState().time, comp.fps), ...layer} as NewLayer).id; });
  if (id) setState({layer: id, key: null});
};
const ADD: Record<string, () => void> = {
  Text: () => addAndSelect({type: 'text', name: 'Text', text: 'Your text', size: Math.round(currentComp()!.width / 10), color: '#ffffff', weight: 800} as NewLayer),
  Shape: () => addAndSelect({type: 'shape', name: 'Shape', shape: 'ellipse', size: [300, 300], fill: '#E8692A'} as NewLayer),
  Solid: () => addAndSelect({type: 'solid', name: 'Solid', color: '#1f2933'} as NewLayer),
  Null: () => addAndSelect({type: 'null', name: 'Null'} as NewLayer),
  'Image / video / audio…': () => {
    const src = prompt('Path to the file, relative to the project file:');
    if (!src) return;
    const type = /\.(mp4|mov|webm|m4v)$/i.test(src) ? 'video' : /\.(mp3|wav|m4a|aac|ogg)$/i.test(src) ? 'audio' : 'image';
    addAndSelect({type, name: src.split('/').pop(), src} as NewLayer);
  },
  'New comp (precomp)…': () => {
    const id = prompt('Id for the new composition:');
    if (!id) return;
    const comp = currentComp()!;
    edit((p) => { addComp(p, {id, name: id, duration: comp.duration, width: comp.width, height: comp.height, fps: comp.fps}); });
    addAndSelect({type: 'precomp', name: id, comp: id} as NewLayer);
  },
};

// --- presets dialog -------------------------------------------------------------------------
const PresetDialog = ({onClose}: {onClose: () => void}) => {
  const layer = selectedLayer();
  const [name, setName] = useState(layer?.type === 'text' ? 'text.fadeUp' : 'opener.logoReveal');
  const preset = PRESETS[name];
  const defaults = (n: string) => {
    const p = PRESETS[n];
    if (p.kind === 'text' || n === 'element.highlightWord') return {layer: getState().layer ?? ''};
    if (n === 'opener.logoReveal' || n === 'opener.bars') return {title: 'Your Brand', start: snap(getState().time, 30)};
    if (n === 'kinetic.sequence') return {phrases: ['Make', 'it', 'move'], start: snap(getState().time, 30), style: 'slam'};
    if (n === 'element.lowerThird') return {name: 'Your Name', title: 'Your title', start: snap(getState().time, 30)};
    if (n === 'transition.between') return {from: '', to: '', type: 'push', duration: 0.5};
    if (n === 'slides.slideshow') return {items: [{src: 'photo1.jpg', caption: 'Caption'}], each: 3, transition: 'push'};
    return {};
  };
  const [params, setParams] = useState(JSON.stringify(defaults(name), null, 2));
  const [error, setError] = useState('');
  const groups = ['text', 'kinetic', 'opener', 'slides', 'transition', 'element'];
  return (
    <div class="modal" onClick={onClose}>
      <div class="dialog" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div class="dialog-list">
          {groups.map((g) => (
            <div key={g}>
              <div class="group">{g}</div>
              {Object.entries(PRESETS).filter(([, p]) => p.kind === g).map(([n]) => (
                <button key={n} class={n === name ? 'active' : ''} onClick={() => { setName(n); setParams(JSON.stringify(defaults(n), null, 2)); setError(''); }}>{n.split('.')[1]}</button>
              ))}
            </div>
          ))}
        </div>
        <div class="dialog-body">
          <h3>{name}</h3>
          <p>{preset.description}</p>
          <p class="hint">Params: {preset.params}</p>
          <textarea rows={10} value={params} spellcheck={false} onInput={(e) => setParams((e.target as HTMLTextAreaElement).value)} />
          {error && <div class="error">{error}</div>}
          <div class="row">
            <button onClick={onClose}>Cancel</button>
            <button class="primary" onClick={() => {
              try {
                const parsed = JSON.parse(params);
                let created: string[] = [];
                const before = getState().project;
                edit((p) => { created = preset.apply(p, getState().comp, parsed).created; });
                if (getState().project === before) throw new Error(getState().message || 'Preset failed');
                if (created[0]) setState({layer: created[0]});
                onClose();
              } catch (e) { setError((e as Error).message); }
            }}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- keyboard -------------------------------------------------------------------------------
const onKey = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement;
  if (target.closest?.('input, textarea, select')) return;
  const s = getState();
  const comp = currentComp();
  if (!comp) return;
  const mod = e.metaKey || e.ctrlKey;
  const frame = 1 / comp.fps;
  const go = (t: number) => setState({time: Math.max(0, Math.min(comp.duration, snap(t, comp.fps))), playing: false});
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'd' && s.layer) { e.preventDefault(); edit((p) => { const c = duplicateLayer(p, s.layer!); setState({layer: c.id}); }); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(s.time - frame * (e.shiftKey ? 10 : 1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(s.time + frame * (e.shiftKey ? 10 : 1)); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(comp.duration - frame);
  else if ((e.key === 'j' || e.key === 'k') && s.layer) {
    const ts = keyTimes(s.layer);
    const t = e.key === 'j' ? [...ts].reverse().find((x) => x < s.time - 1e-3) : ts.find((x) => x > s.time + 1e-3);
    if (t !== undefined) go(t);
  }
  else if (e.key === '[' && s.layer) edit((p) => { const l = p.comps.find((c) => c.id === comp.id)!.layers.find((x) => x.id === s.layer)!; shiftLayer(p, s.layer!, snap(s.time, comp.fps) - (l.inPoint ?? 0)); });
  else if (e.key === ']' && s.layer) edit((p) => updateLayer(p, s.layer!, {outPoint: snap(s.time, comp.fps)}));
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (s.key) { edit((p) => removeKeyframe(p, s.key!.layer, s.key!.path, s.key!.t)); setState({key: null}); }
    else if (s.layer) { edit((p) => removeLayer(p, s.layer!)); setState({layer: null}); }
  }
  else if (e.key === 'Escape') setState({layer: null, key: null});
  else if (e.key === '=' || e.key === '+') setState({zoom: Math.min(2000, s.zoom * 1.25)});
  else if (e.key === '-') setState({zoom: Math.max(10, s.zoom / 1.25)});
};

// --- layout ---------------------------------------------------------------------------------
const fmtTime = (t: number, fps: number) => {
  const f = Math.round(t * fps);
  const sec = Math.floor(f / fps);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`;
};

const Transport = () => {
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const loop = useStore((s) => s.loop);
  const zoom = useStore((s) => s.zoom);
  const comp = currentComp();
  if (!comp) return null;
  return (
    <div class="transport">
      <button title="Start (Home)" onClick={() => setState({time: 0})}>⏮</button>
      <button title="Previous frame (←)" onClick={() => setState({time: Math.max(0, snap(time - 1 / comp.fps, comp.fps))})}>◀︎</button>
      <button class="play" title="Play / pause (Space)" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
      <button title="Next frame (→)" onClick={() => setState({time: Math.min(comp.duration, snap(time + 1 / comp.fps, comp.fps))})}>▶︎</button>
      <button class={loop ? 'on' : ''} title="Loop" onClick={() => setState({loop: !loop})}>⟲</button>
      <span class="timecode">{fmtTime(time, comp.fps)}</span>
      <span class="muted">{time.toFixed(2)}s / {comp.duration}s</span>
      <span class="spacer" />
      <span class="muted">Zoom</span>
      <button onClick={() => setState({zoom: Math.max(10, zoom / 1.25)})}>−</button>
      <button onClick={() => setState({zoom: Math.min(2000, zoom * 1.25)})}>+</button>
    </div>
  );
};

const TopBar = ({onPresets}: {onPresets: () => void}) => {
  const project = useStore((s) => s.project);
  const compId = useStore((s) => s.comp);
  const status = useStore((s) => s.status);
  const message = useStore((s) => s.message);
  const warnings = useStore((s) => s.warnings);
  const rend = useStore((s) => s.render);
  const [menu, setMenu] = useState(false);
  return (
    <header class="topbar">
      <div class="brand"><b>DT.ly</b> Studio <span class="muted">· {config.file}</span></div>
      <nav class="comps">
        {project?.comps.map((c) => (
          <button key={c.id} class={c.id === compId ? 'active' : ''} onClick={() => { stop(); setState({comp: c.id, layer: null, key: null, time: 0}); }}>
            {c.name ?? c.id}{project.root === c.id ? ' ★' : ''}
          </button>
        ))}
      </nav>
      <div class="actions">
        <div class="menu-wrap">
          <button onClick={() => setMenu(!menu)}>+ Layer ▾</button>
          {menu && <div class="menu" onMouseLeave={() => setMenu(false)}>{Object.entries(ADD).map(([k, fn]) => <button key={k} onClick={() => { setMenu(false); fn(); }}>{k}</button>)}</div>}
        </div>
        <button onClick={onPresets}>Presets…</button>
        <button title="Undo (⌘Z)" onClick={undo}>↶</button>
        <button title="Redo (⇧⌘Z)" onClick={redo}>↷</button>
        <button class="primary" disabled={rend.active} onClick={() => { stop(); startRender(); }}>
          {rend.active ? `Rendering ${rend.total ? Math.round(((rend.done ?? 0) / rend.total) * 100) : 0}%` : 'Render MP4'}
        </button>
      </div>
      <div class={`status ${status}`} title={warnings.join('\n')}>
        {message || (status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : status === 'reloaded' ? 'Reloaded from disk' : 'Saved')}
        {warnings.length > 0 && <span class="warn"> · {warnings.length} warning{warnings.length > 1 ? 's' : ''}</span>}
        {rend.out && !rend.active && <a href={`/api/media?src=${encodeURIComponent(rend.out)}&token=${config.token}`} target="_blank"> · open {rend.out}</a>}
        {rend.error && <span class="error"> · render failed: {rend.error}</span>}
      </div>
    </header>
  );
};

const App = () => {
  const project = useStore((s) => s.project);
  const [presets, setPresets] = useState(false);
  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  if (!project) return <div class="loading">Loading project…</div>;
  return (
    <div class="app">
      <TopBar onPresets={() => setPresets(true)} />
      <main class="workspace">
        <Viewer />
        <Inspector />
      </main>
      <section class="bottom">
        <Transport />
        <Timeline />
      </section>
      {presets && <PresetDialog onClose={() => setPresets(false)} />}
    </div>
  );
};

(async () => {
  document.title = `${config.file} — DT.ly Studio`;
  await load();
  // Fit the whole comp into the timeline width on open.
  const c = currentComp();
  if (c) setState({zoom: Math.max(20, Math.min(400, (window.innerWidth - 260) / c.duration))});
  await loadFonts(getState().project!);
  connectEvents();
  render(<App />, document.getElementById('root')!);
})();

