// IPC shapes for final export, publish, updates and app settings (tasks 5.2–5.4, 5.6).
import type {FinalPreset, RenderedFile} from './types.js';

export type ExportKind = 'reexport' | 'free' | 'paid';

export interface ExportQuoteResult {
  canExport: boolean;
  reason?: string;
  kind: ExportKind; // predicted from /me and the last grant; the server decides
  priceCredits?: number;
  balance: number;
  allowance: {used: number; videos_per_month: number; resets_at: string | null};
  freeReexportUntil?: string;
  duration: number;
  width: number;
  height: number;
  defaultPreset: FinalPreset;
  linked: boolean;
  canLink: boolean;
  last?: {exportId: number | string; at: string; preset: FinalPreset; main?: RenderedFile; whatsapp?: RenderedFile; published?: PublishedLinks};
  baseUrl: string;
}

export type FinalStartResult =
  | {ok: true; id: string; out: string; exportId: number | string; kind?: ExportKind; chargedCredits: number; allowance: {used: number; videos_per_month: number}; freeReexportUntil: string | null}
  | {ok: false; error: 'insufficient_credits'; price: number; balance: number; buyUrl: string};

export interface PublishedLinks {
  main: {media_asset_id: number | string; url: string};
  whatsapp?: {media_asset_id: number | string; url: string};
  whatsappError?: string;
  links: {mediaLibrary: string; post: string; whatsapp: string};
}

export type PublishEvent =
  | {dir: string; exportId: number | string; phase: 'uploading'; variant: 'main' | 'whatsapp'; sent: number; size: number; attempt: number}
  | ({dir: string; exportId: number | string; phase: 'done'} & PublishedLinks)
  | {dir: string; exportId: number | string; phase: 'error' | 'cancelled'; error?: string; code?: string};

export type UpdateChannel = 'stable' | 'beta';
export interface UpdaterStatus {
  state: 'disabled' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  channel: UpdateChannel;
  current: string;
  version?: string; // the update's version
  percent?: number;
  message?: string; // disabled reason / error
}

export interface AppSettings {
  updateChannel: UpdateChannel;
  crashReports: boolean; // opt-in (D14): off by default
  crashReportsAvailable?: boolean; // false when this build has no submit URL
}
