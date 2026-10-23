// Bundles the Studio browser app (Preact + the shared renderer) into dist/studio-app.
import {build} from 'esbuild';
import fs from 'node:fs';

const outdir = 'dist/studio-app';
fs.mkdirSync(outdir, {recursive: true});
await build({
  entryPoints: {app: 'src/studio/app/main.tsx'},
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outdir,
  logLevel: 'warning',
});
fs.copyFileSync('src/studio/app/index.html', `${outdir}/index.html`);
console.log(`Studio bundle → ${outdir}`);
