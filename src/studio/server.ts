// DT.ly Studio server: serves the browser editor for one project file on 127.0.0.1.
// Edits are saved back to the file; external edits (agents via MCP, other tools) stream live to the page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Project} from '../core/model.js';
import {validate} from '../ops/ops.js';
import {readProject, writeProject} from '../ops/store.js';
import {renderVideoParallel} from '../render/export.js';
import {BRAND, VERSION} from '../version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/studio/server.js → dist/studio-app ; src/studio/server.ts (dev) → dist/studio-app
const APP_DIR = [path.resolve(here, '../studio-app'), path.resolve(here, '../../dist/studio-app')].find((d) => fs.existsSync(path.join(d, 'index.html')));
const FONTS_DIR = path.resolve(here, '../../fonts');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// Streams a file with HTTP Range support (browsers need it to seek video).
const sendFile = (req: http.IncomingMessage, res: http.ServerResponse, file: string) => {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { res.writeHead(404).end('Not found'); return; }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache'});
    fs.createReadStream(file, {start, end}).pipe(res);
  } else {
    res.writeHead(200, {'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
  }
};

const readBody = (req: http.IncomingMessage, limit = 20 * 1024 * 1024) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

// Only files the project references (plus renders made from the studio) can be served.
const mediaFiles = (p: Project, baseDir: string, extra: Set<string>) => {
  const files = new Set<string>(extra);
  for (const c of p.comps) for (const l of c.layers) {
    if ('src' in l && typeof l.src === 'string') files.add(path.resolve(baseDir, l.src));
    for (const e of l.effects ?? []) if ('src' in e && typeof e.src === 'string') files.add(path.resolve(baseDir, e.src));
  }
  for (const list of Object.values(p.fonts ?? {})) for (const f of list) files.add(path.resolve(baseDir, f));
  return files;
};

export interface StudioOptions { project: string; port?: number; host?: string; onReady?: (url: string) => void }

export const startStudio = async (opts: StudioOptions) => {
  if (!APP_DIR) throw new Error('Studio app bundle not found. Run `npm run build` first.');
  const projectFile = path.resolve(opts.project);
  const baseDir = path.dirname(projectFile);
  readProject(projectFile); // fail fast on a bad file
  const token = crypto.randomBytes(16).toString('hex');
  const clients = new Set<http.ServerResponse>();
  const rendered = new Set<string>();
  let rev = 1;
  let ownMtime = 0;
  let rendering = false;

  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Watch the directory (editors and atomic writes replace the file, which breaks file watches).
  let debounce: NodeJS.Timeout | undefined;
  const watcher = fs.watch(baseDir, (_e, name) => {
    if (name !== path.basename(projectFile)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const m = fs.statSync(projectFile).mtimeMs;
        if (Math.abs(m - ownMtime) < 1) return;
        readProject(projectFile);
        rev++;
        broadcast('project', {rev, source: 'disk'});
      } catch { /* half-written file; the next event will catch the final state */ }
    }, 120);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const api = url.pathname.startsWith('/api/');
    if (api && req.headers['x-dtly-token'] !== token && url.searchParams.get('token') !== token) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8').replace('__DTLY_CONFIG__', JSON.stringify({token, file: path.basename(projectFile), version: VERSION, brand: BRAND}));
        res.writeHead(200, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'}).end(html);
      } else if (url.pathname.startsWith('/app/')) {
        const file = path.join(APP_DIR, path.normalize(url.pathname.slice(5)).replace(/^(\.\.[/\\])+/, ''));
        if (!file.startsWith(APP_DIR)) { res.writeHead(403).end(); return; }
        sendFile(req, res, file);
      } else if (url.pathname.startsWith('/fonts/')) {
        const file = path.join(FONTS_DIR, path.basename(url.pathname));
        sendFile(req, res, file);
      } else if (url.pathname === '/api/project' && req.method === 'GET') {
        res.writeHead(200, {'Content-Type': MIME['.json'], 'Cache-Control': 'no-store'}).end(JSON.stringify({rev, project: readProject(projectFile)}));
      } else if (url.pathname === '/api/project' && req.method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as {project: Project};
        if (body.project?.dtly !== 1) throw new Error('Not a DT.ly project');
        writeProject(projectFile, body.project);
        ownMtime = fs.statSync(projectFile).mtimeMs;
        rev++;
        res.writeHead(200, {'Content-Type': MIME['.json']}).end(JSON.stringify({rev, warnings: validate(body.project)}));
      } else if (url.pathname === '/api/media') {
        const src = url.searchParams.get('src') ?? '';
        const file = path.resolve(baseDir, src);
        if (!mediaFiles(readProject(projectFile), baseDir, rendered).has(file)) { res.writeHead(403).end('Not a project file'); return; }
        sendFile(req, res, file);
      } else if (url.pathname === '/api/svg') {
        // SVG text for "import as shapes" (only .svg files inside the project folder).
        const file = path.resolve(baseDir, url.searchParams.get('src') ?? '');
        if (!file.startsWith(baseDir + path.sep) || path.extname(file).toLowerCase() !== '.svg') { res.writeHead(403).end('Only .svg files inside the project folder'); return; }
        sendFile(req, res, file);
      } else if (url.pathname === '/api/events') {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
        res.write(`event: hello\ndata: ${JSON.stringify({rev})}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (url.pathname === '/api/render' && req.method === 'POST') {
        if (rendering) { res.writeHead(409).end('A render is already running'); return; }
        const body = JSON.parse((await readBody(req)) || '{}') as {out?: string; from?: number; to?: number; comp?: string};
        const out = path.resolve(baseDir, body.out || `${path.basename(projectFile, '.json')}.mp4`);
        rendering = true;
        res.writeHead(202, {'Content-Type': MIME['.json']}).end(JSON.stringify({out}));
        const t0 = Date.now();
        renderVideoParallel(projectFile, out, {from: body.from, to: body.to, comp: body.comp, onProgress: (done, total) => { if (done % 10 === 0 || done === total) broadcast('render', {done, total}); }})
          .then((r) => { rendered.add(out); broadcast('render', {finished: true, out: path.relative(baseDir, out), seconds: r.seconds, took: (Date.now() - t0) / 1000}); })
          .catch((e) => broadcast('render', {error: (e as Error).message}))
          .finally(() => { rendering = false; });
      } else {
        res.writeHead(404).end('Not found');
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, {'Content-Type': 'text/plain'}).end((e as Error).message);
    }
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4400, host, () => resolve());
  });
  const addr = server.address() as {port: number};
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}/`;
  opts.onReady?.(url);
  const close = () => { watcher.close(); clients.forEach((c) => c.end()); server.close(); };
  return {url, close, server};
};
