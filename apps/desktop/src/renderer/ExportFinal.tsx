// Final export & publish (D12, tasks 5.2/5.3): preset, WhatsApp copy, a confirm dialog that says whether it's
// free (monthly videos / 7-day re-export) or what it costs in credits, then render → upload → Media Library.
import {useEffect, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import type {ExportQuoteResult, PublishedLinks, PublishEvent} from '../shared/publish.js';
import {FINAL_PRESETS, type ExportProgress, type FinalPreset} from '../shared/types.js';
import {call, errMsg, fmtBytes, on} from './api.js';

const fmtEta = (s?: number) => (s === undefined ? 'estimating…' : s < 60 ? `${s} s left` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`);
const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, {day: 'numeric', month: 'short'}) : '');
const STAGE: Record<string, string> = {render: 'Rendering', encode: 'Encoding 8 Mbps H.264', whatsapp: 'Making the WhatsApp copy'};

const costLine = (q: ExportQuoteResult) => {
  const left = Math.max(0, q.allowance.videos_per_month - q.allowance.used);
  if (q.kind === 'reexport') return {free: true, text: `Free: a re-export of this project within 7 days (until ${fmtDate(q.freeReexportUntil)}).`};
  if (q.kind === 'free') return {free: true, text: `Free: uses 1 of your ${q.allowance.videos_per_month} videos this month (${left} left).`};
  return {free: false, text: q.priceCredits !== undefined
    ? `This month's ${q.allowance.videos_per_month} videos are used. This export costs ${q.priceCredits} credits; your balance is ${q.balance}.`
    : `This month's ${q.allowance.videos_per_month} videos are used, so this export is charged in credits (CustomerPro shows the price if your balance is short). Your balance is ${q.balance}.`};
};

