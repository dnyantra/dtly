// Loads DT.ly (the "@dnyantra/dtly" dependency) at runtime. DT.ly's dist/ can briefly disappear while it is
// being rebuilt in development, so imports retry for a while before giving up.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

type DtlyNode = typeof import('@dnyantra/dtly/node');
type DtlyCore = typeof import('@dnyantra/dtly');

export interface StudioHandle { url: string; close: () => void; server: import('node:http').Server }
// DT.ly's startStudio (src/studio/server.ts). Not in the package exports yet, so typed here.
type StartStudio = (o: {project: string; port?: number; host?: string; onReady?: (url: string) => void}) => Promise<StudioHandle>;

const require = createRequire(import.meta.url);

export const dtlyRoot = () => {
  if (process.env.CPV_DTLY_ROOT) return process.env.CPV_DTLY_ROOT;
  const dir = path.dirname(require.resolve('@dnyantra/dtly/package.json'));
  // Packaged: DT.ly is asarUnpack'ed. Import it from app.asar.unpacked so the paths it derives from
  // import.meta.url (fonts, studio-app, its CLI for render chunks) are real files that native code
  // (skia-canvas) and ffmpeg can open.
  const unpacked = dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return unpacked !== dir && fs.existsSync(unpacked) ? unpacked : dir;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retry = async <T>(what: string, fn: () => Promise<T>, waitMs = 30000): Promise<T> => {
  const until = Date.now() + waitMs;
  for (;;) {
    try { return await fn(); } catch (e) {
      const code = (e as {code?: string}).code;
      const transient = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ENOENT' || /Cannot find module|not found/i.test((e as Error).message);
      if (!transient || Date.now() > until) throw new Error(`Could not load DT.ly ${what}: ${(e as Error).message}`);
      await sleep(500);
    }
  }
};

const file = (rel: string) => pathToFileURL(path.join(dtlyRoot(), rel)).href;
const need = (rel: string) => { if (!fs.existsSync(path.join(dtlyRoot(), rel))) throw Object.assign(new Error(`${rel} not found`), {code: 'ENOENT'}); };

let nodeMod: Promise<DtlyNode> | undefined;
let coreMod: Promise<DtlyCore> | undefined;
let studioMod: Promise<{startStudio: StartStudio}> | undefined;

export const dtlyNode = () => (nodeMod ??= retry('node', async () => { need('dist/node.js'); return (await import(file('dist/node.js'))) as DtlyNode; }).catch((e) => { nodeMod = undefined; throw e; }));
export const dtlyCore = () => (coreMod ??= retry('core', async () => { need('dist/index.js'); return (await import(file('dist/index.js'))) as DtlyCore; }).catch((e) => { coreMod = undefined; throw e; }));
export const dtlyStudio = () => (studioMod ??= retry('studio', async () => {
  need('dist/studio/server.js');
  need('dist/studio-app/index.html');
  return (await import(file('dist/studio/server.js'))) as {startStudio: StartStudio};
}).catch((e) => { studioMod = undefined; throw e; }));

export const dtlyVersion = () => {
  try { return (JSON.parse(fs.readFileSync(path.join(dtlyRoot(), 'package.json'), 'utf8')) as {version: string}).version; } catch { return 'unknown'; }
};
