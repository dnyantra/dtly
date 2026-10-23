#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {listPresets} from './presets/index.js';
import {renderContactSheet, renderStill, renderVideo, renderVideoParallel} from './render/export.js';
import {writeProject} from './ops/store.js';
import {STARTERS} from './starter.js';
import {BRAND, VERSION} from './version.js';

const [cmd, ...rest] = process.argv.slice(2);
const usage = `${BRAND}  v${VERSION}
After Effects-style motion graphics as JSON, rendered to MP4.

  dtly init <project.json> [--starter opener|kinetic|bars] [--title "Text"]
  dtly render <project.json> <out.mp4> [--from s] [--to s] [--comp id] [--workers n]
  dtly still  <project.json> <time> <out.png> [--scale 0.5] [--comp id]
  dtly sheet  <project.json> <out.png> <t1,t2,...> [--comp id]
  dtly presets                 list text animators, openers, slides, transitions
  dtly studio <project.json> [--port 4400] [--no-open]   browser preview + timeline editor
  dtly mcp                     run the MCP server (stdio) for AI agents
  dtly skill install [--dir d] copy the agent skill into ~/.claude/skills

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
    const base = flag('dir') ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'skills');
    const dest = path.join(base, 'dtly');
    fs.mkdirSync(dest, {recursive: true});
    fs.cpSync(path.join(pkgRoot, 'plugin/skills/dtly'), dest, {recursive: true});
    console.log(`Installed the DT.ly skill to ${dest}`);
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
