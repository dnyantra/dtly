// PDF pages → PNG for doc_pages and pass-1 analysis (brochures, price lists). pdfjs-dist (Apache-2.0) renders
// with its Node canvas (@napi-rs/canvas, MIT, Node-API). Loaded lazily and kept external to the bundle
// (pdfjs resolves its worker and font data from its own package folder).
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);

// Electron 45 runs Node 24; these polyfills only matter for tests on older Node.
const polyfill = () => {
  const P = Promise as unknown as {withResolvers?: unknown};
  if (!P.withResolvers) P.withResolvers = function withResolvers<T>(this: PromiseConstructor) { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new this<T>((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
  const AB = ArrayBuffer.prototype as unknown as {transferToFixedLength?: unknown; transfer?: unknown};
  const copy = function (this: ArrayBuffer, n?: number) { const len = n ?? this.byteLength; const b = new ArrayBuffer(len); new Uint8Array(b).set(new Uint8Array(this, 0, Math.min(len, this.byteLength))); return b; };
  if (!AB.transferToFixedLength) AB.transferToFixedLength = copy;
  if (!AB.transfer) AB.transfer = copy;
};

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let mod: Promise<Pdfjs> | undefined;
const pdfjs = () => {
  polyfill();
  const main = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  return (mod ??= import(pathToFileURL(main).href) as Promise<Pdfjs>);
};
const pkgDir = () => path.dirname(require.resolve('pdfjs-dist/package.json'));

export const pdfPageCount = async (file: string) => {
  const lib = await pdfjs();
  const task = lib.getDocument({data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, standardFontDataUrl: `${path.join(pkgDir(), 'standard_fonts')}${path.sep}`});
  try { return (await task.promise).numPages; } finally { await task.destroy(); }
};

// Renders the given 1-based pages at about `width` px wide. Returns PNG buffers in page order.
export const renderPdfPages = async (file: string, pages: number[], width = 1024) => {
  const lib = await pdfjs();
  const task = lib.getDocument({data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true,
    standardFontDataUrl: `${path.join(pkgDir(), 'standard_fonts')}${path.sep}`, cMapUrl: `${path.join(pkgDir(), 'cmaps')}${path.sep}`, cMapPacked: true});
  try {
    const doc = await task.promise;
    const out: {page: number; png: Buffer; width: number; height: number}[] = [];
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) throw new Error(`Page ${n} does not exist (the PDF has ${doc.numPages})`);
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({scale: 1});
      const vp = page.getViewport({scale: Math.min(4, width / vp1.width)});
      const factory = (doc as unknown as {canvasFactory: {create: (w: number, h: number) => {canvas: {toBuffer: (t: string) => Buffer}; context: unknown}}}).canvasFactory;
      const cc = factory.create(Math.round(vp.width), Math.round(vp.height));
      await page.render({canvasContext: cc.context, viewport: vp, canvas: cc.canvas} as never).promise;
      out.push({page: n, png: cc.canvas.toBuffer('image/png'), width: Math.round(vp.width), height: Math.round(vp.height)});
      page.cleanup();
    }
    return {pages: out, total: doc.numPages};
  } finally { await task.destroy(); }
};
