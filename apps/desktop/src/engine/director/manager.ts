// The director in the engine (D7): one run at a time per project. A run opens a CustomerPro director session
// (credits held), drives the agent, enforces the hooks, and closes the session when it ends:
//   analyse → pass-1 analysis (analysis.ts)
//   plan    → build session; read-only tools; the reply carries <plan>…</plan> (plan card)
//   build   → build session after the owner approves (and maybe edits) the plan
//   edit    → edit session per chat message
// The conversation is kept in director/conversation.json so each run continues it under a fresh session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {DirectorEvent, DirectorEventBody, DirectorHost, DirectorLogEntry, DirectorMode, DirectorPhase, DirectorPlan, DirectorState, DoneReason, SessionInfo} from '../../shared/director.js';
import {STEP_CAPS, STYLES} from '../../shared/director.js';
import {dtlyCore} from '../dtly.js';
import {projectFile, readJson, writeJsonAtomic} from '../projects.js';
import {createAgent, type AgentError, type AgentToolDef, type DirectorAgent, type UserContent} from './agent.js';
import {analyseFootage} from './analysis.js';
import {appTools} from './app-tools.js';
import {sharedCacheDir} from './cache.js';
import {DTLY_OFFERED, dtlyTools} from './dtly-tools.js';
import {createGuard, findWritePaths} from './guard.js';
import {ProjectStore} from './project-store.js';
import {buildInstructions, continueInstructions, contextBlocks, editInstructions, parsePlan, planInstructions} from './prompt.js';

const F = {conversation: 'director/conversation.json', plan: 'director/plan.json', log: 'director/log.jsonl', usage: 'director/usage.json', brief: 'director/brief.json'};

// Tools allowed while planning: look, don't touch.
const PLAN_TOOLS = new Set(['project_describe', 'project_validate', 'layer_get', 'preset_list', 'render_frame', 'render_sheet', 'media_list', 'media_sheet', 'media_frames', 'media_transcribe', 'doc_pages', 'analysis_save']);

export interface DirectorDeps {
  host: DirectorHost;
  emit: (e: DirectorEvent) => void;
  projectsRoot?: string;
  cacheDir?: string; // shared analysis cache (default <projectsRoot>/.cache/analysis)
  fetch?: typeof fetch; // model calls and library downloads (tests)
  validate?: (project: unknown) => Promise<string[]> | string[];
  caps?: Partial<Record<DirectorPhase, number>>;
}

interface Run { id: string; phase: DirectorPhase; abort: AbortController; agent?: DirectorAgent; done: Promise<void> }

type PlanFile = {plan: DirectorPlan; approved?: boolean; builtAt?: string};
type UsageFile = {sessions: {sid: string; mode: DirectorMode; spent: number; charged?: number; released?: number; at: string}[]};

const summarize = (name: string, input: any) => {
  const s = JSON.stringify(input ?? {});
  const key = input?.file ?? input?.layer ?? input?.preset ?? input?.text ?? input?.id ?? '';
  return `${name}${key ? ` ${String(key).slice(0, 60)}` : s.length > 2 ? ` ${s.slice(0, 60)}` : ''}`;
};

export class DirectorManager {
  private runs = new Map<string, Run>();
  private confirms = new Map<string, {dir: string; resolve: (ok: boolean) => void}>();
  readonly cacheDir: string;
  constructor(private d: DirectorDeps) { this.cacheDir = d.cacheDir ?? sharedCacheDir(d.projectsRoot); }

  // ------------------------------------------------------------ state
  state(dir: string): DirectorState {
    const p = readJson<PlanFile | undefined>(path.join(dir, F.plan), undefined);
    const usage = readJson<UsageFile>(path.join(dir, F.usage), {sessions: []});
    const r = this.runs.get(path.resolve(dir));
    return {plan: p?.plan, approved: p?.approved, log: this.readLog(dir).slice(-300), running: r && {runId: r.id, phase: r.phase},
      usage: {sessions: usage.sessions.length, spent: usage.sessions.reduce((s, x) => s + (x.charged ?? x.spent ?? 0), 0)},
      hasConversation: fs.existsSync(path.join(dir, F.conversation))};
  }
  savePlan(dir: string, plan: DirectorPlan) { writeJsonAtomic(path.join(dir, F.plan), {plan, approved: false} satisfies PlanFile); }
  isRunning(dir: string) { return this.runs.has(path.resolve(dir)); }
  async waitIdle(dir: string) { await this.runs.get(path.resolve(dir))?.done; }

