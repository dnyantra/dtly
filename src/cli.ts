#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installSkill, MCP_SETUP, setupGuide, skillTargets} from './agents.js';
import {listPresets, PRESETS} from './presets/index.js';
import {renderContactSheet, renderStill, renderVideo, renderVideoParallel} from './render/export.js';
import {editProject, writeProject} from './ops/store.js';
import {addSvg} from './ops/ops.js';
import {STARTERS} from './starter.js';
import {BRAND, VERSION} from './version.js';

const [cmd, ...rest] = process.argv.slice(2);
const usage = `${BRAND}  v${VERSION}
After Effects-style motion graphics as JSON, rendered to MP4.

  dtly init <project.json> [--starter opener|kinetic|bars] [--title "Text"]
  dtly render <project.json> <out.mp4> [--from s] [--to s] [--comp id] [--workers n]
  dtly still  <project.json> <time> <out.png> [--scale 0.5] [--comp id]
  dtly sheet  <project.json> <out.png> <t1,t2,...> [--comp id]
  dtly import-svg <project.json> <file.svg> [--width 600] [--at x,y] [--name logo] [--color #hex] [--comp id]
                               add an SVG as editable shape layers
  dtly captions <project.json> <audio|video|.srt|.vtt|.json> [--lang mr-IN] [--words 4] [--y px] [--highlight #hex] [--offset s] [--uppercase]
                               word-highlight captions (audio/video is transcribed with Sarvam; needs SARVAM_API_KEY)
  dtly map-tiles <out.png> --tiles <url with {z}/{x}/{y}> (--route "lat,lon;lat,lon" | --bounds latN,lonW,latS,lonE) [--size 1080x1920] [--attribution "© OpenStreetMap"]
                               stitch a map background for map.route (you choose the provider and its licence)
  dtly presets                 list text animators, openers, slides, transitions, charts, captions, maps
  dtly studio <project.json> [--port 4400] [--no-open]   browser preview + timeline editor
  dtly mcp                     run the MCP server (stdio) for AI agents
  dtly setup <agent>           how to add DT.ly to claude, codex, cursor, gemini, copilot, windsurf
  dtly skill install [--agent claude|codex|cursor|gemini|copilot|all] [--project] [--dir d]
                               install the "moti" agent skill (default: all)

Docs: https://github.com/dnyantra/dtly`;
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const num = (s?: string) => (s === undefined ? undefined : Number(s));
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (cmd === 'render' && rest[1]) {
    const t0 = Date.now();
    const r = await renderVideoParallel(rest[0], rest[1], {
      from: num(flag('from')), to: num(flag('to')), comp: flag('comp'), workers: num(flag('workers')),
      onProgress: (d, n) => { if (d % 30 === 0 || d === n) process.stderr.write(`\r${d}/${n} frames`); },
    });
    console.error(`\nRendered ${r.out}: ${r.frames} frames, ${r.audioTracks} audio tracks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else if (cmd === 'chunk') {
    // Internal: one parallel-render worker. Reports progress to the parent over IPC.
    const [project, out, from, to, comp, crf] = rest;
    await renderVideo(project, out, {from: Number(from), to: Number(to), comp: comp || undefined, crf: Number(crf), audio: false, onProgress: (d) => process.send?.({done: d})});
  } else if (cmd === 'still' && rest[2]) {
    console.log(await renderStill(rest[0], Number(rest[1]), rest[2], {scale: num(flag('scale')), comp: flag('comp')}));
  } else if (cmd === 'sheet' && rest[2]) {
    console.log(await renderContactSheet(rest[0], rest[2].split(',').map(Number), rest[1], {comp: flag('comp')}));
  } else if (cmd === 'init' && rest[0]) {
    const name = flag('starter') ?? 'opener';
    const starter = STARTERS[name];
    if (!starter) throw new Error(`Unknown starter "${name}". Options: ${Object.keys(STARTERS).join(', ')}`);
    if (fs.existsSync(rest[0])) throw new Error(`${rest[0]} already exists`);
    writeProject(rest[0], starter.build(flag('title') ?? 'DT.ly'));
    console.log(`Created ${rest[0]} (${starter.description})\nNext: dtly render ${rest[0]} ${rest[0].replace(/\.json$/, '')}.mp4`);
  } else if (cmd === 'import-svg' && rest[1]) {
    const at = flag('at')?.split(',').map(Number) as [number, number] | undefined;
    const r = editProject(rest[0], (p) => addSvg(p, flag('comp'), fs.readFileSync(rest[1], 'utf8'), {name: flag('name') ?? path.basename(rest[1], '.svg'), width: num(flag('width')), position: at, color: flag('color')}));
    console.log(`Added "${r.group}" with ${r.parts} shape layers (${Math.round(r.size[0])}×${Math.round(r.size[1])} px). Animate the group layer, or each part.`);
  } else if (cmd === 'captions' && rest[1]) {
    const {loadCaptions} = await import('./render/transcribe.js');
    const src = await loadCaptions(rest[1], flag('lang'));
    const y = num(flag('y'));
    const r = editProject(rest[0], (p) => PRESETS['captions.add'].apply(p, flag('comp'), {...src, maxWords: num(flag('words')), highlight: flag('highlight'), offset: num(flag('offset')), uppercase: rest.includes('--uppercase'), ...(y ? {position: [p.comps.find((c) => c.id === (flag('comp') ?? p.root))!.width / 2, y]} : {})}));
    console.log(`Added ${r.created.length} caption layers. ${r.note ?? ''}`);
  } else if (cmd === 'map-tiles' && rest[0]) {
    const {stitchMap} = await import('./render/tiles.js');
    const tiles = flag('tiles');
    if (!tiles) throw new Error('--tiles <url template> is required, e.g. https://api.maptiler.com/maps/streets/256/{z}/{x}/{y}.png?key=KEY');
    const [w, h] = (flag('size') ?? '1080x1920').split('x').map(Number);
    const route = flag('route')?.split(';').map((p) => p.split(',').map(Number) as [number, number]);
    const b = flag('bounds')?.split(',').map(Number);
    const view = await stitchMap(rest[0], {tiles, route, bounds: b ? [[b[0], b[1]], [b[2], b[3]]] : undefined, size: [w, h], attribution: flag('attribution')});
    console.log(`Saved ${rest[0]} (+ ${rest[0]}.json with bounds ${JSON.stringify(view.bounds)}). Use it as map.route's background: {src, bounds}.`);
  } else if (cmd === 'presets') {
    console.log(listPresets());
  } else if (cmd === 'studio' && rest[0]) {
    const {startStudio} = await import('./studio/server.js');
    const {url} = await startStudio({project: rest[0], port: num(flag('port'))});
    console.log(`${BRAND}\nStudio for ${rest[0]} → ${url}\nEdits save to the file; changes made by agents or other tools appear live. Ctrl+C to stop.`);
    if (!rest.includes('--no-open')) {
      const {spawn} = await import('node:child_process');
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [url], {stdio: 'ignore', detached: true}).unref();
    }
  } else if (cmd === 'mcp') {
    const {startMcpServer} = await import('./mcp/server.js');
    await startMcpServer();
  } else if (cmd === 'skill' && rest[0] === 'install') {
    const dirs = flag('dir') ? [flag('dir')!] : skillTargets(flag('agent') ?? 'all', rest.includes('--project'));
    for (const dest of installSkill(pkgRoot, dirs)) console.log(`Installed the moti skill to ${dest}`);
    console.log(`Next, add the MCP server to your agent: dtly setup <claude|codex|cursor|gemini|copilot|windsurf>`);
  } else if (cmd === 'setup') {
    if (!rest[0]) throw new Error(`Which agent? dtly setup <${Object.keys(MCP_SETUP).join('|')}>`);
    console.log(setupGuide(rest[0]));
  } else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION);
  } else {
    console.log(usage);
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
  }
} catch (e) {
  console.error(`dtly: ${(e as Error).message}`);
  process.exit(1);
}
