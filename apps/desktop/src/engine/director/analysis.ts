// Pass-1 analysis with the analyse session (Haiku through the Worker), task 4.2:
// per file a contact sheet (video), a downscaled photo, PDF pages, and a transcript when there is speech →
// one model call → caption / motion / quality / best moments. Cached by content hash in the shared cache, so
// later projects reuse it for free. Per-file failures are reported and skipped; budget/offline stop the pass.
import fs from 'node:fs';
import path from 'node:path';
import type {ClipAnalysis, DirectorHost, DoneReason, SessionInfo} from '../../shared/director.js';
import {STEP_CAPS} from '../../shared/director.js';
import type {SourceEntry} from '../../shared/types.js';
import {contactSheet, extractAudio} from '../footage.js';
import {readSources} from '../sources.js';
import {createAgent, type AgentError, type UserContent} from './agent.js';
import {readShared, setProjectAi, writeShared} from './cache.js';
import {downscaleImage, hasSpeechLikeAudio} from './media.js';
import {pdfPageCount, renderPdfPages} from './pdf.js';
import {analyseInstructions, parseJsonObject} from './prompt.js';

export interface AnalyseOptions {
  dir: string;
  ids?: string[];
  force?: boolean;
  host: DirectorHost;
  cacheDir: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  onProgress?: (done: number, total: number, label: string) => void;
  onCredits?: (spent: number, budget: number) => void;
  onSession?: (s: {sid: string; spent: number; charged?: number}) => void;
  cap?: number; // model calls per session (default STEP_CAPS.analyse)
}
export interface AnalyseResult { results: {id: string; ok: boolean; cached?: boolean; error?: string}[]; reason: DoneReason; error?: AgentError }

const ANALYSABLE = new Set(['video', 'image', 'pdf', 'audio']);
const b64 = (file: string) => fs.readFileSync(file).toString('base64');

export const analyseFootage = async (o: AnalyseOptions): Promise<AnalyseResult> => {
  const all = readSources(o.dir).sources;
  const list = (o.ids ? all.filter((e) => o.ids!.includes(e.id)) : all).filter((e) => ANALYSABLE.has(e.kind));
  const results: AnalyseResult['results'] = [];
  const cap = o.cap ?? STEP_CAPS.analyse;
  let session: SessionInfo | undefined;
  let calls = 0;
  let stopped: {reason: DoneReason; error?: AgentError} | undefined;

  const closeSession = async () => {
    if (!session) return;
    const s = session;
    session = undefined;
    try {
      const st = await o.host.sessionStatus({sid: s.session_id}).catch(() => undefined);
      const c = await o.host.closeSession({sid: s.session_id});
      o.onSession?.({sid: s.session_id, spent: st?.spent_credits ?? c.charged_credits, charged: c.charged_credits});
    } catch { /* the hold auto-settles on the server after 24 h */ }
  };
  const ensureSession = async () => {
    if (session && calls < cap) return session;
    await closeSession();
    calls = 0;
    session = await o.host.createSession({dir: o.dir, mode: 'analyse'});
    o.onCredits?.(0, session.budget_credits);
    return session;
  };

  try {
    for (const [i, e] of list.entries()) {
      if (o.signal.aborted) { stopped = {reason: 'stopped'}; break; }
      o.onProgress?.(i, list.length, e.name);
      if (!o.force) {
        const hit = readShared(o.cacheDir, e.hash);
        if (hit) { setProjectAi(o.dir, e.hash, hit); results.push({id: e.id, ok: true, cached: true}); continue; }
      }
      try {
        const r = await analyseOne(o, e, ensureSession, () => { calls++; });
        if ('stop' in r) { stopped = r.stop; results.push({id: e.id, ok: false, error: r.stop.error?.message ?? r.stop.reason}); break; }
        writeShared(o.cacheDir, e.hash, r.analysis);
        setProjectAi(o.dir, e.hash, r.analysis);
        results.push({id: e.id, ok: true});
        if (session) {
          const st = await o.host.sessionStatus({sid: session.session_id}).catch(() => undefined);
          if (st) o.onCredits?.(st.spent_credits, st.budget_credits);
        }
      } catch (err) {
        const code = (err as {code?: string}).code;
        if (code === 'insufficient_credits' || code === 'offline') { stopped = {reason: code === 'offline' ? 'offline' : 'budget', error: {code, message: (err as Error).message}}; results.push({id: e.id, ok: false, error: (err as Error).message}); break; }
        results.push({id: e.id, ok: false, error: (err as Error).message.split('\n')[0]});
      }
    }
  } finally {
    await closeSession();
  }
  const seen = new Set(results.map((r) => r.id));
  for (const e of list) if (!seen.has(e.id)) results.push({id: e.id, ok: false, error: stopped ? `not analysed (${stopped.reason})` : 'skipped'});
  o.onProgress?.(list.length, list.length, '');
  return {results, reason: stopped?.reason ?? 'finished', error: stopped?.error};
};