  private readLog(dir: string): DirectorLogEntry[] {
    try { return fs.readFileSync(path.join(dir, F.log), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }
  private log(dir: string, role: DirectorLogEntry['role'], text: string) {
    fs.mkdirSync(path.join(dir, 'director'), {recursive: true});
    fs.appendFileSync(path.join(dir, F.log), `${JSON.stringify({at: new Date().toISOString(), role, text} satisfies DirectorLogEntry)}\n`);
  }
  private addUsage(dir: string, u: UsageFile['sessions'][number]) {
    const f = readJson<UsageFile>(path.join(dir, F.usage), {sessions: []});
    f.sessions.push(u);
    writeJsonAtomic(path.join(dir, F.usage), f);
  }

  // ------------------------------------------------------------ owner answers (confirm before delete, music rights)
  answer(confirmId: string, ok: boolean) {
    const c = this.confirms.get(confirmId);
    if (!c) return false;
    this.confirms.delete(confirmId);
    c.resolve(ok);
    return true;
  }
  private ask(dir: string, runId: string, signal: AbortSignal, question: string, detail?: string) {
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      this.confirms.set(id, {dir: path.resolve(dir), resolve});
      signal.addEventListener('abort', () => this.answer(id, false), {once: true});
      this.d.emit({dir, runId, type: 'confirm', id, question, detail});
    });
  }

  stop(dir: string) {
    const r = this.runs.get(path.resolve(dir));
    if (!r) return false;
    r.abort.abort();
    r.agent?.abort();
    return true;
  }

  // ------------------------------------------------------------ runs
  private start(dir: string, phase: DirectorPhase, body: (run: Run, emit: (e: DirectorEventBody) => void) => Promise<void>) {
    const key = path.resolve(dir);
    if (this.runs.has(key)) throw new Error('The director is already working on this project. Stop it first.');
    if (!fs.existsSync(projectFile(key))) throw new Error(`Not a project folder: ${dir}`);
    const run: Run = {id: crypto.randomBytes(6).toString('hex'), phase, abort: new AbortController(), done: Promise.resolve()};
    const emit = (e: DirectorEventBody) => this.d.emit({dir: key, runId: run.id, ...e} as DirectorEvent);
    this.runs.set(key, run);
    emit({type: 'phase', phase});
    run.done = body(run, emit)
      .catch((e) => emit({type: 'done', reason: 'error', error: (e as Error).message}))
      .finally(() => { this.runs.delete(key); });
    return {runId: run.id};
  }

  analyse(dir: string, o: {ids?: string[]; force?: boolean} = {}) {
    return this.start(dir, 'analyse', async (run, emit) => {
      const r = await analyseFootage({dir, ids: o.ids, force: o.force, host: this.d.host, cacheDir: this.cacheDir, signal: run.abort.signal, fetch: this.d.fetch, cap: this.d.caps?.analyse,
        onProgress: (done, total, label) => emit({type: 'progress', done, total, label}),
        onCredits: (spent, budget) => emit({type: 'credits', spent, budget}),
        onSession: (s) => this.addUsage(dir, {sid: s.sid, mode: 'analyse', spent: s.spent, charged: s.charged, at: new Date().toISOString()})});
      const ok = r.results.filter((x) => x.ok).length, cached = r.results.filter((x) => x.cached).length;
      this.log(dir, 'system', `Analysed ${ok} of ${r.results.length} file(s)${cached ? ` (${cached} from the cache, no credits)` : ''}${r.reason !== 'finished' ? `; stopped: ${r.reason}` : ''}`);
      emit({type: 'done', reason: r.reason, error: r.error?.message, code: r.error?.code, results: r.results});
    });
  }

  plan(dir: string, o: {brief: string; styleId?: string; style?: string; premium?: boolean}) {
    const style = o.style ?? STYLES.find((s) => s.id === o.styleId)?.style ?? STYLES[0].style;
    writeJsonAtomic(path.join(dir, F.brief), {brief: o.brief, style, styleId: o.styleId});
    fs.rmSync(path.join(dir, F.conversation), {force: true}); // a new brief starts a new conversation
    return this.start(dir, 'plan', async (run, emit) => {
      const ctx = await this.contextText(dir, style, o.brief);
      this.log(dir, 'user', o.brief);
      await this.agentRun(dir, run, emit, {mode: 'build', premium: o.premium, history: [], content: [{type: 'text', text: `${ctx}\n\n${planInstructions}`}]});
    });
  }

