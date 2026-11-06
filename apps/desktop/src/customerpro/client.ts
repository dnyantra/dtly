// CustomerPro desktop API client — contracts.md §1 (binding). Base: {CUSTOMERPRO_URL}/api/desktop/v1/.
import type {Me} from '../shared/types.js';

export const DEFAULT_CUSTOMERPRO_URL = 'https://customerpro.in';
export const customerProUrl = () => (process.env.CUSTOMERPRO_URL || DEFAULT_CUSTOMERPRO_URL).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
  }
}
export class NetworkError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkError'; }
}

export interface DeviceStart { device_code: string; user_code: string; verification_url: string; interval: number; expires_in: number }
export interface TokenResult { token: string; expires_at: string; user: {id: number | string; name: string; email: string}; workspace: {id: number | string; name: string} }
export type PollResult = {status: 'pending'} | {status: 'slow_down'} | {status: 'expired'} | {status: 'denied'} | ({status: 'ok'} & TokenResult);

export interface RemoteProjectRow { id: number | string; name: string; rev: number; updated_at: string; last_edited_on: 'web' | 'desktop' | null; poster_url: string | null }
export interface RemoteProject { id: number | string; name: string; rev: number; project: unknown; updated_at: string; last_edited_on: 'web' | 'desktop' | null }
export type Presign =
  | {mode: 'single'; key: string; url: string}
  | {mode: 'multipart'; key: string; upload_id: string; part_size: number; parts: {n: number; url: string}[]};

export interface ClientOptions {
  baseUrl?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  onUnauthorized?: (e: ApiError) => void; // revoked device / expired token → sign out (local projects stay)
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class CustomerProClient {
  readonly baseUrl: string;
  private f: typeof fetch;
  constructor(private o: ClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? customerProUrl()).replace(/\/+$/, '');
    this.f = o.fetch ?? fetch;
  }

  get apiBase() { return `${this.baseUrl}/api/desktop/v1`; }
  // The current Sanctum token, for calls that need their own transport (director multipart/audio). Never logged.
  async token() { return this.o.getToken?.(); }

  async request<T>(method: string, path: string, body?: unknown, opts: {auth?: boolean; okStatuses?: number[]} = {}): Promise<{status: number; data: T}> {
    const headers: Record<string, string> = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      const t = await this.o.getToken?.();
      if (!t) throw new ApiError(401, 'invalid_token', 'Not signed in');
      headers.Authorization = `Bearer ${t}`;
    }
    let res: Response;
    try {
      res = await this.f(`${this.apiBase}/${path.replace(/^\//, '')}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 30000)});
    } catch (e) {
      throw new NetworkError(`Cannot reach CustomerPro (${(e as Error).message})`);
    }
    const text = await res.text();
    let data: any = {};
    if (text) { try { data = JSON.parse(text); } catch { data = {message: text.slice(0, 200)}; } }
    if (res.ok || opts.okStatuses?.includes(res.status)) return {status: res.status, data: data as T};
    const err = new ApiError(res.status, data?.error ?? (res.status === 401 ? 'invalid_token' : `http_${res.status}`), data?.message ?? `CustomerPro returned ${res.status}`, data);
    if (res.status === 401 && opts.auth !== false) this.o.onUnauthorized?.(err);
    throw err;
  }

  // --- Sign-in (unauthenticated) ---
  async deviceStart(p: {device_name: string; platform: 'win' | 'mac'; app_version: string}) {
    return (await this.request<DeviceStart>('POST', 'auth/device', p, {auth: false})).data;
  }
  async devicePoll(device_code: string): Promise<PollResult> {
    try {
      const r = await this.request<TokenResult>('POST', 'auth/device/poll', {device_code}, {auth: false});
      return {status: 'ok', ...r.data};
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 428 || e.code === 'authorization_pending') return {status: 'pending'};
      if (e.status === 429 || e.code === 'slow_down') return {status: 'slow_down'};
      if (e.status === 410 || e.code === 'expired_token') return {status: 'expired'};
      if (e.status === 403 || e.code === 'access_denied') return {status: 'denied'};
      throw e;
    }
  }

  // --- Account ---
  async me() { return (await this.request<Me>('GET', 'me')).data; }
  async logout() { await this.request('POST', 'auth/logout'); }

  // --- Projects ---
  async listProjects(page?: number) {
    return (await this.request<{data: RemoteProjectRow[]; next_page: number | null}>('GET', `projects${page ? `?page=${page}` : ''}`)).data;
  }
  async createProject(p: {name: string; preset: 'reel' | 'square' | 'portrait' | 'landscape'}) {
    return (await this.request<{id: number | string; name: string; rev: number; project: unknown}>('POST', 'projects', p)).data;
  }
  async getProject(id: number | string) { return (await this.request<RemoteProject>('GET', `projects/${encodeURIComponent(String(id))}`)).data; }
  // 409 → ApiError code 'conflict' with body.rev (the server's current rev).
  async putProject(id: number | string, project: unknown, rev: number) {
    return (await this.request<{rev: number; warnings: string[]}>('PUT', `projects/${encodeURIComponent(String(id))}`, {project, rev, client: 'desktop'})).data;
  }

  // --- Project media ---
  async presignMedia(id: number | string, p: {path: string; size: number; content_type: string}) {
    return (await this.request<Presign>('POST', `projects/${encodeURIComponent(String(id))}/media/presign`, p)).data;
  }
  async completeMedia(id: number | string, p: {path: string; key: string; size: number; upload_id?: string; parts?: {n: number; etag: string}[]}) {
    return (await this.request<{path: string; url: string}>('POST', `projects/${encodeURIComponent(String(id))}/media/complete`, p)).data;
  }

  // --- Library ---
  async brand() { return (await this.request<Record<string, unknown>>('GET', 'brand')).data; }
}
