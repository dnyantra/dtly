// Drives DT.ly Studio in a real Chrome: loads, selects, drags a keyframe and a layer bar,
// picks up an external (agent) edit, undoes, plays. Run: npm run test:studio [-- <project.json> <shotsDir>]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {readProject, writeProject} from '../src/node.js';
import {setKeyframe, updateLayer} from '../src/index.js';
import {STARTERS} from '../src/starter.js';
import {startStudio} from '../src/studio/server.js';

const CHROME = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('Chrome not found; set CHROME_PATH. Skipping studio test.'); process.exit(0); }

let [file, shots] = process.argv.slice(2);
if (!file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-studio-'));
  file = path.join(dir, 'project.json');
  const p = STARTERS.opener.build('Studio');
  p.comps[0].layers.unshift({id: 'cap', type: 'text', text: 'नमस्कार Studio', size: 90, inPoint: 1, transform: {position: [540, 1350]}});
  writeProject(file, p);
  setKeyframe(p, 'cap', 'transform.position', 1, [540, 1350], 'expoOut');
  setKeyframe(p, 'cap', 'transform.position', 2, [540, 1250]);
  writeProject(file, p);
}
shots ??= path.dirname(file);
const step = (s: string) => console.log(`✓ ${s}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, what: string, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`); await wait(50); }
};

