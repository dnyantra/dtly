// Builds dist/ once (the preview-export test forks dist/engine/render-child.js).
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export default () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], {cwd: root, stdio: 'inherit'});
};
