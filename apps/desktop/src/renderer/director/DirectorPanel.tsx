// Director panel (task 4.5): brief + style → plan card (edit, approve) → build progress (tool steps streamed,
// changes appear live in Studio) → chat edits. Footage analysis, stop, credits, and the error states
// (credits ran out, not enough credits, offline).
import {useEffect, useRef, useState} from 'preact/hooks';
import type {AccountState} from '../../main/account.js';
import type {DirectorEvent, DirectorPhase, DirectorPlan, DirectorState} from '../../shared/director.js';
import {STYLES} from '../../shared/director.js';
import type {SourceState} from '../../shared/types.js';
import {call, errMsg, on} from '../api.js';
import {PlanCard} from './PlanCard.js';
import './director.css';

type Item = {kind: 'msg'; role: 'assistant' | 'user' | 'system'; text: string} | {kind: 'tool'; id: string; name: string; state: string; summary: string};
type Done = Extract<DirectorEvent, {type: 'done'}>;

const PHASE_LABEL: Record<DirectorPhase, string> = {analyse: 'Analysing footage', plan: 'Planning', build: 'Building in Studio', edit: 'Editing'};

export const DirectorPanel = ({dir, account}: {dir: string; account: AccountState}) => {
  const [state, setState] = useState<DirectorState | null>(null);
  const [media, setMedia] = useState<SourceState[]>([]);
  const [brief, setBrief] = useState('');
  const [styleId, setStyleId] = useState(STYLES[0].id);
  const [premium, setPremium] = useState(false);
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [planDirty, setPlanDirty] = useState(false);
  const [running, setRunning] = useState<{runId: string; phase: DirectorPhase} | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [stream, setStream] = useState('');
  const [credits, setCredits] = useState<{spent: number; budget: number} | null>(null);
  const [progress, setProgress] = useState<{done: number; total: number; label?: string} | null>(null);
  const [confirm, setConfirm] = useState<{id: string; question: string; detail?: string} | null>(null);
  const [last, setLast] = useState<Done | null>(null);
  const [chat, setChat] = useState('');
  const [err, setErr] = useState('');
  const feed = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const s = await call('director:state', {dir});
    setState(s);
    setRunning(s.running ?? null);
    if (s.plan && !planDirty) setPlan(s.plan);
    if (!items.length) setItems(s.log.slice(-60).map((l) => (l.role === 'tool' ? {kind: 'tool', id: l.at, name: l.text.split(' ')[0], state: /✗/.test(l.text) ? 'error' : 'end', summary: l.text} : {kind: 'msg', role: l.role, text: l.text})));
  };
  useEffect(() => {
    void refresh();
    call('media:list', {dir}).then(setMedia).catch(() => undefined);
    const offs = [
      on('media', (e) => { if (e.dir === dir) call('media:list', {dir}).then(setMedia).catch(() => undefined); }),
      on('director', (e) => {
        if (e.dir !== dir) return;
        if (e.type === 'phase') { setRunning({runId: e.runId, phase: e.phase}); setLast(null); setStream(''); }
        else if (e.type === 'text') setStream((s) => s + e.delta);
        else if (e.type === 'message') { setStream(''); setItems((x) => [...x, {kind: 'msg', role: e.role, text: e.text}]); }
        else if (e.type === 'tool') {
          setItems((x) => {
            const i = x.findIndex((it) => it.kind === 'tool' && it.id === e.id);
            const it: Item = {kind: 'tool', id: e.id, name: e.name, state: e.state, summary: e.state === 'start' ? e.summary : `${e.name}${e.state === 'error' ? `: ${e.summary}` : ''}`};
            return i < 0 ? [...x, it] : x.map((y, k) => (k === i ? it : y));
          });
        } else if (e.type === 'plan') { setPlan(e.plan); setPlanDirty(false); }
        else if (e.type === 'credits') setCredits({spent: e.spent, budget: e.budget});
        else if (e.type === 'progress') setProgress(e.done >= e.total ? null : e);
        else if (e.type === 'confirm') setConfirm({id: e.id, question: e.question, detail: e.detail});
        else if (e.type === 'done') {
          setRunning(null); setProgress(null); setConfirm(null); setStream(''); setLast(e);
          if (e.type === 'done' && e.results) {
            const bad = e.results.filter((r) => !r.ok), cached = e.results.filter((r) => r.cached).length;
            setItems((x) => [...x, {kind: 'msg', role: 'system', text: `Analysed ${e.results!.length - bad.length} of ${e.results!.length} file(s)${cached ? `, ${cached} from earlier projects (free)` : ''}${bad.length ? `. Skipped: ${bad.slice(0, 4).map((b) => `${media.find((m) => m.id === b.id)?.name ?? b.id} (${b.error})`).join('; ')}` : ''}`}]);
          }
          void refresh();
        }
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [dir]);
  useEffect(() => { feed.current?.scrollTo({top: feed.current.scrollHeight}); }, [items.length, stream]);

  const act = async (fn: () => Promise<unknown>) => { setErr(''); setLast(null); try { await fn(); } catch (e) { setErr(errMsg(e)); } };
  const busy = !!running;
  const canEdit = account.access.canEdit;
  const offline = account.online === false;
  const videos = media.filter((m) => m.kind === 'video').length;
  const approve = () => act(async () => { if (!plan) return; setPlanDirty(false); await call('director:approve', {dir, plan, premium}); });
  const savePlan = () => act(async () => { if (plan) { await call('director:savePlan', {dir, plan}); setPlanDirty(false); } });
  const sendChat = () => act(async () => { const t = chat.trim(); if (!t) return; setItems((x) => [...x, {kind: 'msg', role: 'user', text: t}]); setChat(''); await call('director:chat', {dir, text: t, premium}); });
  const buyUrl = `${account.baseUrl}/settings/billing`;

  if (!canEdit) return <div class="panel"><h3>AI Director</h3><p class="small muted">{account.access.reason ?? 'The AI director needs Video edit access in this workspace.'}</p></div>;

  return (
    <div class="panel director">
      <div class="row dir-head">
        <h3 class="grow">AI Director</h3>
        <span class="small muted credits" title="Credits used by the running step / held for it">
          {credits && busy ? `${credits.spent} / ${credits.budget} credits` : state?.usage.spent ? `${state.usage.spent} credits used` : ''}
        </span>
      </div>
      {offline && <div class="notice warn small">You're offline. The director needs a connection; editing in Studio keeps working.</div>}

      <section>
        <div class="row">
          <button disabled={busy || offline || !media.length} onClick={() => act(() => call('director:analyse', {dir}))}>Analyse footage</button>
          <span class="small muted grow">{media.length ? `${media.length} file(s)${videos ? `, ${videos} clips` : ''}` : 'Add footage first'}</span>
        </div>
        {running?.phase === 'analyse' && progress && (
          <div class="small muted"><div class="bar"><i style={{width: `${(progress.done / Math.max(1, progress.total)) * 100}%`}} /></div>{progress.done + 1}/{progress.total} {progress.label}</div>
        )}
      </section>

      {!plan && (
        <section>
          <label class="small muted">Style
            <select value={styleId} disabled={busy} onChange={(e) => setStyleId((e.target as HTMLSelectElement).value)}>
              {STYLES.map((s) => <option value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <p class="small muted">{STYLES.find((s) => s.id === styleId)?.description}</p>
          <textarea rows={5} value={brief} disabled={busy} placeholder="Brief: what is the video about, who is it for, what must it say? e.g. 60-second reel for KK Park, Hinglish voiceover, techno, show 1,80,000 sq ft, end with both phone numbers." onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)} />
          <div class="row">
            <label class="small row premium"><input type="checkbox" checked={premium} onChange={(e) => setPremium((e.target as HTMLInputElement).checked)} /> Premium model</label>
            <span class="grow" />
            <button class="primary" disabled={busy || offline || brief.trim().length < 10} onClick={() => act(() => call('director:plan', {dir, brief: brief.trim(), styleId, premium}))}>Plan my video</button>
          </div>
        </section>
      )}

      {plan && (
        <section>
          <PlanCard plan={plan} media={media} disabled={busy || (state?.approved && !planDirty && !!state?.plan)} onChange={(p) => { setPlan(p); setPlanDirty(true); }} />
          <div class="row plan-actions">
            {state?.approved && !planDirty ? <span class="small muted grow">Approved{running?.phase === 'build' ? ' · building…' : ''}</span> : (
              <>
                <button class="primary" disabled={busy || offline || !plan.beats.length} onClick={approve}>Approve &amp; build</button>
                {planDirty && <button disabled={busy} onClick={savePlan}>Save edits</button>}
                <span class="grow" />
              </>
            )}
            <button class="link small" disabled={busy} onClick={() => { setPlan(null); setPlanDirty(false); }}>New brief</button>
          </div>
        </section>
      )}

      {running && running.phase !== 'analyse' && (
        <div class="row running small"><span class="spinner" /> <span class="grow">{PHASE_LABEL[running.phase]}… changes appear live in Studio.</span></div>
      )}
      {running && <button class="stop" onClick={() => void call('director:stop', {dir})}>Stop</button>}

      <DoneNotice done={last} buyUrl={buyUrl} busy={busy} onContinue={(p) => act(() => call('director:continue', {dir, premium: p}))} />
      {err && <p class="error-text small">{err}</p>}

      <div class="feed" ref={feed}>
        {items.map((it, i) => it.kind === 'msg'
          ? <div key={i} class={`msg ${it.role}`}>{it.text}</div>
          : <div key={i} class={`step ${it.state}`} title={it.summary}>{it.state === 'start' ? '…' : it.state === 'error' ? '✗' : '✓'} {it.summary}</div>)}
        {stream && <div class="msg assistant streaming">{stream.replace(/<plan>[\s\S]*$/, '…')}</div>}
      </div>

      <div class="chat row">
        <textarea rows={2} value={chat} disabled={busy || offline} placeholder={state?.hasConversation ? 'Ask for a change: "make the title bigger", "swap shot 3"…' : 'Ask the director for a change…'}
          onInput={(e) => setChat((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat(); } }} />
        <button disabled={busy || offline || !chat.trim()} onClick={sendChat}>Send</button>
      </div>

      {confirm && (
        <div class="modal-bg">
          <div class="card modal">
            <h2>{confirm.question}</h2>
            {confirm.detail && <pre class="small muted confirm-detail">{confirm.detail}</pre>}
            <div class="row">
              <span class="grow" />
              <button onClick={() => { void call('director:answer', {id: confirm.id, ok: false}); setConfirm(null); }}>No, keep it</button>
              <button class="primary" onClick={() => { void call('director:answer', {id: confirm.id, ok: true}); setConfirm(null); }}>Allow</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const DoneNotice = ({done, buyUrl, busy, onContinue}: {done: Done | null; buyUrl: string; busy: boolean; onContinue: (premium?: boolean) => void}) => {
  if (!done || done.reason === 'finished') return null;
  if (done.reason === 'budget' && done.code === 'insufficient_credits') {
    return <div class="notice warn small"><b>Not enough credits</b> to start the director. <button class="link" onClick={() => void call('app:openExternal', {url: buyUrl})}>Add credits on CustomerPro</button>, then try again.</div>;
  }
  if (done.reason === 'budget') {
    return (
      <div class="notice warn small">
        <b>This step's credits ran out.</b> The project is saved as it is. Continue with more credits?
        <div class="row"><button class="primary" disabled={busy} onClick={() => onContinue(false)}>Continue</button><button disabled={busy} onClick={() => onContinue(true)}>Continue with Premium</button><button class="link" onClick={() => void call('app:openExternal', {url: buyUrl})}>Add credits</button></div>
      </div>
    );
  }
  if (done.reason === 'step_cap') return <div class="notice small">The director reached its step limit for this run and stopped at a safe point. <button class="link" disabled={busy} onClick={() => onContinue(false)}>Continue</button></div>;
  if (done.reason === 'offline') return <div class="notice warn small">Lost the connection to CustomerPro. Your project is saved. <button class="link" disabled={busy} onClick={() => onContinue(false)}>Try again</button></div>;
  if (done.reason === 'stopped') return <div class="notice small muted">Stopped. The project keeps every change made so far.</div>;
  return <div class="notice error small">{done.code === 'not_linked' ? 'Link this project to CustomerPro to use the director.' : done.error ?? 'The director hit an error.'}</div>;
};
