import type {Channel, Channels, CpvBridge, EventName, Events} from '../shared/bridge.js';

declare global { interface Window { cpv: CpvBridge } }

export const call = <C extends Channel>(ch: C, payload: Channels[C]['in'] = undefined as Channels[C]['in']) => window.cpv.invoke(ch, payload);
export const on = <E extends EventName>(ev: E, fn: (d: Events[E]) => void) => window.cpv.on(ev, fn);
export const mediaUrl = (abs: string) => `cpv-media://file/${encodeURIComponent(abs)}`;
export const join = (dir: string, rel: string) => `${dir}${dir.includes('\\') ? '\\' : '/'}${rel.replace(/\//g, dir.includes('\\') ? '\\' : '/')}`;
export const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export const fmtDur = (s?: number) => (s === undefined ? '' : s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
