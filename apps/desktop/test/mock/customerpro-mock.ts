// A small in-memory CustomerPro desktop API (contracts.md §1) for tests and local runs of the app.
// Run standalone: `node dist/mock-server.js` (built by scripts/build.mjs), then CUSTOMERPRO_URL=http://127.0.0.1:4455.
import crypto from 'node:crypto';
import http from 'node:http';

export interface MockMe {
  installed?: boolean;
  permissions?: Partial<{view: boolean; edit: boolean; export: boolean; delete: boolean}>;
  min_version?: string | null;
}

export interface MockOptions {
  port?: number;
  autoApproveAfterPolls?: number; // approve device codes automatically (standalone dev mode)
  singleMaxBytes?: number; // presign: above this → multipart (contract: 100 MB)
  partSize?: number;
  me?: MockMe;
}

interface Device { device_code: string; user_code: string; status: 'pending' | 'approved' | 'denied'; polls: number; expiresAt: number; token?: string }
interface Proj { id: number; name: string; rev: number; project: any; updated_at: string; last_edited_on: 'web' | 'desktop' | null }
interface Upload { key: string; path: string; size: number; parts: Map<number, Buffer>; single?: Buffer }
// Final exports and renders (contracts §1 "Export and publish").
interface MockExport { id: number; projectId: number; kind: 'reexport' | 'free' | 'paid'; charged: number; expiresAt: number }
interface MockRender { media_asset_id: number; projectId: number; key: string; filename: string; variant: string; export_id: number; size: number; width: number; height: number; duration: number }

