// Main-process side of the AI director: the shell's director:* IPC channels, forwarding director events to the
// window, and serving the engine's host calls (director sessions, speech, library) with the Sanctum token,
// which never leaves the main process.
import path from 'node:path';
import {DirectorApi} from '../customerpro/director-api.js';
import type {SyncManager} from '../customerpro/sync.js';
import type {Channels, EventName, Events} from '../shared/bridge.js';
import type {HostCall} from '../shared/director.js';
import type {AccountManager} from './account.js';
import type {EngineHost} from './engine-host.js';
import {log} from './logger.js';

type DirectorChannel = Extract<keyof Channels, `director:${string}`>;
type Handlers = {[C in DirectorChannel]: (p: Channels[C]['in']) => Promise<Channels[C]['out']> | Channels[C]['out']};

export interface DirectorIpcDeps {
  engine: () => EngineHost;
  account: () => AccountManager;
  sync: () => SyncManager;
  requireKnown: (dir: string) => string;
  knownDirs: () => string[]; // open project + recents + projects root (for host-call path checks)
  send: <E extends EventName>(event: E, data: Events[E]) => void;
}

const within = (child: string, parent: string) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

export const directorIpc = (d: DirectorIpcDeps) => {
  const api = () => {
    const acc = d.account();
    return new DirectorApi({
      baseUrl: acc.client.baseUrl,
      getToken: () => acc.client.token(),
      // Director sessions are per CustomerPro project: link a local-only project on first use.
      ensureLinked: async (dir) => { await d.sync().link(dir, {orgId: acc.state().me?.workspace.id ?? ''}); },
    });
  };
  const canRun = () => {
    const a = d.account().access();
    if (!a.canEdit) throw new Error(a.reason ?? 'The AI director needs Video edit access in this workspace');
    if (d.account().state().online === false) throw Object.assign(new Error('Offline: the AI director needs a connection. Editing keeps working.'), {code: 'offline'});
  };

  const attach = () => {
    const engine = d.engine();
    engine.onEvent('director', (e) => d.send('director', e));
    engine.onEvent('hostCall', (c: HostCall) => void serveHostCall(c));
  };

  const serveHostCall = async (c: HostCall) => {
    let reply: {id: number; result?: unknown; error?: {message: string; code?: string}};
    try {
      const host = api().asHost();
      const params = c.params as Record<string, unknown>;
      if (c.op === 'transcribe') {
        // The engine may only send audio it extracted into a project folder.
        const f = path.resolve(String(params.file));
        if (!d.knownDirs().some((k) => within(f, k))) throw new Error('Audio file outside the project');
      }
      if (c.op === 'createSession') d.requireKnown(String(params.dir));
      const fn = host[c.op] as (p: unknown) => Promise<unknown>;
      if (typeof fn !== 'function') throw new Error(`Unknown host call ${c.op}`);
      reply = {id: c.id, result: await fn(c.params)};
    } catch (e) {
      const err = e as Error & {code?: string};
      if (err.code !== 'offline') log('warn', `director ${c.op} failed: ${err.message}`);
      reply = {id: c.id, error: {message: err.message, code: err.code}};
    }
    await d.engine().call('hostReply', reply).catch(() => undefined);
  };

  const handlers: Handlers = {
    'director:status': async () => d.engine().call('directorStatus', undefined as never),
    'director:state': ({dir}) => d.engine().call('directorState', {dir: d.requireKnown(dir)}),
    'director:analyse': (p) => { canRun(); return d.engine().call('directorAnalyse', {...p, dir: d.requireKnown(p.dir)}); },
    'director:plan': (p) => { canRun(); return d.engine().call('directorPlan', {...p, dir: d.requireKnown(p.dir)}); },
    'director:approve': (p) => { canRun(); return d.engine().call('directorApprove', {...p, dir: d.requireKnown(p.dir)}); },
    'director:chat': (p) => { canRun(); return d.engine().call('directorChat', {...p, dir: d.requireKnown(p.dir)}); },
    'director:continue': (p) => { canRun(); return d.engine().call('directorContinue', {...p, dir: d.requireKnown(p.dir)}); },
    'director:stop': ({dir}) => d.engine().call('directorStop', {dir: d.requireKnown(dir)}),
    'director:answer': (p) => d.engine().call('directorAnswer', p),
    'director:savePlan': (p) => d.engine().call('directorSavePlan', {...p, dir: d.requireKnown(p.dir)}),
  };
  return {handlers, attach};
};
