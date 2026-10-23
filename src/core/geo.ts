// Web Mercator helpers for map routes and tile backgrounds.
export type LatLon = [number, number];

// Lat/lon → world pixel coordinates at zoom level z (256 px tiles).
export const project = ([lat, lon]: LatLon, z = 0): [number, number] => {
  const s = 256 * 2 ** z;
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
};

export const unproject = ([x, y]: [number, number], z = 0): LatLon => {
  const s = 256 * 2 ** z;
  const lon = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon];
};

export interface MapView { bounds: [LatLon, LatLon]; size: [number, number] } // NW corner, SE corner

// Fits coordinates into a w×h box with padding, keeping Mercator proportions.
export const fitView = (pts: LatLon[], w: number, h: number, pad = 0.12): {toPx: (p: LatLon) => [number, number]; view: MapView} => {
  const xy = pts.map((p) => project(p, 0));
  let x0 = Math.min(...xy.map((p) => p[0])), x1 = Math.max(...xy.map((p) => p[0]));
  let y0 = Math.min(...xy.map((p) => p[1])), y1 = Math.max(...xy.map((p) => p[1]));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let sw = Math.max(x1 - x0, 1e-6) / (1 - 2 * pad), sh = Math.max(y1 - y0, 1e-6) / (1 - 2 * pad);
  if (sw / sh > w / h) sh = (sw * h) / w; else sw = (sh * w) / h;
  x0 = cx - sw / 2; x1 = cx + sw / 2; y0 = cy - sh / 2; y1 = cy + sh / 2;
  const toPx = (p: LatLon): [number, number] => { const [x, y] = project(p, 0); return [((x - x0) / (x1 - x0)) * w, ((y - y0) / (y1 - y0)) * h]; };
  return {toPx, view: {bounds: [unproject([x0, y0]), unproject([x1, y1])], size: [w, h]}};
};

// Maps lat/lon into an existing view (a stitched map image of known bounds).
export const viewToPx = (view: MapView) => {
  const [a, b] = [project(view.bounds[0], 0), project(view.bounds[1], 0)];
  return (p: LatLon): [number, number] => { const [x, y] = project(p, 0); return [((x - a[0]) / (b[0] - a[0])) * view.size[0], ((y - a[1]) / (b[1] - a[1])) * view.size[1]]; };
};

export const distanceKm = (a: LatLon, b: LatLon) => {
  const R = 6371, dLat = ((b[0] - a[0]) * Math.PI) / 180, dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