  approve(dir: string, o: {plan: DirectorPlan; premium?: boolean}) {
    writeJsonAtomic(path.join(dir, F.plan), {plan: o.plan, approved: true} satisfies PlanFile);
    return this.start(dir, 'build', async (run, emit) => {
      this.log(dir, 'user', 'Approved the plan. Build it.');
      await this.agentRun(dir, run, emit, {mode: 'build', premium: o.premium, content: [{type: 'text', text: await this.withContextIfNew(dir, buildInstructions(o.plan))}]});
    });
  }

  chat(dir: string, o: {text: string; premium?: boolean}) {
    return this.start(dir, 'edit', async (run, emit) => {
      this.log(dir, 'user', o.text);
      await this.agentRun(dir, run, emit, {mode: 'edit', premium: o.premium, content: [{type: 'text', text: await this.withContextIfNew(dir, editInstructions(o.text))}]});
    });
  }

  continue(dir: string, o: {premium?: boolean} = {}) {
    const planned = readJson<PlanFile | undefined>(path.join(dir, F.plan), undefined);
    const phase: DirectorPhase = planned?.approved && !planned.builtAt ? 'build' : 'edit';
    return this.start(dir, phase, async (run, emit) => {
      await this.agentRun(dir, run, emit, {mode: phase === 'build' ? 'build' : 'edit', premium: o.premium, content: [{type: 'text', text: continueInstructions}]});
    });
  }

  // First message of a conversation carries the style, brief, brand, music library, project and media.
  private async withContextIfNew(dir: string, instructions: string) {
    if (fs.existsSync(path.join(dir, F.conversation))) return instructions;
    const b = readJson<{brief?: string; style?: string}>(path.join(dir, F.brief), {});
    return `${await this.contextText(dir, b.style ?? STYLES[0].style, b.brief ?? '(no brief given)')}\n\n${instructions}`;
  }
  private async contextText(dir: string, style: string, brief: string) {
    const guard = createGuard(dir);
    const tools = appTools({dir, guard, host: this.d.host, cacheDir: this.cacheDir, confirm: async () => false});
    const media = (await tools.find((t) => t.name === 'media_list')!.execute({})).content.map((c) => ('text' in c ? c.text : '')).join('');
    const brand = await this.d.host.brand().catch(() => undefined);
    const music = await this.d.host.music().catch(() => []);
    const p = readJson<{comps?: {id: string; width: number; height: number; duration: number; layers: unknown[]}[]; root?: string}>(projectFile(dir), {});
    const root = p.comps?.find((c) => c.id === p.root);
    const project = root ? `${root.width}×${root.height}, ${root.duration} s, ${p.comps!.length} comp(s), ${p.comps!.reduce((s, c) => s + c.layers.length, 0)} layer(s)` : 'empty';
    return contextBlocks({style, brief, brand, music, media, project});
  }

