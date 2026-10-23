// Stitches slippy-map tiles into one background image with known bounds, for map.route.
// You choose the tile provider (and its licence/attribution); nothing is fetched by default.
import fs from 'node:fs';
import {loadImage} from 'skia-canvas';
import {fitView, project, type LatLon, type MapView} from '../core/geo.js';
import {newCanvas} from './node-host.js';

export interface TileOptions { tiles: string; route?: LatLon[]; bounds?: [LatLon, LatLon]; size: [number, number]; attribution?: string; maxZoom?: number; userAgent?: string }

export const stitchMap = async (out: string, o: TileOptions): Promise<MapView> => {
  const [W, H] = o.size;
  const view: MapView = o.bounds ? {bounds: o.bounds, size: [W, H]} : fitView(o.route ?? [], W, H, 0.12).view;
  const [a, b] = [project(view.bounds[0], 0), project(view.bounds[1], 0)];
  // Smallest zoom whose tiles are at least as sharp as the output.
  const z = Math.min(o.maxZoom ?? 18, Math.max(0, Math.ceil(Math.log2(W / Math.max(1e-9, b[0] - a[0])))));
  const k = 2 ** z;
  const tx0 = Math.floor((a[0] * k) / 256), tx1 = Math.floor((b[0] * k) / 256), ty0 = Math.floor((a[1] * k) / 256), ty1 = Math.floor((b[1] * k) / 256);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 400) throw new Error('Too many tiles; use a smaller area or size');
  const canvas = newCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dfe3e6';
  ctx.fillRect(0, 0, W, H);
  const sx = W / ((b[0] - a[0]) * k), sy = H / ((b[1] - a[1]) * k);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const url = o.tiles.replace('{z}', String(z)).replace('{x}', String(((tx % k) + k) % k)).replace('{y}', String(ty)).replace('{s}', 'abc'[(tx + ty) % 3]);
    const res = await fetch(url, {headers: {'User-Agent': o.userAgent ?? 'DT.ly map-tiles (https://github.com/dnyantra/dtly)'}});
    if (!res.ok) throw new Error(`Tile ${url} → HTTP ${res.status}`);
    const img = await loadImage(Buffer.from(await res.arrayBuffer()));
    ctx.drawImage(img, (tx * 256 - a[0] * k) * sx, (ty * 256 - a[1] * k) * sy, 256 * sx + 0.5, 256 * sy + 0.5);
  }
  if (o.attribution) {
    ctx.font = `600 ${Math.round(W / 60)}px sans-serif`;
    const tw = ctx.measureText(o.attribution).width, pad = W / 120;
    ctx.fillStyle = '#ffffffcc';
    ctx.fillRect(W - tw - pad * 3, H - W / 60 - pad * 3, tw + pad * 3, W / 60 + pad * 3);
    ctx.fillStyle = '#333';
    ctx.fillText(o.attribution, W - tw - pad * 1.5, H - pad * 1.8);
  }
  await canvas.toFile(out);
  fs.writeFileSync(`${out}.json`, JSON.stringify({src: out, bounds: view.bounds, size: [W, H], zoom: z, attribution: o.attribution ?? null}, null, 2));
  return view;
};
