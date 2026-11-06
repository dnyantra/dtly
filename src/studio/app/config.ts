// Injected as window.DTLY: by the studio server (CLI), or by a host app that embeds Studio.
// The shape lives in ../config-types.ts (shared with the server's embed-config override).
import type {StudioConfig, StudioFeatures} from '../config-types';

export type {StudioConfig, StudioFeatures};

const raw = (window as unknown as {DTLY: StudioConfig}).DTLY;
const trim = (s: string) => s.replace(/\/+$/, '');

export const config = {
  ...raw,
  brand: raw.brand || 'DT.ly',
  apiBase: trim(raw.apiBase ?? '/api'),
  fontsBase: trim(raw.fontsBase ?? '/fonts'),
  media: raw.media ?? 'proxy',
  features: {render: raw.features?.render ?? 'server', events: raw.features?.events ?? true, svgImport: raw.features?.svgImport ?? true} as Required<StudioFeatures>,
  saveDebounceMs: raw.saveDebounceMs ?? 250,
  readOnly: raw.readOnly ?? false,
  parentOrigin: raw.parentOrigin,
};

export const apiUrl = (path: string) => `${config.apiBase}/${path.replace(/^\//, '')}`;

// Messages to the embedding page (only when the host named its origin).
export const notifyParent = (msg: Record<string, unknown>) => {
  if (config.parentOrigin && window.parent !== window) window.parent.postMessage({source: 'dtly', ...msg}, config.parentOrigin);
};
