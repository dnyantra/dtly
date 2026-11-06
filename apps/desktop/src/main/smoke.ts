// CPV_SMOKE=<out-prefix>: launches the real window, signs in (against CUSTOMERPRO_URL, e.g. the mock server
// with auto-approve), screenshots home, opens a new project with Studio framed, screenshots it, and exits.
import fs from 'node:fs';
import type {BrowserWindow} from 'electron';
import type {AccountManager} from './account.js';
import type {EngineHost} from './engine-host.js';
import type {Events} from '../shared/bridge.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const runSmoke = async (o: {win: BrowserWindow; out: string; engine: EngineHost; account: AccountManager; addRecent: (d: string) => void; send: <E extends keyof Events>(e: E, d: Events[E]) => void}) => {
  const report: Record<string, unknown> = {};
  const waitFor = async (js: string, ms = 30000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await o.win.webContents.executeJavaScript(js).catch(() => false)) return true;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${js}`);
  };
  const shot = async (name: string) => {
    const img = await o.win.webContents.capturePage();
    const file = `${o.out}-${name}.png`;
    fs.writeFileSync(file, img.toPNG());
    report[`screenshot_${name}`] = file;
  };
  try {
    await new Promise<void>((r) => { if (o.win.webContents.isLoading()) o.win.webContents.once('did-finish-load', () => r()); else r(); });
    await waitFor('!!document.body.dataset.view');
    report.firstView = await o.win.webContents.executeJavaScript('document.body.dataset.view');
    if (!o.account.state().signedIn) {
      await shot('signin');
      await o.account.startSignIn(() => undefined);
    }
    report.access = o.account.state().access;
    await waitFor(`document.body.dataset.view === 'home'`);
    await sleep(500);
    await shot('home');
    const p = await o.engine.call('createProject', {name: `Smoke ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`});
    o.addRecent(p.dir);
    o.send('open', {dir: p.dir});
    await waitFor(`document.body.dataset.view === 'project' && document.body.dataset.studio === 'loaded'`, 45000);
    await sleep(2500); // let Studio paint its first frame
    await shot('project');
    report.bridgeIsolated = await o.win.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined' && typeof window.cpv?.invoke === 'function'`);
    // Final export confirm dialog (task 5.2): says free / credits before anything is charged.
    await waitFor(`!!document.querySelector('[data-testid=final-export]') && !document.querySelector('[data-testid=final-export]').disabled`);
    await o.win.webContents.executeJavaScript(`document.querySelector('[data-testid=final-export]').click()`);
    await waitFor(`!!document.querySelector('[data-testid=export-confirm]')`);
    await sleep(300);
    await shot('export-confirm');
    report.exportConfirm = await o.win.webContents.executeJavaScript(`document.querySelector('[data-testid=export-confirm]').innerText`);
    await o.win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid=export-confirm] button')].find((b) => b.textContent === 'Cancel').click()`);
    // Confirm for real: link → grant → render → upload → "In your Media Library" with Post / Send on WhatsApp.
    await o.win.webContents.executeJavaScript(`document.querySelector('[data-testid=final-export]').click()`);
    await waitFor(`!!document.querySelector('[data-testid=export-confirm]')`);
    await o.win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-testid=export-confirm] button')].find((b) => b.textContent === 'Export').click()`);
    await waitFor(`!!document.querySelector('.published') || /error-text/.test(document.querySelector('.final-export')?.innerHTML ?? '')`, 180000);
    await sleep(300);
    await shot('published');
    report.published = await o.win.webContents.executeJavaScript(`document.querySelector('.final-export').innerText`);
    report.ok = report.bridgeIsolated === true && /Free: uses 1 of your 20 videos/.test(String(report.exportConfirm)) && /In your Media Library/.test(String(report.published));
  } catch (e) {
    report.ok = false;
    report.error = (e as Error).message;
    try { await shot('failure'); } catch { /* window gone */ }
  }
  fs.writeFileSync(`${o.out}.json`, JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
};
