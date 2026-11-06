import {useEffect, useRef, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import type {SyncStatus} from '../customerpro/sync.js';
import type {AnalysisFile, ExportProgress, GradeName, ProjectSummary, SourceState} from '../shared/types.js';
import {AccountPanel} from './Account.js';
import {DirectorPanel} from './director/DirectorPanel.js';
import {FinalExport} from './ExportFinal.js';
import {call, errMsg, fmtBytes, fmtDur, join, mediaUrl, on} from './api.js';

type Props = {account: AccountState; project: ProjectSummary; studioUrl: string; onClose: () => void};

export const ProjectView = ({account, project, studioUrl, onClose}: Props) => {
  const dir = project.dir;
  const [tab, setTab] = useState<'export' | 'sync' | 'director'>('export');
  const [showAccount, setShowAccount] = useState(false);
  const [sync, setSync] = useState<SyncStatus>({state: 'unlinked'});
  const [exportReq, setExportReq] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    call('sync:status', {dir}).then(setSync);
    const offSync = on('sync', (e) => { if (e.dir === dir) setSync(e.status); });
    // Studio's Export button posts {source:'dtly', type:'export'} to the shell (features.render = 'browser').
    const studioOrigin = new URL(studioUrl).origin;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== studioOrigin || (e.data as {source?: string})?.source !== 'dtly') return;
      if ((e.data as {type?: string}).type === 'export') { setTab('export'); setExportReq((n) => n + 1); }
    };
    window.addEventListener('message', onMsg);
    return () => { offSync(); window.removeEventListener('message', onMsg); document.body.dataset.studio = ''; };
  }, [dir, studioUrl]);

  const reloadStudio = () => frame.current?.contentWindow?.postMessage({type: 'reload'}, new URL(studioUrl).origin);

  return (
    <div class="project">
      <header class="topbar">
        <button onClick={onClose} title="All projects">← Projects</button>
        <div class="title">{project.name}<span class="muted small"> · {project.width}×{project.height}</span></div>
        <SyncBadge s={sync} onClick={() => setTab('sync')} />
        {!account.access.canEdit && <span class="badge warn">Read only</span>}
        <span class="grow" />
        {account.me && <button class="account-chip" onClick={() => setShowAccount(true)}>{account.me.workspace.name}</button>}
      </header>
      <div class={`workspace ${tab === 'director' ? 'director-open' : ''}`}>
        <MediaBin dir={dir} canEdit={account.access.canEdit} />
        <div class="studio-wrap">
          <iframe ref={frame} class="studio" src={studioUrl} title="Studio" onLoad={() => { document.body.dataset.studio = 'loaded'; }} />
        </div>
        <aside class="side">
          <nav class="tabs">
            <button class={tab === 'export' ? 'on' : ''} onClick={() => setTab('export')}>Export</button>
            <button class={tab === 'sync' ? 'on' : ''} onClick={() => setTab('sync')}>CustomerPro</button>
            <button class={tab === 'director' ? 'on' : ''} onClick={() => setTab('director')}>Director</button>
          </nav>
          {tab === 'export' && <ExportPanel dir={dir} account={account} request={exportReq} />}
          {tab === 'sync' && <SyncPanel dir={dir} account={account} status={sync} onReload={reloadStudio} />}
          {tab === 'director' && <DirectorPanel dir={dir} account={account} />}
        </aside>
      </div>
      {showAccount && <AccountPanel account={account} onClose={() => setShowAccount(false)} />}
    </div>
  );
};

const SyncBadge = ({s, onClick}: {s: SyncStatus; onClick: () => void}) => {
  const label: Record<SyncStatus['state'], string> = {unlinked: 'Local only', synced: 'Synced', pending: 'Saving to CustomerPro…', pushing: 'Syncing…', offline: 'Offline · will sync', conflict: 'Changed on the web', error: 'Sync error', blocked: 'Sync paused'};
  return <button class={`badge sync-${s.state}`} onClick={onClick}>{label[s.state]}</button>;
};