export const FinalExport = ({dir, account}: {dir: string; account: AccountState}) => {
  const [q, setQ] = useState<ExportQuoteResult | null>(null);
  const [preset, setPreset] = useState<FinalPreset>('reel');
  const [whatsapp, setWhatsapp] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [short, setShort] = useState<{price: number; balance: number; buyUrl: string} | null>(null);
  const [job, setJob] = useState<ExportProgress | null>(null);
  const [exportId, setExportId] = useState<number | string | null>(null);
  const [pub, setPub] = useState<PublishEvent | null>(null);
  const [published, setPublished] = useState<PublishedLinks | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await call('export:quote', {dir});
      setQ(r);
      setPreset((p) => (r ? (p === 'reel' ? r.defaultPreset : p) : p));
      if (r.last && !exportId) { setExportId(r.last.exportId); if (r.last.published) setPublished(r.last.published); }
    } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { void load(); }, [dir, account.access.canExport]);
  useEffect(() => {
    const offs = [
      on('export', (e) => setJob((j) => (j && j.id === e.id ? e : j))),
      on('publish', (e) => {
        if (e.dir !== dir) return;
        setPub(e);
        if (e.phase === 'done') setPublished({main: e.main, whatsapp: e.whatsapp, whatsappError: e.whatsappError, links: e.links});
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [dir]);

  const start = async () => {
    setConfirm(false); setErr(''); setBusy(true); setPub(null); setPublished(null); setShort(null);
    try {
      const r = await call('export:final', {dir, preset, whatsapp, autoPublish: true});
      if (!r.ok) { setShort({price: r.price, balance: r.balance, buyUrl: r.buyUrl}); return; }
      setExportId(r.exportId);
      setJob({id: r.id, kind: 'final', phase: 'render', done: 0, total: 0, fraction: 0});
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); void load(); }
  };
  const publish = async () => {
    if (exportId === null) return;
    setErr(''); setPub(null);
    try { setPublished(await call('publish:start', {dir, exportId})); } catch (e) { setErr(errMsg(e)); }
  };
  const open = (url: string) => void call('app:openExternal', {url});

  if (!q) return <div class="small muted">{err || 'Loading…'}</div>;
  const running = job?.phase === 'render';
  const uploading = pub?.phase === 'uploading';
  const cost = costLine(q);
  const finished = job?.phase === 'finished' ? job.result : undefined;
  const lastFiles = finished ?? (q.last?.main ? {main: q.last.main, whatsapp: q.last.whatsapp} : undefined);

  return (
    <div class="final-export">
      {!q.canExport ? <p class="small muted">{q.reason}</p> : (
        <>
          <div class="form-grid">
            <label class="wide">Format<select value={preset} disabled={running} onChange={(e) => setPreset((e.target as HTMLSelectElement).value as FinalPreset)}>
              {(Object.keys(FINAL_PRESETS) as (keyof typeof FINAL_PRESETS)[]).map((k) => <option value={k}>{FINAL_PRESETS[k].label}</option>)}
              <option value="project">Project size {q.width}×{q.height}</option>
            </select></label>
            <label class="wide check"><span><input type="checkbox" checked={whatsapp} disabled={running} onChange={(e) => setWhatsapp((e.target as HTMLInputElement).checked)} /> WhatsApp copy under 16 MB (free)</span></label>
          </div>
          <p class="small muted">H.264 about 8 Mbps with AAC audio, no watermark. {cost.free ? 'Free this time.' : 'Charged in credits.'}</p>
          <button class="primary" data-testid="final-export" disabled={running || busy || uploading} onClick={() => { setConfirm(true); setShort(null); }}>Export &amp; publish</button>
        </>
      )}

      {running && job && (
        <div class="export-job">
          <div class="bar"><i style={{width: `${Math.round((job.fraction ?? 0) * 100)}%`}} /></div>
          <div class="row small"><span class="grow muted">{STAGE[job.stage ?? 'render']} · {Math.round((job.fraction ?? 0) * 100)}% · {fmtEta(job.etaSeconds)}</span>
            <button class="link" onClick={() => void call('export:cancel', {id: job.id})}>Cancel</button></div>
        </div>
      )}
      {job?.phase === 'cancelled' && <p class="small muted">Export cancelled. Exporting again within 7 days is free.</p>}
      {job?.phase === 'error' && <p class="error-text small">{job.error}</p>}

      {lastFiles && !running && (
        <div class="small export-files">
          <div>{finished ? 'Exported' : 'Last export'}: {lastFiles.main.width}×{lastFiles.main.height}, {fmtBytes(lastFiles.main.size)} <button class="link" onClick={() => void call('app:reveal', {path: lastFiles.main.file})}>Show</button></div>
          {lastFiles.whatsapp && <div>WhatsApp copy: {lastFiles.whatsapp.width}×{lastFiles.whatsapp.height}, {fmtBytes(lastFiles.whatsapp.size)}</div>}
        </div>
      )}

      {uploading && pub?.phase === 'uploading' && (
        <div class="export-job">
          <div class="bar"><i style={{width: `${(pub.sent / Math.max(1, pub.size)) * 100}%`}} /></div>
          <div class="row small"><span class="grow muted">Uploading {pub.variant === 'whatsapp' ? 'the WhatsApp copy' : 'the video'} · {fmtBytes(pub.sent)} of {fmtBytes(pub.size)}{pub.attempt > 1 ? ` · retry ${pub.attempt - 1}` : ''}</span>
            {exportId !== null && <button class="link" onClick={() => void call('publish:cancel', {exportId})}>Stop</button>}</div>
        </div>
      )}
      {pub?.phase === 'error' && <p class="error-text small">Publishing failed: {pub.error}</p>}
      {!published && !uploading && !running && lastFiles && exportId !== null && q.canExport && (pub?.phase === 'error' || pub?.phase === 'cancelled' || (!finished && !q.last?.published)) && (
        <button onClick={publish}>Publish to Media Library</button>
      )}

      {published && !running && (
        <div class="published">
          <b>In your Media Library</b>
          {published.whatsappError && <p class="small muted">The WhatsApp copy didn't upload: {published.whatsappError}</p>}
          <div class="row small-buttons">
            <button class="primary" onClick={() => open(published.links.post)}>Post</button>
            <button class="primary" onClick={() => open(published.links.whatsapp)}>Send on WhatsApp</button>
            <button onClick={() => open(published.links.mediaLibrary)}>Media Library</button>
          </div>
          <p class="small muted">Opens CustomerPro in your browser; pick this video from the Media Library there.</p>
        </div>
      )}
      {err && <p class="error-text small">{err}</p>}

      {confirm && (
        <div class="modal-bg" onClick={() => setConfirm(false)}>
          <div class="card modal" onClick={(e) => e.stopPropagation()} data-testid="export-confirm">
            <h2>Export the final video?</h2>
            <table class="kv">
              <tr><td>Format</td><td>{preset === 'project' ? `${q.width}×${q.height}` : FINAL_PRESETS[preset].label}, {Math.round(q.duration)} s{whatsapp ? ' + WhatsApp copy' : ''}</td></tr>
              <tr><td>Cost</td><td class={cost.free ? 'ok-text' : 'warn-text'}>{cost.text}</td></tr>
              <tr><td>Credits</td><td>{q.balance}</td></tr>
              <tr><td>This month</td><td>{q.allowance.used} of {q.allowance.videos_per_month} videos{q.allowance.resets_at ? ` · resets ${fmtDate(q.allowance.resets_at)}` : ''}</td></tr>
            </table>
            {!q.linked && <p class="small muted">This also links the project to CustomerPro, so the video can go to your Media Library.</p>}
            <p class="small muted">Re-exporting this project in the next 7 days, and the WhatsApp copy, are free. The video renders on this computer, then uploads.</p>
            <div class="row"><span class="grow" /><button onClick={() => setConfirm(false)}>Cancel</button>
              <button class="primary" disabled={!q.linked && !q.canLink} onClick={start}>{cost.free ? 'Export' : q.priceCredits !== undefined ? `Export for ${q.priceCredits} credits` : 'Export using credits'}</button></div>
          </div>
        </div>
      )}
      {short && (
        <div class="modal-bg" onClick={() => setShort(null)}>
          <div class="card modal" onClick={(e) => e.stopPropagation()}>
            <h2>Not enough credits</h2>
            <p>This export costs <b>{Number.isFinite(short.price) ? short.price : '?'} credits</b> and your workspace has <b>{short.balance}</b>. Nothing was charged.</p>
            <div class="row"><span class="grow" /><button onClick={() => setShort(null)}>Close</button><button class="primary" onClick={() => open(short.buyUrl)}>Add credits</button></div>
          </div>
        </div>
      )}
    </div>
  );
};
