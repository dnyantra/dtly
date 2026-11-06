// The Studio page's config (window.DTLY), shared by the browser app (app/config.ts) and the server
// (server.ts) so a host that embeds Studio can override it through startStudio({config}).
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
  brand: string; // shown in the header and the document title ("<brand> Studio")
  apiBase?: string;
  fontsBase?: string;
  media?: 'proxy' | 'direct';
  features?: StudioFeatures;
  saveDebounceMs?: number;
  readOnly?: boolean;
  parentOrigin?: string;
}
/** What a host may set: everything except the server-owned token, file name and version. */
export type StudioEmbedConfig = Partial<Omit<StudioConfig, 'token' | 'file' | 'version'>>;
