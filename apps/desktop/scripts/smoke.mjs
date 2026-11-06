// Windowed smoke test: mock CustomerPro (auto-approve) → launch the app → sign in → home → new project with
// Studio framed → screenshots in ./smoke-out. Needs a desktop session (not headless CI without a display).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {createMockServer} = await import(pathToFileURL(path.join(root, 'dist/mock-server.js')).href);
const mock = await createMockServer({autoApproveAfterPolls: 1});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpv-smoke-'));
const outDir = path.join(root, 'smoke-out');
fs.mkdirSync(outDir, {recursive: true});
// --app <path to the packaged executable> smoke-tests a build instead of the dev tree.
const appArg = process.argv.indexOf('--app');
const electron = appArg > 0 ? process.argv[appArg + 1] : path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
// Async spawn: the mock server lives in this process and must keep answering.
const child = spawn(electron, appArg > 0 ? [] : ['.'], {cwd: root, stdio: 'inherit',
  env: {...process.env, CPV_SMOKE: path.join(outDir, 'smoke'), CUSTOMERPRO_URL: mock.url, CPV_PROJECTS_ROOT: path.join(tmp, 'projects'), CPV_USER_DATA: path.join(tmp, 'userData')}});
const kill = setTimeout(() => child.kill(), 180000);
const r = await new Promise((res) => child.on('exit', (status) => res({status})));
clearTimeout(kill);
await mock.close();
const report = JSON.parse(fs.readFileSync(path.join(outDir, 'smoke.json'), 'utf8'));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok && r.status === 0 ? 0 : 1);
