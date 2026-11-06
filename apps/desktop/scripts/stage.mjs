// Stages a clean app folder for electron-builder (build/stage): dist/, a package.json, and production
// node_modules with DT.ly installed from a packed tarball (the dev dependency is a file:../.. symlink to the
// whole repo, which must not be packaged). Usage: node scripts/stage.mjs [--platform win32 --arch x64]
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const platform = opt('--platform', process.platform), arch = opt('--arch', process.arch);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const stage = path.join(root, 'build', 'stage');
const vendor = path.join(root, 'build', 'vendor');
fs.rmSync(stage, {recursive: true, force: true});
fs.mkdirSync(vendor, {recursive: true});
if (!fs.existsSync(path.join(repo, 'dist', 'studio-app', 'index.html'))) throw new Error('DT.ly dist/ is missing: run `npm run build` in the repo root');

// DT.ly as a tarball (its "files": dist, fonts, …), without running its prepare/build.
for (const f of fs.readdirSync(vendor)) fs.rmSync(path.join(vendor, f));
const packed = execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', vendor], {cwd: repo}).toString().trim().split('\n').pop();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(stage, {recursive: true});
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license,
  type: 'module', main: pkg.main, dependencies: {'@dnyantra/dtly': `file:${path.join(vendor, packed)}`},
}, null, 2));
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), {recursive: true, filter: (s) => !/mock-server|\.map$/.test(s)});
// Production deps for the target platform (skia-canvas ships its native binary as an optional per-OS package).
execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], {cwd: stage, stdio: 'inherit'});
// Drop DT.ly's MCP server bits we never load? (kept: the director will use @dnyantra/dtly/tools.)
console.log(`staged ${path.relative(root, stage)} for ${platform}-${arch} with ${packed}`);
