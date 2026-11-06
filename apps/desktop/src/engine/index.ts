// Engine entry (D1): runs in an Electron utilityProcess (process.parentPort), or as a plain Node child
// process (process.send) — the documented fallback. Rendering and footage work never block the UI.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {EngineEventMsg, EngineReply, EngineRequest} from '../shared/engine-api.js';
import {createEngine} from './api.js';
import {configureFfmpeg} from './ffmpeg.js';

type Port = {postMessage: (m: unknown) => void; on: (ev: 'message', fn: (e: {data: unknown}) => void) => void};
const parentPort = (process as unknown as {parentPort?: Port}).parentPort;
const post = (m: EngineReply | EngineEventMsg) => {
  if (parentPort) parentPort.postMessage(m);
  else process.send?.(m);
};

configureFfmpeg(process.env.CPV_RESOURCES);
const here = path.dirname(fileURLToPath(import.meta.url));
const logLines: string[] = [];
const engine = createEngine({
  childScript: process.env.CPV_RENDER_CHILD ?? path.join(here, 'render-child.js'),
  projectsRoot: process.env.CPV_PROJECTS_ROOT,
  logLines,
  emit: (event, data) => post({event, data}),
});

const handle = async (msg: EngineRequest) => {
  const fn = (engine as unknown as Record<string, (p: unknown) => Promise<unknown>>)[msg.method];
  if (typeof fn !== 'function' || msg.method === ('shutdown' as never)) {
    post({id: msg.id, error: {message: `Unknown engine method ${String(msg.method)}`}});
    return;
  }
  try {
    post({id: msg.id, result: await fn(msg.params ?? {})});
  } catch (e) {
    const err = e as Error & {code?: string};
    post({id: msg.id, error: {message: err.message, code: err.name === 'Cancelled' ? 'cancelled' : err.code}});
  }
};

const onMessage = (m: unknown) => {
  const msg = m as EngineRequest | {type: 'shutdown'};
  if ((msg as {type?: string}).type === 'shutdown') { engine.shutdown(); process.exit(0); }
  void handle(msg as EngineRequest);
};
if (parentPort) parentPort.on('message', (e) => onMessage(e.data));
else process.on('message', onMessage);

process.on('uncaughtException', (e) => post({event: 'log', data: {level: 'error', message: `uncaught: ${e.stack ?? e}`}}));
process.on('unhandledRejection', (e) => post({event: 'log', data: {level: 'error', message: `unhandled: ${String(e)}`}}));
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { engine.shutdown(); process.exit(0); });
post({event: 'log', data: {level: 'info', message: `engine ready (pid ${process.pid}, ${parentPort ? 'utilityProcess' : 'child process'})`}});
