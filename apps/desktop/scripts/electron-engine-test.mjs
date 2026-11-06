// Runs the engine inside the real Electron runtime (utility process, and the child-process fallback):
// create a project, check Studio, render a watermarked 720p preview MP4 with DT.ly + skia-canvas.
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
let failed = 0;
for (const mode of ['utility', 'child']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cpv-selftest-${mode}-`));
  const out = path.join(tmp, 'result.json');
  const r = spawnSync(electron, ['.'], {cwd: root, stdio: 'inherit', timeout: 180000,
    env: {...process.env, CPV_SELFTEST: out, CPV_ENGINE: mode, CPV_PROJECTS_ROOT: path.join(tmp, 'projects'), CPV_USER_DATA: path.join(tmp, 'userData')}});
  const res = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {ok: false, steps: [{step: 'launch', ok: false, detail: r.error?.message ?? `exit ${r.status}`}]};
  const mp4 = res.steps?.find((s) => s.step === 'verifyMp4')?.detail?.out;
  const probe = mp4 ? execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'csv=p=0', mp4]).toString().trim() : 'none';
  console.log(`${mode}: ${res.ok ? 'PASS' : 'FAIL'} (electron ${res.electron}) ${res.steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'FAIL'}(${s.ms ?? 0}ms)`).join(' ')} → ${probe}`);
  if (!res.ok) { failed++; console.log(JSON.stringify(res.steps.filter((s) => !s.ok), null, 2)); }
}
process.exit(failed ? 1 : 0);