  private async agentRun(dir: string, run: Run, emit: (e: DirectorEventBody) => void, o: {mode: DirectorMode; premium?: boolean; content: UserContent[]; history?: unknown[]}) {
    const signal = run.abort.signal;
    let session: SessionInfo | undefined;
    let reason: DoneReason = 'finished';
    let error: AgentError | undefined;
    let spent = 0, budget = 0, lastPoll = 0;
    const pollCredits = async (force = false) => {
      if (!session || (!force && Date.now() - lastPoll < 1500)) return;
      lastPoll = Date.now();
      const st = await this.d.host.sessionStatus({sid: session.session_id}).catch(() => undefined);
      if (st) { spent = st.spent_credits; budget = st.budget_credits; emit({type: 'credits', spent, budget}); }
    };
    try {
      try {
        session = await this.d.host.createSession({dir, mode: o.mode, premium: o.premium});
      } catch (e) {
        const code = (e as {code?: string}).code;
        reason = code === 'insufficient_credits' ? 'budget' : code === 'offline' ? 'offline' : 'error';
        error = {code: (code as AgentError['code']) ?? 'error', message: (e as Error).message};
        return;
      }
      budget = session.budget_credits;
      emit({type: 'credits', spent: 0, budget});
      if (signal.aborted) { reason = 'stopped'; return; }

      const guard = createGuard(dir);
      const store = new ProjectStore(dir, {
        confirm: (q, detail) => this.ask(dir, run.id, signal, q, detail),
        validate: this.d.validate ?? (async (p) => (await dtlyCore()).validate(p as never)),
        onConflict: () => { this.log(dir, 'system', 'You changed the project while the director worked: your version was kept and the director re-read it.'); emit({type: 'message', role: 'system', text: 'Your edit in Studio was kept; the director is re-reading the project.'}); },
      });
      const tools: AgentToolDef[] = [
        ...(await dtlyTools({dir, guard, store})),
        ...appTools({dir, guard, host: this.d.host, cacheDir: this.cacheDir, confirm: (q, detail) => this.ask(dir, run.id, signal, q, detail), fetch: this.d.fetch}),
      ];
      const cap = this.d.caps?.[run.phase] ?? STEP_CAPS[run.phase];
      let steps = 0;
      let capHit = false;
      const history = o.history ?? readJson<unknown[]>(path.join(dir, F.conversation), []);
      const agent = createAgent({
        proxyUrl: session.proxy_url, token: session.token, model: session.models[0], tools, history, fetch: this.d.fetch,
        hooks: {
          beforeTool: (call) => {
            if (signal.aborted) return {block: true, reason: 'Stopped by the owner.', stop: true};
            if (++steps > cap) { capHit = true; return {block: true, reason: `Step limit reached (${cap} tool calls for this ${run.phase}). Stop here and summarise what is done and what is left; the owner can continue.`, stop: true}; }
            if (run.phase === 'plan' && !PLAN_TOOLS.has(call.name)) return {block: true, reason: 'Planning: do not change the project or make media until the owner approves the plan. Finish the plan first.'};
            for (const p of findWritePaths(call.input)) if (!guard.allowWrite(path.resolve(dir, p))) return {block: true, reason: `Writing ${p} is not allowed: the director can only write inside this project's folder.`};
            if (!DTLY_OFFERED.includes(call.name) && !tools.some((t) => t.name === call.name)) return {block: true, reason: `No tool ${call.name}.`};
            return undefined;
          },
          shouldStop: () => capHit || signal.aborted,
        },
        onEvent: (e) => {
          if (e.type === 'text') emit({type: 'text', delta: e.delta});
          else if (e.type === 'assistant') {
            const shown = e.text.replace(/<plan>[\s\S]*?<\/plan>/g, '(plan below)').trim();
            if (shown) { this.log(dir, 'assistant', shown); emit({type: 'message', role: 'assistant', text: shown}); }
          } else if (e.type === 'tool_start') emit({type: 'tool', id: e.id, name: e.name, state: 'start', summary: summarize(e.name, e.input)});
          else if (e.type === 'tool_end') {
            this.log(dir, 'tool', `${e.name}${e.isError ? ` ✗ ${e.text.slice(0, 160)}` : ''}`);
            emit({type: 'tool', id: e.id, name: e.name, state: e.isError ? 'error' : 'end', summary: e.text.slice(0, 200)});
          } else if (e.type === 'turn_end') void pollCredits();
        },
      });
      run.agent = agent;
      if (signal.aborted) { reason = 'stopped'; return; }
      const r = await agent.run(o.content);
      writeJsonAtomic(path.join(dir, F.conversation), agent.messages());
      if (r.stop === 'aborted' || signal.aborted) reason = 'stopped';
      else if (r.stop === 'error') {
        error = r.error;
        reason = r.error?.code === 'budget_exhausted' ? 'budget' : r.error?.code === 'offline' ? 'offline' : 'error';
      } else if (capHit) reason = 'step_cap';
      if (reason === 'finished' && run.phase === 'plan') {
        const plan = parsePlan(r.text);
        if (plan) { this.savePlan(dir, plan); emit({type: 'plan', plan}); }
      }
      if (reason === 'finished' && run.phase === 'build') {
        const pf = readJson<PlanFile | undefined>(path.join(dir, F.plan), undefined);
        if (pf) writeJsonAtomic(path.join(dir, F.plan), {...pf, builtAt: new Date().toISOString()});
      }
    } finally {
      if (session) {
        await pollCredits(true);
        try {
          const c = await this.d.host.closeSession({sid: session.session_id});
          this.addUsage(dir, {sid: session.session_id, mode: o.mode, spent, charged: c.charged_credits, released: c.released_credits, at: new Date().toISOString()});
          emit({type: 'credits', spent: c.charged_credits ?? spent, budget});
        } catch {
          this.addUsage(dir, {sid: session.session_id, mode: o.mode, spent, at: new Date().toISOString()});
        }
      }
      for (const [id, c] of this.confirms) if (c.dir === path.resolve(dir)) this.answer(id, false);
      if (reason !== 'finished') this.log(dir, 'system', `Stopped: ${reason}${error ? ` (${error.message})` : ''}`);
      emit({type: 'done', reason, error: error?.message, code: error?.code});
    }
  }
}