type One = {analysis: ClipAnalysis} | {stop: {reason: DoneReason; error?: AgentError}};

const analyseOne = async (o: AnalyseOptions, e: SourceEntry, ensureSession: () => Promise<SessionInfo>, counted: () => void): Promise<One> => {
  const file = e.copiedTo ? path.join(o.dir, e.copiedTo) : e.path;
  if (!fs.existsSync(file)) throw new Error(`${e.name} is missing on disk`);
  const content: UserContent[] = [];
  let speech: string | undefined;
  const tmp: string[] = [];
  try {
    if (e.kind === 'video') {
      const sheet = await contactSheet(o.dir, e.id, {signal: o.signal});
      content.push({type: 'image', mimeType: 'image/png', data: b64(path.join(o.dir, sheet.file))});
      content.push({type: 'text', text: `Contact sheet: frames at ${sheet.times.join(', ')} s (3×2, left to right, top to bottom).`});
    } else if (e.kind === 'image') {
      const img = await downscaleImage(o.dir, file, 1024, o.signal);
      tmp.push(img);
      content.push({type: 'image', mimeType: 'image/png', data: b64(img)});
    } else if (e.kind === 'pdf') {
      const n = Math.min(4, await pdfPageCount(file));
      const {pages, total} = await renderPdfPages(file, [...Array(n).keys()].map((k) => k + 1), 1024);
      for (const p of pages) content.push({type: 'image', mimeType: 'image/png', data: p.png.toString('base64')});
      content.push({type: 'text', text: `PDF: pages 1–${pages.length} of ${total}.`});
    }
    const hasAudio = e.kind === 'audio' || !!e.probe?.audio;
    if ((e.kind === 'video' || e.kind === 'audio') && hasAudio) {
      if (await hasSpeechLikeAudio(file, o.signal).catch(() => false)) {
        const a = await extractAudio(o.dir, e.id, {signal: o.signal});
        if ('file' in a) {
          try {
            const t = await o.host.transcribe({file: path.join(o.dir, a.file)});
            speech = t.segments?.length ? t.segments.map((s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`).join('\n') : t.text;
          } catch (err) {
            const code = (err as {code?: string}).code;
            if (code === 'offline' || code === 'insufficient_credits') throw err;
            speech = undefined; // transcript is optional for pass 1
          }
        }
      }
    }
    if (e.kind === 'audio' && !speech) return {analysis: {caption: 'Audio without speech (music or ambience)', tags: ['audio'], at: new Date().toISOString()}};

    const meta = [`id=${e.id}`, `name=${e.name}`, `kind=${e.kind}`, e.probe?.duration ? `duration=${e.probe.duration.toFixed(2)}s` : '', e.probe?.video ? `size=${e.probe.video.displayWidth}x${e.probe.video.displayHeight}` : ''].filter(Boolean).join(' ');
    const session = await ensureSession();
    counted();
    const agent = createAgent({proxyUrl: session.proxy_url, token: session.token, model: session.models[0], tools: [], maxTokens: 1024, fetch: o.fetch});
    const onAbort = () => agent.abort();
    o.signal.addEventListener('abort', onAbort, {once: true});
    let r;
    try {
      r = await agent.run([{type: 'text', text: analyseInstructions(meta)}, ...content, ...(speech ? [{type: 'text' as const, text: `<transcript>\n${speech}\n</transcript>`}] : [])]);
    } finally { o.signal.removeEventListener('abort', onAbort); }
    if (r.stop === 'aborted') return {stop: {reason: 'stopped'}};
    if (r.stop === 'error') {
      const code = r.error!.code;
      if (code === 'budget_exhausted') return {stop: {reason: 'budget', error: r.error}};
      if (code === 'offline') return {stop: {reason: 'offline', error: r.error}};
      if (code === 'invalid_token' || code === 'model_not_allowed' || code === 'prompt_unavailable') return {stop: {reason: 'error', error: r.error}};
      throw new Error(r.error!.message);
    }
    const j = parseJsonObject(r.text);
    const analysis: ClipAnalysis = {
      caption: String(j.caption ?? '').slice(0, 400),
      ...(j.motion ? {motion: String(j.motion)} : {}),
      ...(j.quality ? {quality: String(j.quality)} : {}),
      best: (Array.isArray(j.best) ? j.best : []).filter((b: any) => Number.isFinite(Number(b?.t))).map((b: any) => ({t: Number(b.t), ...(b.why ? {why: String(b.why)} : {})})).slice(0, 8),
      ...(Array.isArray(j.tags) ? {tags: j.tags.map(String).slice(0, 12)} : {}),
      ...(speech ? {speech} : {}),
      model: session.models[0],
      at: new Date().toISOString(),
    };
    if (!analysis.caption) throw new Error('The model returned no caption');
    return {analysis};
  } finally {
    for (const f of tmp) fs.rmSync(f, {force: true});
  }
};
