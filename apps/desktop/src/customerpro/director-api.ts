// CustomerPro desktop API for the director (contracts.md §1: Director sessions, Speech, Library), used by the
// main process to serve the engine's host calls. Errors carry a `code` the director understands
// (insufficient_credits, invalid_token, offline, not_linked, …).
import fs from 'node:fs';
import path from 'node:path';
import type {DirectorHost, DirectorMode, MusicTrack, SessionInfo} from '../shared/director.js';
import {readLink} from '../engine/projects.js';

export interface DirectorApiOptions {
  baseUrl: string;
  getToken: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
  // When a project isn't linked to CustomerPro yet, link it (director sessions are per CustomerPro project).
  ensureLinked?: (dir: string) => Promise<void>;
  timeoutMs?: number;
}

const err = (message: string, code: string, status?: number) => Object.assign(new Error(message), {code, status});

export class DirectorApi {
  private f: typeof fetch;
  constructor(private o: DirectorApiOptions) { this.f = o.fetch ?? fetch; }
  private get api() { return `${this.o.baseUrl.replace(/\/+$/, '')}/api/desktop/v1`; }

  private async req(method: string, route: string, body?: BodyInit | object, o: {raw?: boolean; timeoutMs?: number} = {}) {
    const token = await this.o.getToken();
    if (!token) throw err('Sign in to CustomerPro to use the AI director', 'invalid_token', 401);
    const headers: Record<string, string> = {Accept: o.raw ? '*/*' : 'application/json', Authorization: `Bearer ${token}`};
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res: Response;
    try {
      res = await this.f(`${this.api}/${route}`, {method, headers, body: payload, signal: AbortSignal.timeout(o.timeoutMs ?? this.o.timeoutMs ?? 60_000)});
    } catch (e) { throw err(`Cannot reach CustomerPro (${(e as Error).message})`, 'offline'); }
    if (!res.ok) {
      const text = await res.text();
      let j: {error?: string; message?: string} = {};
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      throw err(j.message ?? `CustomerPro returned ${res.status}`, j.error ?? (res.status === 402 ? 'insufficient_credits' : res.status === 401 ? 'invalid_token' : `http_${res.status}`), res.status);
    }
    return res;
  }
  private async json<T>(method: string, route: string, body?: object) { return (await (await this.req(method, route, body)).json()) as T; }

  async createSession(p: {dir: string; mode: DirectorMode; premium?: boolean}): Promise<SessionInfo> {
    let link = readLink(p.dir);
    if (!link && this.o.ensureLinked) { await this.o.ensureLinked(p.dir); link = readLink(p.dir); }
    if (!link) throw err('Link this project to CustomerPro to use the AI director', 'not_linked');
    return this.json('POST', 'director/sessions', {project_id: link.projectId, mode: p.mode, ...(p.premium ? {premium: true} : {})});
  }
  sessionStatus(p: {sid: string}) { return this.json<{status: 'open' | 'closed'; spent_credits: number; budget_credits: number}>('GET', `director/sessions/${encodeURIComponent(p.sid)}`); }
  closeSession(p: {sid: string}) { return this.json<{charged_credits: number; released_credits: number}>('POST', `director/sessions/${encodeURIComponent(p.sid)}/close`); }

  async transcribe(p: {file: string; language?: string}) {
    const st = fs.statSync(p.file);
    if (st.size > 25 * 1024 * 1024) throw err('Audio over 25 MB: transcribe a shorter range', 'validation');
    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(p.file)], {type: 'audio/wav'}), path.basename(p.file));
    if (p.language) form.append('language', p.language);
    return (await (await this.req('POST', 'speech/transcribe', form, {timeoutMs: 180_000})).json()) as {text: string; segments: {start: number; end: number; text: string}[]; credits_charged?: number};
  }
  async synthesize(p: {text: string; language: string; speaker: string; pace?: number}) {
    const res = await this.req('POST', 'speech/synthesize', p, {raw: true, timeoutMs: 120_000});
    return {wavBase64: Buffer.from(await res.arrayBuffer()).toString('base64'), credits: Number(res.headers.get('X-Credits-Charged') ?? 0)};
  }
  async music() { return (await this.json<{data: MusicTrack[]}>('GET', 'music')).data; }
  brand() { return this.json<Record<string, unknown>>('GET', 'brand'); }

  // The engine's DirectorHost served from here (main process).
  asHost(): DirectorHost {
    return {
      createSession: (p) => this.createSession(p), sessionStatus: (p) => this.sessionStatus(p), closeSession: (p) => this.closeSession(p),
      transcribe: (p) => this.transcribe(p), synthesize: (p) => this.synthesize(p), music: () => this.music(), brand: () => this.brand(),
    };
  }
}
