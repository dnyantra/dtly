// Fake CustomerPro director side for tests: Laravel's director sessions, speech and library endpoints
// (contracts.md §1) plus the Cloudflare Worker's POST {proxy_url}/v1/messages (§2) answering with scripted
// Anthropic SSE streams. No real model is ever called.
import crypto from 'node:crypto';
import http from 'node:http';

export type Turn =
  | {text?: string; tools?: {name: string; input: unknown; id?: string}[]; usage?: {input: number; output: number}}
  | {status: number; error: string; message?: string};

export interface ProxyCall { model: string; body: any; headers: http.IncomingHttpHeaders; sid: string }

export interface DirectorMockOptions {
  // Scripted model: returns the next turn for a request. `n` counts calls in this session (0-based).
  respond?: (call: ProxyCall, n: number) => Turn;
  budgetCredits?: number;
  creditsPerCall?: number;
  sessionStatus?: number; // e.g. 402 to refuse a session
  models?: Record<string, string>;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// A tiny valid WAV: `pad` s of silence, `tone` s of 440 Hz, `pad` s of silence (16 kHz mono s16).
export const wavWithSilence = (pad = 0.5, tone = 1) => {
  const rate = 16000;
  const n = Math.round((pad * 2 + tone) * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t >= pad && t < pad + tone ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000) : 0;
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

export const createDirectorMock = async (o: DirectorMockOptions = {}) => {
  const models = o.models ?? {analyse: 'claude-haiku-5-5', build: 'claude-sonnet-5-5', edit: 'claude-sonnet-5-5', premium: 'claude-opus-5-5'};
  const sessions = new Map<string, {sid: string; token: string; mode: string; projectId: unknown; models: string[]; budget: number; spent: number; status: 'open' | 'closed'; calls: number}>();
  const calls: ProxyCall[] = [];
  const log: {method: string; path: string; status: number; body?: any}[] = [];
  const state = {respond: o.respond ?? ((): Turn => ({text: 'Done.'})), sessionStatus: o.sessionStatus, budget: o.budgetCredits ?? 100, perCall: o.creditsPerCall ?? 1, transcribes: 0, synthesizes: 0};
  let base = '';

  const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((resolve) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const json = (status: number, body?: unknown) => {
      log.push({method: req.method!, path: p, status});
      res.writeHead(status, {'Content-Type': 'application/json'}).end(body === undefined ? '' : JSON.stringify(body));
    };
    try {
      // ---------------- Worker: POST /proxy/v1/messages ----------------
      if (p === '/proxy/v1/messages' && req.method === 'POST') {
        const tok = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const s = [...sessions.values()].find((x) => x.token === tok);
        if (!s || s.status !== 'open') return json(401, {error: 'invalid_token', message: 'Session token invalid'});
        const body = JSON.parse(raw.toString());
        if (!s.models.includes(body.model)) return json(403, {error: 'model_not_allowed', message: `${body.model} not allowed`});
        if (s.spent >= s.budget) return json(402, {error: 'budget_exhausted', message: 'Session budget reached'});
        const call: ProxyCall = {model: body.model, body, headers: req.headers, sid: s.sid};
        calls.push(call);
        const turn = state.respond(call, s.calls++);
        if ('status' in turn) return json(turn.status, {error: turn.error, message: turn.message ?? turn.error});
        s.spent += state.perCall;
        log.push({method: 'POST', path: p, status: 200});
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
        const id = `msg_${crypto.randomBytes(6).toString('hex')}`;
        const usage = turn.usage ?? {input: 100, output: 20};
        res.write(sse('message_start', {type: 'message_start', message: {id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: usage.input, output_tokens: 1}}}));
        let idx = 0;
        if (turn.text) {
          res.write(sse('content_block_start', {type: 'content_block_start', index: idx, content_block: {type: 'text', text: ''}}));
          // Stream in two chunks to exercise deltas.
          const half = Math.ceil(turn.text.length / 2);
          for (const part of [turn.text.slice(0, half), turn.text.slice(half)]) if (part) res.write(sse('content_block_delta', {type: 'content_block_delta', index: idx, delta: {type: 'text_delta', text: part}}));
          res.write(sse('content_block_stop', {type: 'content_block_stop', index: idx}));
          idx++;
        }
        for (const t of turn.tools ?? []) {
          const tid = t.id ?? `toolu_${crypto.randomBytes(6).toString('hex')}`;
          res.write(sse('content_block_start', {type: 'content_block_start', index: idx, content_block: {type: 'tool_use', id: tid, name: t.name, input: {}}}));
          res.write(sse('content_block_delta', {type: 'content_block_delta', index: idx, delta: {type: 'input_json_delta', partial_json: JSON.stringify(t.input ?? {})}}));
          res.write(sse('content_block_stop', {type: 'content_block_stop', index: idx}));
          idx++;
        }
        res.write(sse('message_delta', {type: 'message_delta', delta: {stop_reason: turn.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: usage.output}}));
        res.write(sse('message_stop', {type: 'message_stop'}));
        res.end();
        return;
      }

      // ---------------- library files (public URLs) ----------------
      if (p.startsWith('/files/music/')) {
        const name = p.slice('/files/music/'.length);
        if (name.endsWith('.beats.json')) return json(200, {bpm: 120, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3], downbeats: [0, 2]});
        log.push({method: 'GET', path: p, status: 200});
        res.writeHead(200, {'Content-Type': 'audio/wav'}).end(wavWithSilence(0, 3));
        return;
      }

      const m = /^\/api\/desktop\/v1\/(.*)$/.exec(p);
      if (!m) return json(404, {error: 'not_found'});
      if (req.headers.authorization !== 'Bearer sanctum-test') return json(401, {error: 'invalid_token', message: 'bad sanctum token'});
      const route = m[1];

      if (route === 'director/sessions' && req.method === 'POST') {
        const body = JSON.parse(raw.toString());
        if (state.sessionStatus) return json(state.sessionStatus, {error: state.sessionStatus === 402 ? 'insufficient_credits' : 'error', message: 'refused'});
        const sid = `ds_${crypto.randomBytes(4).toString('hex')}`;
        const model = body.premium ? models.premium : models[body.mode as string];
        const s = {sid, token: `jwt.${sid}.${crypto.randomBytes(8).toString('hex')}`, mode: body.mode, projectId: body.project_id, models: [model], budget: state.budget, spent: 0, status: 'open' as const, calls: 0};
        sessions.set(sid, s);
        log.push({method: 'POST', path: p, status: 201, body});
        res.writeHead(201, {'Content-Type': 'application/json'}).end(JSON.stringify({session_id: sid, token: s.token, proxy_url: `${base}/proxy`, models: s.models, budget_credits: s.budget, expires_at: new Date(Date.now() + 7200e3).toISOString()}));
        return;
      }
      const sm = /^director\/sessions\/([\w-]+)(\/close)?$/.exec(route);
      if (sm) {
        const s = sessions.get(sm[1]);
        if (!s) return json(404, {error: 'not_found'});
        if (sm[2] && req.method === 'POST') { s.status = 'closed'; return json(200, {charged_credits: s.spent, released_credits: s.budget - s.spent}); }
        return json(200, {status: s.status, spent_credits: s.spent, budget_credits: s.budget});
      }
      if (route === 'speech/transcribe' && req.method === 'POST') {
        state.transcribes++;
        if (!String(req.headers['content-type']).startsWith('multipart/form-data') || !raw.includes(Buffer.from('name="audio"'))) return json(422, {error: 'validation', message: 'audio missing'});
        return json(200, {text: 'Welcome to KK Park', segments: [{start: 0.2, end: 1.4, text: 'Welcome to KK Park'}], credits_charged: 1});
      }
      if (route === 'speech/synthesize' && req.method === 'POST') {
        state.synthesizes++;
        const body = JSON.parse(raw.toString());
        if (!body.text || !body.speaker || !body.language) return json(422, {error: 'validation', message: 'text, language, speaker required'});
        log.push({method: 'POST', path: p, status: 200});
        res.writeHead(200, {'Content-Type': 'audio/wav', 'X-Credits-Charged': '2'}).end(wavWithSilence(0.6, 1.2));
        return;
      }
      if (route === 'music' && req.method === 'GET') {
        return json(200, {data: [
          {id: 'techno-1', title: 'Night Drive', mood: 'techno', bpm: 120, duration: 3, url: `${base}/files/music/techno-1.wav`, beats_url: `${base}/files/music/techno-1.beats.json`, licence: 'CustomerPro library'},
          {id: 'calm-1', title: 'Morning', mood: 'calm', bpm: 90, duration: 3, url: `${base}/files/music/calm-1.wav`, beats_url: `${base}/files/music/calm-1.beats.json`, licence: 'CustomerPro library'},
        ]});
      }
      if (route === 'brand' && req.method === 'GET') {
        return json(200, {logo_url: null, colors: {primary: '#c6ff00', accent: '#ff2d2d', ink: '#111111'}, fonts: {heading: 'Baloo 2', body: 'Inter'}, business: {name: 'KK Park', phone: '+91 90000 00000', address: 'Palghar', website: 'kkpark.example'}});
      }
      return json(404, {error: 'not_found', message: route});
    } catch (e) {
      json(500, {error: 'server', message: (e as Error).message});
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {
    url: base,
    sanctumToken: 'sanctum-test',
    state,
    sessions,
    calls,
    log,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
};
