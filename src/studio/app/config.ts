// Injected as window.DTLY: by the studio server (CLI), or by a host app that embeds Studio.
// Every key beyond token/file/version/brand is optional; the defaults are the CLI Studio's behaviour.
export interface StudioFeatures {
  render?: 'server' | 'browser' | false; // 'browser': the button asks the parent page to export
  events?: boolean; // live reload over SSE
  svgImport?: boolean;
}
export interface StudioConfig {
  token: string;
  file: string;
  version: string;
  brand: string;
  apiBase?: string;
  fontsBase?: string;
  media?: 'proxy' | 'direct';
  features?: StudioFeatures;
  saveDebounceMs?: number;
  readOnly?: boolean;
  parentOrigin?: string;
}

const raw = (window as unknown as {DTLY: StudioConfig}).DTLY;
const trim = (s: string) => s.replace(/\/+$/, '');

export const config = {
  ...raw,
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