export const createMockServer = async (o: MockOptions = {}) => {
  const devices = new Map<string, Device>();
  const tokens = new Map<string, {userId: number; revoked: boolean}>();
  const projects = new Map<number, Proj>();
  const uploads = new Map<string, Upload>(); // by upload id / key
  const objects = new Map<string, Buffer>(); // key → bytes (the "R2 bucket")
  const log: {method: string; path: string; status: number}[] = [];
  // failNextPut: drop the connection on the next PUT of any kind; revokeUrlsUpTo: upload URLs of generation ≤ N
  // answer 403 (an expired presign), so resign / re-presign has to hand out fresh ones.
  const faults = {failNextPartPut: 0, expireNextPut: 0, failNextPut: 0, revokeUrlsUpTo: 0};
  let urlGen = 0;
  const gen = () => ++urlGen;
  const account = {balance: 1200, used: 3, videos_per_month: 20, priceCredits: 50};
  const exportsById = new Map<number, MockExport>();
  const reexportUntil = new Map<number, number>(); // project id → ms
  const renders: MockRender[] = [];
  let nextExport = 500, nextAsset = 9000;
  let nextProject = 100;
  const state = {devices, tokens, projects, uploads, objects, log, faults, account, exports: exportsById, renders, me: {installed: true, permissions: {view: true, edit: true, export: true, delete: true}, min_version: null as string | null, ...o.me} as Required<MockMe>};
  const singleMax = o.singleMaxBytes ?? 100 * 1024 * 1024;
  const partSize = o.partSize ?? 8 * 1024 * 1024;
  let base = '';

  const json = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, {'Content-Type': 'application/json'}).end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((resolve) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const auth = (req: http.IncomingMessage) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const rec = t ? tokens.get(t) : undefined;
    return rec && !rec.revoked ? t : undefined;
  };
  const perm = () => state.me.permissions as {view: boolean; edit: boolean; export: boolean; delete: boolean};

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const send = (status: number, body?: unknown) => { log.push({method: req.method!, path: p, status}); json(res, status, body); };
    try {
      // ---- object storage (presigned PUTs) ----
      if (p.startsWith('/upload/') && req.method === 'PUT') {
        const body = await readBody(req);
        if (faults.expireNextPut > 0) { faults.expireNextPut--; return send(403, {error: 'expired'}); }
        if (Number(url.searchParams.get('g') ?? 0) <= faults.revokeUrlsUpTo) return send(403, {error: 'expired'});
        if (faults.failNextPut > 0) { faults.failNextPut--; req.socket.destroy(); return; }
        if (faults.failNextPartPut > 0 && url.searchParams.has('part')) { faults.failNextPartPut--; req.socket.destroy(); return; }
        if (Number(req.headers['content-length']) !== body.length) return send(400, {error: 'length'});
        const id = decodeURIComponent(p.slice('/upload/'.length));
        const up = uploads.get(id);
        if (!up) return send(404, {error: 'no upload'});
        const part = url.searchParams.get('part');
        if (part) up.parts.set(Number(part), body); else up.single = body;
        const etag = crypto.createHash('md5').update(body).digest('hex');
        log.push({method: 'PUT', path: p, status: 200});
        res.writeHead(200, {ETag: `"${etag}"`}).end();
        return;
      }
      // ---- object storage (public GET, used for the media list's download URLs) ----
      if (p.startsWith('/objects/') && req.method === 'GET') {
        const b = objects.get(decodeURIComponent(p.slice('/objects/'.length)));
        if (!b) return send(404, {error: 'not_found'});
        log.push({method: 'GET', path: p, status: 200});
        res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': b.length}).end(b);
        return;
      }
      if (p === '/desktop/link') {
        // Dev page: approve the code shown in the app.
        const code = url.searchParams.get('code') ?? '';
        const dev = [...devices.values()].find((d) => d.user_code === code);
        if (url.searchParams.get('allow') && dev) dev.status = 'approved';
        if (url.searchParams.get('deny') && dev) dev.status = 'denied';
        res.writeHead(200, {'Content-Type': 'text/html'}).end(`<h1>Mock CustomerPro</h1><p>Device code ${code}: ${dev?.status ?? 'unknown'}</p><a href="?code=${code}&allow=1">Allow</a> · <a href="?code=${code}&deny=1">Deny</a>`);
        return;
      }
      const m = /^\/api\/desktop\/v1\/(.*)$/.exec(p);
      if (!m) return send(404, {error: 'not_found', message: 'Not found'});
      const route = m[1];
      const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString()) : {};

      if (route === 'auth/device' && req.method === 'POST') {
        if (!body.device_name || !['win', 'mac'].includes(body.platform)) return send(422, {error: 'validation', message: 'device_name and platform required'});
        const d: Device = {device_code: crypto.randomBytes(16).toString('hex'), user_code: `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${String(crypto.randomInt(1000, 9999))}`, status: 'pending', polls: 0, expiresAt: Date.now() + 600_000};
        devices.set(d.device_code, d);
        return send(200, {device_code: d.device_code, user_code: d.user_code, verification_url: `${base}/desktop/link?code=${d.user_code}`, interval: 5, expires_in: 600});
      }
      if (route === 'auth/device/poll' && req.method === 'POST') {
        const d = devices.get(body.device_code);
        if (!d) return send(410, {error: 'expired_token', message: 'Unknown code'});
        d.polls++;
        if (o.autoApproveAfterPolls && d.polls >= o.autoApproveAfterPolls && d.status === 'pending') d.status = 'approved';
        if (Date.now() > d.expiresAt) return send(410, {error: 'expired_token', message: 'Expired'});
        if (d.status === 'denied') return send(403, {error: 'access_denied', message: 'Denied'});
        if (d.status === 'pending') return send(428, {error: 'authorization_pending', message: 'Waiting'});
        devices.delete(d.device_code);
        const token = `${crypto.randomInt(1, 999)}|${crypto.randomBytes(20).toString('hex')}`;
        tokens.set(token, {userId: 7, revoked: false});
        return send(200, {token, expires_at: new Date(Date.now() + 90 * 864e5).toISOString(), user: {id: 7, name: 'Asha Owner', email: 'asha@example.com'}, workspace: {id: 3, name: 'KK Park'}});
      }

      const token = auth(req);
      if (!token) return send(401, {error: 'invalid_token', message: 'Token invalid or revoked'});

      if (route === 'me' && req.method === 'GET') {
        return send(200, {
          user: {id: 7, name: 'Asha Owner', email: 'asha@example.com'}, workspace: {id: 3, name: 'KK Park'}, plan: {name: state.me.installed ? 'Growth' : 'Starter'},
          video: {installed: state.me.installed, permissions: {view: false, edit: false, export: false, delete: false, ...state.me.permissions}},
          credits: {balance: account.balance}, allowance: {videos_per_month: account.videos_per_month, used: account.used, resets_at: '2026-12-01T00:00:00Z'},
          limits: {max_render_bytes: 150e6, max_project_media_bytes: 2e9, max_file_bytes: 500e6}, min_version: state.me.min_version,
        });
      }
      if (route === 'auth/logout' && req.method === 'POST') { tokens.get(token)!.revoked = true; return send(204); }
      if (!state.me.installed) return send(403, {error: 'plan_required', message: 'Video is not on this plan'});

      if (route === 'projects' && req.method === 'GET') {
        if (!perm().view) return send(403, {error: 'forbidden', message: 'video.view required'});
        return send(200, {data: [...projects.values()].map(({project: _p, ...r}) => ({...r, poster_url: null})), next_page: null});
      }
      if (route === 'projects' && req.method === 'POST') {
        if (!perm().edit) return send(403, {error: 'forbidden', message: 'video.edit required'});
        const sizes: Record<string, [number, number]> = {reel: [1080, 1920], square: [1080, 1080], portrait: [1080, 1350], landscape: [1920, 1080]};
        const [w, h] = sizes[body.preset] ?? sizes.reel;
        const pr: Proj = {id: nextProject++, name: body.name, rev: 1, updated_at: new Date().toISOString(), last_edited_on: null,
          project: {dtly: 1, name: body.name, root: 'main', comps: [{id: 'main', width: w, height: h, fps: 30, duration: 10, layers: []}]}};
        projects.set(pr.id, pr);
        return send(201, {id: pr.id, name: pr.name, rev: pr.rev, project: pr.project});
      }
      if (route === 'exports' && req.method === 'POST') {
        if (!perm().export) return send(403, {error: 'forbidden', message: 'video.export required'});
        const pr = projects.get(Number(body.project_id));
        if (!pr || !(Number(body.duration) > 0) || !/^[a-z0-9_-]+$/.test(String(body.preset))) return send(422, {error: 'validation', message: 'project_id, duration, preset'});
        const now = Date.now();
        let kind: MockExport['kind'], charged = 0;
        if ((reexportUntil.get(pr.id) ?? 0) > now) kind = 'reexport';
        else {
          if (account.used < account.videos_per_month) { kind = 'free'; account.used++; }
          else {
            if (account.balance < account.priceCredits) return send(402, {error: 'insufficient_credits', message: 'Not enough credits', price_credits: account.priceCredits});
            kind = 'paid'; charged = account.priceCredits; account.balance -= charged;
          }
          reexportUntil.set(pr.id, now + 7 * 864e5);
        }
        const ex: MockExport = {id: nextExport++, projectId: pr.id, kind, charged, expiresAt: now + 7 * 864e5};
        exportsById.set(ex.id, ex);
        return send(200, {grant: `grant.${ex.id}.${crypto.randomBytes(6).toString('hex')}`, export_id: ex.id, kind, charged_credits: charged,
          allowance: {used: account.used, videos_per_month: account.videos_per_month}, free_reexport_until: new Date(reexportUntil.get(pr.id)!).toISOString()});
      }
      const pm = /^projects\/(\d+)(\/.*)?$/.exec(route);
      if (pm) {
        const pr = projects.get(Number(pm[1]));
        if (!pr) return send(404, {error: 'not_found', message: 'No such project'});
        const sub = pm[2] ?? '';
        if (!sub && req.method === 'GET') return send(200, {id: pr.id, name: pr.name, rev: pr.rev, project: pr.project, updated_at: pr.updated_at, last_edited_on: pr.last_edited_on});
        if (sub === '/media' && req.method === 'GET') {
          const prefix = `3/video/${pr.id}/`;
          const data = [...objects.entries()].filter(([k]) => k.startsWith(prefix) && /^(media|vo|music)\//.test(k.slice(prefix.length)))
            .map(([k, b]) => ({path: k.slice(prefix.length), size: b.length, content_type: 'application/octet-stream', url: `${base}/objects/${encodeURIComponent(k)}`, updated_at: new Date().toISOString()}));
          return send(200, {data});
        }
        const validExport = (id: unknown) => { const ex = exportsById.get(Number(id)); return ex && ex.projectId === pr.id && ex.expiresAt > Date.now() ? ex : undefined; };
        if (sub === '/renders/presign' && req.method === 'POST') {
          if (!perm().export) return send(403, {error: 'forbidden', message: 'video.export required'});
          if (!validExport(body.export_id)) return send(403, {error: 'export_required', message: 'Export first'});
          if (!(body.size > 0) || body.size > 150e6 || !/^[\w.-]+\.mp4$/.test(String(body.filename))) return send(422, {error: 'validation', message: 'bad render'});
          const key = `3/video/${pr.id}/renders/${body.export_id}-${body.filename}`;
          const id = crypto.randomBytes(8).toString('hex');
          uploads.set(id, {key, path: `renders/${body.filename}`, size: body.size, parts: new Map()});
          return send(200, {mode: 'single', key, url: `${base}/upload/${id}?g=${gen()}`});
        }
        if (sub === '/renders' && req.method === 'POST') {
          if (!perm().export) return send(403, {error: 'forbidden', message: 'video.export required'});
          const ex = validExport(body.export_id);
          if (!ex) return send(403, {error: 'export_required', message: 'Export first'});
          if (!['main', 'whatsapp'].includes(body.variant)) return send(422, {error: 'validation', message: 'variant'});
          const up = [...uploads.entries()].find(([, u]) => u.key === body.key && u.single);
          if (!up) return send(422, {error: 'validation', message: 'nothing uploaded'});
          objects.set(body.key, up[1].single!);
          uploads.delete(up[0]);
          const r: MockRender = {media_asset_id: nextAsset++, projectId: pr.id, key: body.key, filename: body.filename, variant: body.variant, export_id: ex.id, size: objects.get(body.key)!.length, width: body.width, height: body.height, duration: body.duration};
          renders.push(r);
          return send(200, {media_asset_id: r.media_asset_id, url: `https://media.example/${body.key}`});
        }
        if (!perm().edit) return send(403, {error: 'forbidden', message: 'video.edit required'});
        if (sub === '/media/resign' && req.method === 'POST') {
          const up = uploads.get(String(body.upload_id));
          if (!up || up.key !== body.key || !up.key.startsWith(`3/video/${pr.id}/`)) return send(404, {error: 'not_found', message: 'upload'});
          const g = gen();
          return send(200, {parts: (body.parts as number[]).map((n) => ({n, url: `${base}/upload/${body.upload_id}?part=${n}&g=${g}`}))});
        }
        if (!sub && req.method === 'PUT') {
          if (body.rev !== pr.rev) return send(409, {error: 'conflict', message: 'Changed elsewhere', rev: pr.rev});
          const bad = JSON.stringify(body.project).match(/"src":"(\/|[a-z]:|\.\.)[^"]*"/i);
          if (body.project?.dtly !== 1 || bad) return send(422, {error: 'validation', errors: [bad ? `bad src ${bad[0]}` : 'not a project']});
          Object.assign(pr, {project: body.project, rev: pr.rev + 1, updated_at: new Date().toISOString(), last_edited_on: body.client === 'desktop' ? 'desktop' : 'web', name: body.project.name ?? pr.name});
          return send(200, {rev: pr.rev, warnings: []});
        }
        if (sub === '/media/presign' && req.method === 'POST') {
          if (!/^(media|vo|music)\/[^\\]+$/.test(body.path) || String(body.path).includes('..')) return send(422, {error: 'validation', message: 'bad path'});
          const key = `3/video/${pr.id}/${body.path}`;
          if (body.size <= singleMax) {
            const id = crypto.randomBytes(8).toString('hex');
            uploads.set(id, {key, path: body.path, size: body.size, parts: new Map()});
            return send(200, {mode: 'single', key, url: `${base}/upload/${id}?g=${gen()}`});
          }
          const id = crypto.randomBytes(8).toString('hex');
          uploads.set(id, {key, path: body.path, size: body.size, parts: new Map()});
          const n = Math.ceil(body.size / partSize);
          const g = gen();
          return send(200, {mode: 'multipart', key, upload_id: id, part_size: partSize, parts: [...Array(n).keys()].map((i) => ({n: i + 1, url: `${base}/upload/${id}?part=${i + 1}&g=${g}`}))});
        }
        if (sub === '/media/complete' && req.method === 'POST') {
          let bytes: Buffer;
          if (body.upload_id) {
            const up = uploads.get(body.upload_id);
            if (!up) return send(404, {error: 'not_found', message: 'upload'});
            const parts = (body.parts as {n: number; etag: string}[]).sort((a, b) => a.n - b.n);
            for (const pt of parts) {
              const b = up.parts.get(pt.n);
              if (!b || crypto.createHash('md5').update(b).digest('hex') !== pt.etag) return send(422, {error: 'validation', message: `part ${pt.n} etag mismatch`});
            }
            bytes = Buffer.concat(parts.map((pt) => up.parts.get(pt.n)!));
            uploads.delete(body.upload_id);
          } else {
            const up = [...uploads.entries()].find(([, u]) => u.key === body.key && u.single);
            if (!up) return send(422, {error: 'validation', message: 'nothing uploaded'});
            bytes = up[1].single!;
            uploads.delete(up[0]);
          }
          if (bytes.length !== body.size) return send(422, {error: 'validation', message: `size ${bytes.length} != ${body.size}`});
          objects.set(body.key, bytes);
          return send(200, {path: body.path, url: `https://media.example/${body.key}`});
        }
      }
      return send(404, {error: 'not_found', message: `No route ${req.method} ${route}`});
    } catch (e) {
      send(500, {error: 'server', message: (e as Error).message});
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {
    url: base,
    state,
    approve: (userCode: string) => { const d = [...devices.values()].find((x) => x.user_code === userCode); if (d) d.status = 'approved'; return !!d; },
    deny: (userCode: string) => { const d = [...devices.values()].find((x) => x.user_code === userCode); if (d) d.status = 'denied'; },
    revokeAll: () => { for (const t of tokens.values()) t.revoked = true; },
    // Simulate a teammate editing on the web.
    webEdit: (id: number, fn: (project: any) => void) => { const pr = projects.get(id)!; fn(pr.project); pr.rev++; pr.last_edited_on = 'web'; },
    // Expire every upload URL handed out so far (resumes later must resign / re-presign).
    expireUploadUrls: () => { faults.revokeUrlsUpTo = urlGen; },
    expireExport: (id: number) => { const ex = exportsById.get(id); if (ex) ex.expiresAt = 0; },
    // Media already on the web for a project (as if uploaded from the web editor or another computer).
    seedMedia: (projectId: number, rel: string, bytes: Buffer) => { objects.set(`3/video/${projectId}/${rel}`, bytes); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
};

// Standalone: node dist/mock-server.js [port]
if (process.argv[1] && /mock-server\.js$/.test(process.argv[1])) {
  const port = Number(process.argv[2] ?? 4455);
  createMockServer({port, autoApproveAfterPolls: 2}).then((m) => console.log(`Mock CustomerPro on ${m.url} (device codes auto-approve after 2 polls)`));
}
