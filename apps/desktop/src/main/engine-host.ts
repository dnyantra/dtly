// Starts the engine (D1) in an Electron utilityProcess — or, with CPV_ENGINE=child, a Node child process
// (Electron binary in ELECTRON_RUN_AS_NODE mode), the documented fallback — and gives typed calls to it.
// A crash restarts only the engine; calls in flight fail with a clear error.
import {fork, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {utilityProcess, type UtilityProcess} from 'electron';
import type {EngineEvent, EngineEventMsg, EngineEvents, EngineMethod, EngineReply, Params, Result} from '../shared/engine-api.js';
import {log} from './logger.js';

export class EngineHost extends EventEmitter {
  private proc?: UtilityProcess | ChildProcess;
  private seq = 0;
  private pending = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void; method: string}>();
  private stopping = false;
  private restarts: number[] = [];
  readonly mode: 'utility' | 'child';

  constructor(private script: string, private env: Record<string, string>) {
    super();
    this.mode = process.env.CPV_ENGINE === 'child' ? 'child' : 'utility';
  }

  start() {
    this.stopping = false;
    const env = {...process.env, ...this.env} as Record<string, string>;
    if (this.mode === 'utility') {
      const p = utilityProcess.fork(this.script, [], {serviceName: 'CustomerPro Video Engine', env, stdio: 'pipe'});
      p.on('message', (m) => this.onMessage(m));
      p.on('exit', (code) => this.onExit(code));
      p.stdout?.on('data', (d) => log('info', `[engine] ${String(d).trimEnd()}`));
      p.stderr?.on('data', (d) => log('warn', `[engine] ${String(d).trimEnd()}`));
      this.proc = p;
    } else {
      const p = fork(this.script, [], {env: {...env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
      p.on('message', (m) => this.onMessage(m));
      p.on('exit', (code) => this.onExit(code ?? -1));
      p.stdout?.on('data', (d) => log('info', `[engine] ${String(d).trimEnd()}`));
      p.stderr?.on('data', (d) => log('warn', `[engine] ${String(d).trimEnd()}`));
      this.proc = p;
    }
    log('info', `engine started (${this.mode})`);
  }

  private onMessage(m: unknown) {
    const msg = m as EngineReply | EngineEventMsg;
    if ('event' in msg) {
      if (msg.event === 'log') { const d = msg.data as EngineEvents['log']; log(d.level, `[engine] ${d.message}`); }
      this.emit(msg.event, msg.data);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), {code: msg.error.code}));
    else p.resolve(msg.result);
  }

  private onExit(code: number) {
    this.proc = undefined;
    for (const [, p] of this.pending) p.reject(new Error(`The engine stopped (exit ${code}) during ${p.method}`));
    this.pending.clear();
    if (this.stopping) return;
    log('error', `engine exited with ${code}; restarting`);
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    this.restarts.push(now);
    this.emit('crashed', {code});
    if (this.restarts.length <= 5) setTimeout(() => this.start(), 300);
    else log('error', 'engine keeps crashing; not restarting');
  }

  call<M extends EngineMethod>(method: M, params: Params<M>, timeoutMs = 0): Promise<Awaited<Result<M>>> {
    if (!this.proc) return Promise.reject(new Error('The engine is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve: resolve as (v: unknown) => void, reject, method});
      if (timeoutMs) setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
      const msg = {id, method, params};
      if ('postMessage' in this.proc!) (this.proc as UtilityProcess).postMessage(msg);
      else (this.proc as ChildProcess).send(msg);
    });
  }

  onEvent<E extends EngineEvent>(event: E, fn: (d: EngineEvents[E]) => void) { this.on(event, fn); return this; }

  stop() {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    try {
      if ('postMessage' in p) (p as UtilityProcess).postMessage({type: 'shutdown'});
      else (p as ChildProcess).send({type: 'shutdown'});
    } catch { /* gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
  }
}