// ---------------------------------------------------------------- media bin
const MediaBin = ({dir, canEdit}: {dir: string; canEdit: boolean}) => {
  const [items, setItems] = useState<SourceState[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisFile | null>(null);
  const [progress, setProgress] = useState<{task: string; done: number; total: number; label?: string} | null>(null);
  const [sel, setSel] = useState<SourceState | null>(null);
  const [msg, setMsg] = useState('');
  const [drag, setDrag] = useState(false);

  const refresh = async () => { setItems(await call('media:list', {dir})); setAnalysis(await call('media:analysis', {dir})); };
  useEffect(() => {
    void refresh();
    const offs = [
      on('media', (e) => { if (e.dir === dir) void refresh(); }),
      on('progress', (p) => { if (p.task === 'import' || p.task === 'analyse') setProgress(p.done >= p.total ? null : p); }),
      on('menu', ({action}) => { if (action === 'import') void importDialog(false); }),
    ];
    return () => offs.forEach((f) => f());
  }, [dir]);

  const report = (r: {added: number; skipped: {path: string; reason: string}[]} | null) => {
    if (!r) return;
    const dupes = r.skipped.filter((s) => s.reason.includes('already')).length;
    const failed = r.skipped.length - dupes;
    setMsg(`Added ${r.added}${dupes ? `, ${dupes} already here` : ''}${failed ? `, ${failed} could not be read` : ''}`);
  };
  const importDialog = async (folders: boolean) => { try { report(await call('media:importDialog', {dir, folders})); } catch (e) { setMsg(errMsg(e)); } };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.cpv.pathForFile(f)).filter(Boolean);
    if (paths.length) { try { report(await call('media:importPaths', {dir, paths})); } catch (x) { setMsg(errMsg(x)); } }
  };
  const analyse = async () => {
    try {
      const r = await call('media:analyse', {dir});
      const bad = r.filter((x) => !x.ok);
      setMsg(`Analysed ${r.length - bad.length} clip${r.length - bad.length === 1 ? '' : 's'}${bad.length ? `; ${bad.length} failed` : ''}`);
    } catch (e) { setMsg(errMsg(e)); }
  };
  const missing = items.filter((i) => i.missing).length;

  return (
    <aside class={`bin ${drag ? 'drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div class="bin-head">
        <b>Media</b><span class="muted small"> {items.length}{missing ? ` · ${missing} missing` : ''}</span>
        <span class="grow" />
        <button title="Add files" onClick={() => importDialog(false)}>+ Files</button>
        <button title="Add a folder (footage stays where it is)" onClick={() => importDialog(true)}>+ Folder</button>
      </div>
      <div class="row small-buttons pad">
        <button disabled={!items.some((i) => i.kind === 'video')} onClick={analyse}>Make contact sheets</button>
      </div>
      {progress && (
        <div class="progress-line">
          <div class="bar"><i style={{width: `${(progress.done / Math.max(1, progress.total)) * 100}%`}} /></div>
          <span class="small muted">{progress.task === 'import' ? 'Importing' : 'Analysing'} {progress.done + 1}/{progress.total} {progress.label}</span>
          <button class="link" onClick={() => void call('media:cancel', {task: progress.task})}>Stop</button>
        </div>
      )}
      {msg && <div class="small muted pad" onClick={() => setMsg('')}>{msg}</div>}
      {items.length === 0 && <div class="empty muted">Drop footage, photos, music or your logo here. Raw video is referenced in place, never copied or uploaded.</div>}
      <div class="bin-list">
        {items.map((i) => (
          <div key={i.id} class={`clip ${i.missing ? 'missing' : ''} ${sel?.id === i.id ? 'sel' : ''}`} onClick={() => setSel(i)} title={i.path}>
            <div class="thumb">{i.thumb ? <img src={mediaUrl(join(dir, i.thumb))} /> : <span>{i.kind}</span>}{analysis?.byHash[i.hash]?.sheet && <span class="dot" title="Contact sheet ready" />}</div>
            <div class="meta">
              <div class="name">{i.name}</div>
              <div class="small muted">
                {i.kind === 'video' && i.probe?.video ? `${i.probe.video.displayWidth}×${i.probe.video.displayHeight} · ${i.probe.video.codec.toUpperCase()}${i.probe.video.bitDepth === 10 ? ' 10-bit' : ''} · ${fmtDur(i.probe.duration)}` : i.copiedTo ? `copied to ${i.copiedTo}` : i.kind}
                {' · '}{fmtBytes(i.size)}
              </div>
              {i.missing && (
                <div class="small"><span class="badge warn">Missing</span> <button class="link" onClick={async (e) => { e.stopPropagation(); try { const r = await call('media:locate', {dir, id: i.id}); if (r) setMsg(`Found ${r.relocated.length} file${r.relocated.length === 1 ? '' : 's'}`); } catch (x) { setMsg(errMsg(x)); } }}>Locate…</button></div>
              )}
            </div>
          </div>
        ))}
      </div>
      {sel && !sel.missing && <ClipPanel dir={dir} clip={sel} analysis={analysis} canEdit={canEdit} onDone={(m) => setMsg(m)} onClose={() => setSel(null)} />}
    </aside>
  );
};

// ---------------------------------------------------------------- "Add to timeline" (segment_prepare)
const ClipPanel = ({dir, clip, analysis, canEdit, onDone, onClose}: {dir: string; clip: SourceState; analysis: AnalysisFile | null; canEdit: boolean; onDone: (m: string) => void; onClose: () => void}) => {
  const dur = clip.probe?.duration ?? 0;
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.min(dur, 3));
  const [cx, setCx] = useState(0.5);
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0);
  const [grade, setGrade] = useState<GradeName>(/^DJI_/i.test(clip.name) ? 'drone' : 'phone');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState('');
  useEffect(() => { setFrom(0); setTo(Math.min(dur, 3)); setErr(''); }, [clip.id]);
  useEffect(() => on('progress', (p) => { if (p.task === 'segment') setPct(p.done); }), []);
  const sheet = analysis?.byHash[clip.hash]?.sheet;
  const num = (v: string) => Math.max(0, Math.min(dur, Number(v) || 0));

  if (clip.kind !== 'video') {
    return <div class="clip-panel"><div class="row"><b class="grow">{clip.name}</b><button class="link" onClick={onClose}>×</button></div><p class="small muted">{clip.copiedTo ? `In the project as ${clip.copiedTo}. Add it in Studio with + Layer.` : clip.kind}</p></div>;
  }
  const add = async () => {
    setBusy(true); setErr(''); setPct(0);
    try {
      const r = await call('footage:addToTimeline', {dir, id: clip.id, from, to, opts: {cx, rotate, grade}});
      onDone(`Added ${r.segment.file} (${r.segment.width}×${r.segment.height}, ${r.segment.encoder}${r.segment.hwDecode ? ', hardware decode' : ''}) in ${r.segment.seconds.toFixed(1)} s`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div class="clip-panel">
      <div class="row"><b class="grow">{clip.name}</b><button class="link" onClick={onClose}>×</button></div>
      {sheet ? <img class="sheet" src={mediaUrl(join(dir, sheet.file))} title={`Frames at ${sheet.times.map((t) => `${t}s`).join(', ')}`} /> : clip.thumb && <img class="sheet" src={mediaUrl(join(dir, clip.thumb))} />}
      <div class="form-grid">
        <label>In (s)<input type="number" step="0.1" min="0" max={dur} value={from} onInput={(e) => setFrom(num((e.target as HTMLInputElement).value))} /></label>
        <label>Out (s)<input type="number" step="0.1" min="0" max={dur} value={to} onInput={(e) => setTo(num((e.target as HTMLInputElement).value))} /></label>
        <label class="wide">Crop position <input type="range" min="0" max="1" step="0.01" value={cx} onInput={(e) => setCx(Number((e.target as HTMLInputElement).value))} /><span class="small muted">{cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'centre'}</span></label>
        <label>Rotate<select value={rotate} onChange={(e) => setRotate(Number((e.target as HTMLSelectElement).value) as 0)}>{[0, 90, 180, 270].map((r) => <option value={r}>{r}°</option>)}</select></label>
        <label>Look<select value={grade} onChange={(e) => setGrade((e.target as HTMLSelectElement).value as GradeName)}><option value="drone">Drone</option><option value="phone">Phone</option><option value="none">None</option></select></label>
      </div>
      <p class="small muted">{fmtDur(Math.max(0, to - from))} shot, cut with 0.7 s handles and cropped to the video's shape. Speed stays editable in Studio.</p>
      {busy && <div class="bar"><i style={{width: `${pct}%`}} /></div>}
      {err && <p class="error-text small">{err}</p>}
      <button class="primary" disabled={!canEdit || busy || to <= from} onClick={add}>{busy ? 'Preparing…' : 'Add to timeline'}</button>
    </div>
  );
};

// ---------------------------------------------------------------- export
const ExportPanel = ({dir, account, request}: {dir: string; account: AccountState; request: number}) => {
  const [job, setJob] = useState<ExportProgress | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => on('export', (e) => setJob((j) => (j && j.id === e.id ? e : j))), []);
  const start = async () => {
    setErr('');
    try { const r = await call('export:preview', {dir}); setJob({id: r.id, phase: 'render', done: 0, total: 0}); } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { if (request > 0 && (!job || job.phase !== 'render')) void start(); }, [request]);
  const running = job?.phase === 'render';
  return (
    <div class="panel">
      <h3>Preview export</h3>
      <p class="small muted">720p with a watermark, saved in the project's renders folder. Works offline; no credits.</p>
      <button class="primary" disabled={running} onClick={start}>Export preview</button>
      {job && (
        <div class="export-job">
          {running && (<><div class="bar"><i style={{width: `${job.total ? (job.done / job.total) * 100 : 0}%`}} /></div><div class="row small"><span class="grow muted">{job.done}/{job.total || '…'} frames</span><button class="link" onClick={() => void call('export:cancel', {id: job.id})}>Cancel</button></div></>)}
          {job.phase === 'finished' && job.out && <p class="small">Done. <button class="link" onClick={() => void call('app:reveal', {path: job.out!})}>Show in folder</button><video class="preview" src={mediaUrl(job.out)} controls /></p>}
          {job.phase === 'cancelled' && <p class="small muted">Cancelled.</p>}
          {job.phase === 'error' && <p class="error-text small">{job.error}</p>}
        </div>
      )}
      {err && <p class="error-text small">{err}</p>}
      <h3>Final export &amp; publish</h3>
      <FinalExport dir={dir} account={account} />
    </div>
  );
};

// ---------------------------------------------------------------- CustomerPro link / sync
const SyncPanel = ({dir, account, status, onReload}: {dir: string; account: AccountState; status: SyncStatus; onReload: () => void}) => {
  const [err, setErr] = useState('');
  const [upload, setUpload] = useState<{path: string; sent: number; size: number; fileIndex: number; files: number} | null>(null);
  const [uploadMsg, setUploadMsg] = useState('');
  useEffect(() => on('upload', (u) => { if (u.dir === dir) setUpload(u); }), [dir]);
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); } catch (e) { setErr(errMsg(e)); } };
  if (!account.access.canSync) return <div class="panel"><p class="muted small">{account.access.reason ?? 'Sync is not available.'}</p></div>;
  return (
    <div class="panel">
      <h3>CustomerPro</h3>
      {status.state === 'unlinked' ? (
        <>
          <p class="small muted">Link this project to open it on the web too. The project file syncs on every save; footage stays here.</p>
          <button class="primary" disabled={!account.access.canEdit} onClick={() => act(() => call('sync:link', {dir}))}>Link to CustomerPro</button>
        </>
      ) : (
        <>
          <p class="small">{status.state === 'synced' ? `Synced · revision ${status.rev}` : status.state === 'offline' || status.state === 'error' || status.state === 'blocked' ? status.message : status.state === 'conflict' ? '' : 'Syncing…'}</p>
          {status.state === 'conflict' && (
            <div class="conflict">
              <b>Changed on the web</b>
              <p class="small">Someone saved this project on CustomerPro (revision {status.remoteRev}) while it also changed here.</p>
              <button class="primary" onClick={() => act(async () => { await call('sync:resolve', {dir, choice: 'theirs'}); onReload(); })}>Load theirs</button>{' '}
              <button onClick={() => act(async () => { const r = await call('sync:resolve', {dir, choice: 'keep-mine'}); onReload(); setUploadMsg(`Your version was saved as a new project: ${r.copy?.split(/[\\/]/).pop()}`); })}>Keep mine as a copy</button>
            </div>
          )}
          <div class="row small-buttons">
            <button onClick={() => act(async () => { await call('sync:pull', {dir}); onReload(); })}>Check for changes</button>
            <button onClick={() => act(() => call('sync:push', {dir}))}>Sync now</button>
            <button onClick={() => act(() => call('sync:unlink', {dir}))}>Unlink</button>
          </div>
          <h3>Edit on the web too</h3>
          <p class="small muted">Uploads prepared clips, voiceover and music (never raw footage) so the web editor can play them.</p>
          <button disabled={!account.access.canEdit} onClick={() => act(async () => {
            const r = await call('sync:uploadMedia', {dir});
            const bad = r.filter((x) => x.error);
            setUpload(null);
            setUploadMsg(r.length === 0 ? 'Everything is already uploaded.' : `Uploaded ${r.length - bad.length} file(s)${bad.length ? `; ${bad.length} failed (${bad[0].error})` : ''}`);
          })}>Upload media</button>
          <button onClick={() => act(async () => {
            const r = await call('media:downloadRemote', {dir});
            onReload();
            setUploadMsg(`Downloaded ${r.downloaded.length} file(s)${r.failed.length ? `; ${r.failed.length} failed` : ''}${r.missing.length ? `; still missing: ${r.missing.slice(0, 3).join(', ')}` : ''}`);
          })}>Download media from the web</button>
          {upload && <div class="small muted">{upload.path} ({upload.fileIndex + 1}/{upload.files}) <div class="bar"><i style={{width: `${(upload.sent / Math.max(1, upload.size)) * 100}%`}} /></div></div>}
        </>
      )}
      {uploadMsg && <p class="small">{uploadMsg}</p>}
      {err && <p class="error-text small">{err}</p>}
    </div>
  );
};
