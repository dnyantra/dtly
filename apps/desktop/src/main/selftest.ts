// CPV_SELFTEST=<out.json>: runs inside the real Electron runtime without windows. Starts the engine in its
// utility process, creates a project, renders a watermarked preview to MP4 with DT.ly + skia-canvas, checks
// Studio serves the branded page, collects diagnostics, and writes the results. Exit code 0 = pass.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {EngineHost} from './engine-host.js';

const get = (url: string) => new Promise<{status: number; body: string}>((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({status: res.statusCode ?? 0, body: b})); }).on('error', reject);
});

export const runSelfTest = async (o: {engine: EngineHost; out: string; diagnostics: () => Promise<unknown>}) => {
  const steps: {step: string; ok: boolean; ms: number; detail?: unknown}[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>) => {
    const t0 = Date.now();
    try { const r = await fn(); steps.push({step: name, ok: true, ms: Date.now() - t0, detail: r}); return r; } catch (e) { steps.push({step: name, ok: false, ms: Date.now() - t0, detail: (e as Error).message}); throw e; }
  };
  let ok = false;
  try {
    await step('ping', () => o.engine.call('ping', undefined as never, 20000));
    await step('info', () => o.engine.call('info', undefined as never, 20000));
    const proj = await step('createProject', async () => {
      // CPV_SELFTEST_SECONDS > 6 exercises DT.ly's parallel chunk workers.
      const duration = Number(process.env.CPV_SELFTEST_SECONDS) || 2;
      const p = {dtly: 1, name: 'Selftest', root: 'main', comps: [{id: 'main', width: 1080, height: 1920, fps: 30, duration, background: '#1d2b3a', layers: [
        {id: 'title', type: 'text', text: 'CustomerPro Video', size: 110, weight: 800, color: '#ffffff', align: 'center', transform: {position: [540, 900], scale: {keyframes: [{t: 0, v: [60, 60], ease: 'backOut'}, {t: 0.8, v: [100, 100]}]}}},
        {id: 'bar', type: 'shape', shape: 'rect', size: [700, 24], fill: '#e8692a', radius: 12, transform: {position: [540, 1040]}},
      ]}]};
      return o.engine.call('createProject', {name: `Selftest ${Date.now()}`, project: p});
    });
    const studio = await step('openProject+studio', async () => {
      const r = await o.engine.call('openProject', {dir: proj.dir, parentOrigin: 'app://shell'});
      const page = await get(r.studioUrl);
      if (page.status !== 200 || !page.body.includes('"brand":"CustomerPro Video"') || !page.body.includes('"media":"direct"')) throw new Error('Studio page lacks the embed config');
      const noToken = await get(`${r.studioUrl}api/project`);
      if (noToken.status !== 403) throw new Error(`API without token returned ${noToken.status}`);
      return {url: r.studioUrl, bytes: page.body.length};
    });
    const exp = await step('previewExport', () => new Promise<unknown>((resolve, reject) => {
      let id = '';
      const onExport = (e: {id: string; phase: string; out?: string; error?: string; done: number; total: number}) => {
        if (e.id !== id) return;
        if (e.phase === 'finished') { o.engine.off('export', onExport); resolve(e); }
        if (e.phase === 'error' || e.phase === 'cancelled') { o.engine.off('export', onExport); reject(new Error(e.error ?? e.phase)); }
      };
      o.engine.on('export', onExport);
      o.engine.call('startPreviewExport', {dir: proj.dir}).then((r) => { id = r.id; }, reject);
      setTimeout(() => reject(new Error('export timed out')), 120000);
    }));
    await step('verifyMp4', async () => {
      const out = (exp as {out: string}).out;
      const size = fs.statSync(out).size;
      if (size < 2000) throw new Error(`tiny file ${size}`);
      return {out, size};
    });
    // Final export (task 5.2) inside Electron: no watermark, ~8 Mbps H.264 + AAC, WhatsApp copy under 16 MB.
    await step('finalExport', () => new Promise<unknown>((resolve, reject) => {
      let id = '';
      const onExport = (e: {id: string; phase: string; error?: string; result?: {main: {size: number; width: number; height: number; bitrate: number; encoder?: string}; whatsapp?: {size: number}; seconds: number}}) => {
        if (e.id !== id || e.phase === 'render') return;
        o.engine.off('export', onExport);
        if (e.phase !== 'finished' || !e.result) return reject(new Error(e.error ?? e.phase));
        const {main, whatsapp, seconds} = e.result;
        if (main.width !== 1080 || main.height !== 1920) return reject(new Error(`size ${main.width}x${main.height}`));
        if (!whatsapp || whatsapp.size >= 16_000_000) return reject(new Error('no WhatsApp copy under 16 MB'));
        resolve({mainBytes: main.size, bitrate: main.bitrate, encoder: main.encoder, whatsappBytes: whatsapp.size, seconds});
      };
      o.engine.on('export', onExport);
      o.engine.call('startFinalExport', {dir: proj.dir, preset: 'reel', whatsapp: true}).then((r) => { id = r.id; }, reject);
      setTimeout(() => reject(new Error('final export timed out')), 180000);
    }));
    await step('closeProject', () => o.engine.call('closeProject', undefined as never));
    await step('diagnostics', async () => { const d = (await o.diagnostics()) as Record<string, unknown>; return {keys: Object.keys(d)}; });
    ok = true;
    void studio;
  } catch { /* recorded in steps */ }
  fs.mkdirSync(path.dirname(path.resolve(o.out)), {recursive: true});
  fs.writeFileSync(o.out, JSON.stringify({ok, engineMode: o.engine.mode, electron: process.versions.electron, steps}, null, 2));
  return ok ? 0 : 1;
};
