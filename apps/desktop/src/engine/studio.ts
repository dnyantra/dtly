// Studio inside the app (D4). The engine runs DT.ly's own Studio server for the open project, and a thin
// front server on 127.0.0.1 that serves Studio's page with the app's embed config (window.DTLY) and proxies
// everything else (API, media Range requests, SSE live reload) to DT.ly's server unchanged.
//
// Why a front server: DT.ly's startStudio() injects a fixed config {token, file, version, brand} and does
// not return its token. Until DT.ly accepts a config override (requested), we read the token from its page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {dtlyStudio, type StudioHandle} from './dtly.js';
import {projectFile, projectHash} from './projects.js';

export interface StudioEmbedOptions {
  brand?: string;
  readOnly?: boolean;
  parentOrigin?: string; // the shell's origin; Studio posts {type:'export'} there
}

export interface StudioSession {
  url: string; // what the shell frames
  dir: string;
  close: () => void;
  setOptions: (o: StudioEmbedOptions) => void;
}

const fetchText = (url: string) => new Promise<string>((resolve, reject) => {
  http.get(url, (res) => {
    let s = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (s += d));
    res.on('end', () => (res.statusCode === 200 ? resolve(s) : reject(new Error(`Studio returned ${res.statusCode}`))));
  }).on('error', reject);
});

const CONFIG_RE = /window\.DTLY = (\{[^<]*?\});/;

export const startStudioSession = async (dir: string, opts: StudioEmbedOptions & {onProjectChanged?: (e: {source: 'studio' | 'disk'; hash: string}) => void} = {}): Promise<StudioSession> => {
  const {startStudio} = await dtlyStudio();
  const upstream: StudioHandle = await startStudio({project: projectFile(dir), port: 0, host: '127.0.0.1'});
  const up = new URL(upstream.url);
  const html = await fetchText(upstream.url);
  const m = CONFIG_RE.exec(html);
  if (!m) { upstream.close(); throw new Error('Unexpected Studio page (no window.DTLY config)'); }
  const base = JSON.parse(m[1]) as {token: string; file: string; version: string; brand: string};
  let options: StudioEmbedOptions = {...opts};

  const page = async () => {
    const src = await fetchText(upstream.url); // fresh each time: picks up a rebuilt Studio bundle
    const cfg = {
      ...base,
      brand: options.brand ?? 'CustomerPro Video',
      media: 'direct',
      // 'browser': the Export button asks the shell (parentOrigin), which applies preview/grant rules (D12).
      features: {render: options.parentOrigin ? 'browser' : false, events: true, svgImport: true},
      readOnly: !!options.readOnly,
      ...(options.parentOrigin ? {parentOrigin: options.parentOrigin} : {}),
    };
    const script = `window.DTLY = ${JSON.stringify(cfg)};`;
    const out = src.replace(CONFIG_RE, () => script).replace(/<title>[^<]*<\/title>/, `<title>${cfg.brand} Studio</title>`);
    const hash = crypto.createHash('sha256').update(script).digest('base64');
    return {out, hash};
  };

  // Changes to project.json from anyone (Studio saves, the director, other tools) → onProjectChanged.
  let lastHash = '';
  try { lastHash = projectHash(dir); } catch { /* empty */ }
  let debounce: NodeJS.Timeout | undefined;
  const watcher = fs.watch(dir, (_e, name) => {
    if (name !== 'project.json') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const h = projectHash(dir);
        if (h !== lastHash) { lastHash = h; opts.onProjectChanged?.({source: 'disk', hash: h}); }
      } catch { /* mid-write */ }
    }, 150);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const {out, hash} = await page();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // Studio needs blob: (exports), data: images and its own fonts; nothing remote.
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self' app://shell`,
        }).end(out);
        return;
      }
      const preq = http.request({hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers: {...req.headers, host: up.host}}, (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
        if (url.pathname === '/api/project' && req.method === 'PUT' && pres.statusCode === 200) {
          pres.on('end', () => {
            try { const h = projectHash(dir); if (h !== lastHash) { lastHash = h; opts.onProjectChanged?.({source: 'studio', hash: h}); } } catch { /* ignore */ }
          });
        }
      });
      preq.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(e.message); else res.end(); });
      res.on('close', () => { if (!res.writableEnded) preq.destroy(); }); // client went away (SSE, aborted Range reads)
      req.pipe(preq);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, {'Content-Type': 'text/plain'}).end((e as Error).message);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as {port: number}).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    dir: path.resolve(dir),
    setOptions: (o) => { options = {...options, ...o}; },
    close: () => { clearTimeout(debounce); watcher.close(); server.closeAllConnections?.(); server.close(); upstream.close(); upstream.server.closeAllConnections?.(); },
  };
};
