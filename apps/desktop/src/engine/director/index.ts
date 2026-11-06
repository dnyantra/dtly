// Engine handlers for the AI director (DirectorEngineApi), merged into the engine's request handlers.
import fs from 'node:fs';
import path from 'node:path';
import type {DirectorEngineApi, DirectorEvent, DirectorHost, HostCall} from '../../shared/director.js';
import {projectFile} from '../projects.js';
import {DirectorManager} from './manager.js';
import {createHostClient} from './rpc.js';

type Async<T> = {[K in keyof T]: T[K] extends (p: infer P) => infer R ? (p: P) => Promise<Awaited<R>> : never};
export type DirectorHandlers = Async<DirectorEngineApi>;

export interface DirectorHandlerOptions {
  emitEvent: (e: DirectorEvent) => void;
  emitHostCall: (c: HostCall) => void;
  projectsRoot?: string;
  host?: DirectorHost; // tests: call CustomerPro directly instead of through main
  fetch?: typeof fetch;
}

export const createDirectorHandlers = (o: DirectorHandlerOptions): DirectorHandlers & {shutdown: () => void; manager: DirectorManager} => {
  const rpc = createHostClient(o.emitHostCall);
  const manager = new DirectorManager({host: o.host ?? rpc.host, emit: o.emitEvent, projectsRoot: o.projectsRoot, fetch: o.fetch});
  const dirOf = (dir: string) => {
    const d = path.resolve(dir);
    if (!fs.existsSync(projectFile(d))) throw new Error(`Not a project folder: ${dir}`);
    return d;
  };
  const running = new Set<string>();
  const track = <T extends {runId: string}>(dir: string, r: T) => { running.add(dir); return r; };
  return {
    manager,
    async directorStatus() { return {available: true}; },
    async directorState(p) { return manager.state(dirOf(p.dir)); },
    async directorAnalyse(p) { const d = dirOf(p.dir); return track(d, manager.analyse(d, {ids: p.ids, force: p.force})); },
    async directorPlan(p) { const d = dirOf(p.dir); return track(d, manager.plan(d, {brief: p.brief, styleId: p.styleId, style: p.style, premium: p.premium})); },
    async directorApprove(p) { const d = dirOf(p.dir); return track(d, manager.approve(d, {plan: p.plan, premium: p.premium})); },
    async directorChat(p) { const d = dirOf(p.dir); return track(d, manager.chat(d, {text: p.text, premium: p.premium})); },
    async directorContinue(p) { const d = dirOf(p.dir); return track(d, manager.continue(d, {premium: p.premium})); },
    async directorStop(p) { return {stopped: manager.stop(dirOf(p.dir))}; },
    async directorAnswer(p) { return {ok: manager.answer(p.id, p.ok)}; },
    async directorSavePlan(p) { manager.savePlan(dirOf(p.dir), p.plan); return {ok: true}; },
    async hostReply(p) { return {ok: rpc.reply(p)}; },
    shutdown: () => { for (const d of running) manager.stop(d); },
  };
};
