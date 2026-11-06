// Engine → main calls for the director's CustomerPro services (the Sanctum token never enters the engine):
// the engine emits `hostCall {id, op, params}`; main runs it and answers with the `hostReply` engine method.
import type {DirectorHost, HostCall, HostOp, HostOps, HostReply} from '../../shared/director.js';

export const createHostClient = (send: (c: HostCall) => void, timeoutMs = 120_000) => {
  let seq = 0;
  const pending = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  const call = <K extends HostOp>(op: K, params: HostOps[K]['in']) => new Promise<HostOps[K]['out']>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${op} timed out`), {code: 'offline'})); }, timeoutMs);
    pending.set(id, {resolve: resolve as (v: unknown) => void, reject, timer});
    send({id, op, params});
  });
  const host = Object.fromEntries((['createSession', 'sessionStatus', 'closeSession', 'transcribe', 'synthesize', 'music', 'brand'] as HostOp[]).map((op) => [op, (p: never) => call(op, p)])) as DirectorHost;
  return {
    host,
    reply(r: HostReply) {
      const p = pending.get(r.id);
      if (!p) return false;
      pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.error) p.reject(Object.assign(new Error(r.error.message), {code: r.error.code}));
      else p.resolve(r.result);
      return true;
    },
  };
};
