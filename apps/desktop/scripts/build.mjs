// Bundles main (ESM), preload (CJS, sandboxed), engine + render child (ESM, utility process) and the shell UI.
// DT.ly, electron and skia-canvas stay external (loaded from node_modules at runtime).
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
fs.rmSync(out, {recursive: true, force: true});
const common = {bundle: true, sourcemap: true, logLevel: 'warning', absWorkingDir: root};
const node = {...common, platform: 'node', target: 'node20', format: 'esm', external: ['electron', '@dnyantra/dtly', '@dnyantra/dtly/*', 'skia-canvas',
  // pdfjs (director doc_pages) resolves its worker/fonts from its package folder; its Node canvas is native.
  'pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
  banner: {js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url);"}};

await Promise.all([
  // Release config baked into main (RELEASING.md): the update feed (R2) and the crash-report submit URL.
  // Both may be empty: then auto-update and crash reporting are off. electron-updater is bundled here.
  build({...node, entryPoints: {'main/main': 'src/main/main.ts'}, outdir: out, splitting: true, chunkNames: 'main/chunks/[name]-[hash]',
    define: {__CPV_UPDATE_URL__: JSON.stringify(process.env.CPV_UPDATE_URL ?? ''), __CPV_CRASH_URL__: JSON.stringify(process.env.CPV_CRASH_URL ?? '')}}),
  build({...node, entryPoints: {'engine/index': 'src/engine/index.ts', 'engine/render-child': 'src/engine/render-child.ts'}, outdir: out}),
  build({...node, entryPoints: {'mock-server': 'test/mock/customerpro-mock.ts'}, outdir: out}),
  build({...common, platform: 'node', target: 'node20', format: 'cjs', entryPoints: {'preload/preload': 'src/preload/preload.ts'}, outdir: out, outExtension: {'.js': '.cjs'}, external: ['electron']}),
  build({...common, platform: 'browser', target: 'chrome130', format: 'esm', entryPoints: {app: 'src/renderer/main.tsx'}, outdir: path.join(out, 'renderer'),
    jsx: 'automatic', jsxImportSource: 'preact', loader: {'.css': 'css'}}),
]);
fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
console.log('built dist/');