const studio = await startStudio({project: file, port: 0});
const browser = await puppeteer.launch({executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1500,950']});
const errors: string[] = [];
try {
  const page = await browser.newPage();
  await page.setViewport({width: 1500, height: 950});
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(studio.url);
  await page.waitForSelector('.layer-row');
  assert.equal(await page.title(), `${path.basename(file)} — DT.ly Studio`);
  assert.equal(await page.$eval('.brand b', (el) => el.textContent), 'DT.ly');
  await page.waitForFunction(() => (document.querySelector('canvas.frame') as HTMLCanvasElement)?.dataset.time === '0', {timeout: 10000});
  await page.screenshot({path: path.join(shots, 'studio-1-loaded.png')});
  step(`loaded ${studio.url}`);

  // Select the caption layer from the timeline; inspector shows its transform.
  const rows = await page.$$('.layer-row .tl-label');
  const names = await Promise.all(rows.map((r) => r.evaluate((el) => el.querySelector('.name')?.getAttribute('title'))));
  await rows[names.indexOf('cap')].click();
  await page.waitForSelector('.inspector .section');
  assert.ok(await page.$eval('.inspector', (el) => el.textContent?.includes('Position')));
  step('select layer → inspector');

  // Expand it and drag its first position keyframe 0.5 s later.
  const group = (await page.$$('.tl-group'))[names.indexOf('cap')];
  await (await group.$('.twirl'))!.click();
  await page.waitForSelector('.prop-row .key');
  const key = (await group.$$('.prop-row .key'))[0];
  const kb = (await key.boundingBox())!;
  const zoom = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.tick')].slice(0, 2).map((el) => parseFloat((el as HTMLElement).style.left));
    const labels = [...document.querySelectorAll('.tick span')].slice(0, 2).map((el) => parseFloat(el.textContent!));
    return (t[1] - t[0]) / (labels[1] - labels[0]);
  });
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2 + zoom * 0.25, kb.y + kb.height / 2, {steps: 5});
  await page.mouse.move(kb.x + kb.width / 2 + zoom * 0.5, kb.y + kb.height / 2, {steps: 5});
  await page.mouse.up();
  await until(() => (readProject(file).comps[0].layers.find((l) => l.id === 'cap')!.transform!.position as {keyframes: {t: number}[]}).keyframes[0].t === 1.5, 'keyframe saved at 1.5s');
  step('drag keyframe 1s → 1.5s (saved to disk)');

  // Drag the caption bar 1 s later: in-point and both keyframes move together.
  const bar = (await group.$('.bar'))!;
  const bb = (await bar.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + zoom * 1, bb.y + bb.height / 2, {steps: 8});
  await page.mouse.up();
  await until(() => readProject(file).comps[0].layers.find((l) => l.id === 'cap')!.inPoint === 2, 'layer moved to 2s');
  const kfs = (readProject(file).comps[0].layers.find((l) => l.id === 'cap')!.transform!.position as {keyframes: {t: number}[]}).keyframes.map((k) => k.t);
  assert.deepEqual(kfs, [2.5, 3]);
  step('drag layer bar +1s (in-point and keyframes shifted)');

  // Scrub the playhead and edit a property with the inspector (stopwatch on → keyframe at playhead).
  const ruler = (await page.$('.tl-ruler'))!;
  const rb = (await ruler.boundingBox())!;
  await page.mouse.click(rb.x + zoom * 2.5, rb.y + 10);
  await page.waitForFunction(() => (document.querySelector('canvas.frame') as HTMLCanvasElement)?.dataset.time === '2.5', {timeout: 8000});
  await page.screenshot({path: path.join(shots, 'studio-2-edited.png')});
  step('scrub to 2.5s');

  // Undo twice → back to the original timing.
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  await until(() => readProject(file).comps[0].layers.find((l) => l.id === 'cap')!.inPoint === 1, 'undo restored in-point');
  step('undo ×2 (saved)');

  // An agent edits the file on disk → the studio reloads it live.
  await wait(500);
  const p = readProject(file);
  updateLayer(p, 'cap', {text: 'Edited by an agent'});
  writeProject(file, p);
  await page.waitForFunction(() => document.querySelector('.timeline')?.textContent?.includes('Edited by an agent'), {timeout: 5000});
  step('live reload of external edit');

  // Play for a moment: time advances, no errors.
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await wait(1200);
  await page.keyboard.press('Space');
  const tc = await page.$eval('.timecode', (el) => el.textContent);
  await wait(800);
  assert.notEqual(tc, '00:00:00');
  await page.screenshot({path: path.join(shots, 'studio-3-played.png')});
  step(`playback (stopped at ${tc})`);

  // Render MP4 from the studio: progress streams in, then a link to the file appears.
  await page.click('button.primary');
  await page.waitForFunction(() => document.querySelector('.status a')?.textContent?.includes('.mp4'), {timeout: 120000});
  const out = path.join(path.dirname(file), `${path.basename(file, '.json')}.mp4`);
  assert.ok(fs.statSync(out).size > 10000);
  step(`render from studio → ${path.basename(out)}`);

  // Embedding: a host overrides window.DTLY (brand, read-only, no render) and gets the token back.
  const embed = await startStudio({project: file, port: 0, config: {brand: 'CustomerPro Video', readOnly: true, features: {render: false, events: true, svgImport: false}, media: 'direct', saveDebounceMs: 100}});
  try {
    assert.match(embed.token, /^[0-9a-f]{32}$/);
    assert.equal(embed.url, `http://127.0.0.1:${embed.port}/`);
    assert.equal((await fetch(`${embed.url}api/project`)).status, 403);
    const got = await fetch(`${embed.url}api/project`, {headers: {'x-dtly-token': embed.token}});
    assert.equal(got.status, 200);
    const {rev, project} = await got.json() as {rev: number; project: unknown};
    assert.equal((await fetch(`${embed.url}api/project`, {method: 'PUT', headers: {'x-dtly-token': embed.token}, body: JSON.stringify({rev, project})})).status, 403, 'read-only rejects saves');
    assert.equal((await fetch(`${embed.url}api/render?token=${embed.token}`, {method: 'POST', body: '{}'})).status, 403, 'render: false rejects renders');
    const p2 = await browser.newPage();
    p2.on('pageerror', (e) => errors.push(String(e)));
    await p2.goto(embed.url);
    await p2.waitForSelector('.layer-row');
    assert.equal(await p2.title(), `${path.basename(file)} — CustomerPro Video Studio`);
    assert.equal(await p2.$eval('.brand b', (el) => el.textContent), 'CustomerPro Video');
    const cfg = await p2.evaluate(() => (window as unknown as {DTLY: Record<string, unknown>}).DTLY);
    assert.deepEqual({brand: cfg.brand, readOnly: cfg.readOnly, media: cfg.media, saveDebounceMs: cfg.saveDebounceMs, token: cfg.token}, {brand: 'CustomerPro Video', readOnly: true, media: 'direct', saveDebounceMs: 100, token: embed.token});
    await p2.screenshot({path: path.join(shots, 'studio-4-embedded.png')});
    await p2.close();
  } finally { embed.close(); }
  // Brand text is escaped in the title and in the inline config script.
  const odd = await startStudio({project: file, port: 0, config: {brand: 'A</script><b>&'}});
  try {
    const html = await (await fetch(odd.url)).text();
    assert.ok(html.includes('<title>A&lt;/script&gt;&lt;b&gt;&amp; Studio</title>') && !html.includes('A</script>'), html.slice(0, 600));
  } finally { odd.close(); }
  step('startStudio({config}): brand in header + title, readOnly/render enforced, {url, port, token, close}');

  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
  step('no browser errors');
} finally {
  await browser.close();
  studio.close();
}
console.log(`Studio test passed. Screenshots in ${shots}`);
