// Types shared by the main process, the engine and the shell UI.

export type MediaKind = 'video' | 'image' | 'audio' | 'pdf' | 'other';

// What ffprobe tells us about a file (only the parts the app uses).
export interface Probe {
  container?: string;
  duration?: number; // seconds
  size?: number; // bytes
  video?: {codec: string; profile?: string; width: number; height: number; fps: number; pixFmt?: string; bitDepth?: number; rotation: number; displayWidth: number; displayHeight: number};
  audio?: {codec: string; channels: number; sampleRate: number};
}

// One raw file referenced in place (sources.json). Raw video is never copied.
export interface SourceEntry {
  id: string; // first 16 hex of the content hash
  path: string; // absolute path on this computer (raw files live outside the project)
  name: string;
  kind: MediaKind;
  size: number;
  mtime: number; // ms
  hash: string; // sha256 over first 4 MB + last 4 MB + size
  probe?: Probe;
  copiedTo?: string; // photos / logos / audio copied into the project: relative path (media/…)
  addedAt: string;
  thumb?: string; // relative to the project folder (.cache/thumbs/…)
}

export interface SourceState extends SourceEntry { missing: boolean; changed: boolean }

export interface SourcesFile { version: 1; sources: SourceEntry[] }

// Per-source analysis cache (analysis.json), keyed by content hash.
export interface AnalysisEntry {
  sheet?: {file: string; times: number[]; width: number; height: number};
  audio?: {file: string; sampleRate: 16000; channels: 1; duration: number} | {none: true};
  ai?: unknown; // pass-1 captions arrive with the director (task 4.2)
  updatedAt: string;
}
export interface AnalysisFile { version: 1; byHash: Record<string, AnalysisEntry> }

// .customerpro.json: the link between a local folder and a CustomerPro project.
export interface LinkFile {
  orgId: number | string;
  projectId: number | string;
  rev: number; // last rev both sides agreed on
  lastSyncedAt?: string;
  syncedHash?: string; // sha256 of project.json as last pushed/pulled (detects local edits)
  editOnWeb?: boolean;
  uploaded?: Record<string, {size: number; mtime: number; url: string}>;
}

export interface ProjectSummary {
  dir: string;
  name: string;
  updatedAt: number;
  width?: number;
  height?: number;
  duration?: number;
  linked?: boolean;
  poster?: string; // absolute path of a thumbnail if any
}

export type Aspect = '9:16' | '1:1' | '4:5' | '16:9';
export type ProjectPreset = 'reel' | 'square' | 'portrait' | 'landscape';
export const PRESET_SIZES: Record<ProjectPreset, [number, number]> = {reel: [1080, 1920], square: [1080, 1080], portrait: [1080, 1350], landscape: [1920, 1080]};

export type GradeName = 'none' | 'drone' | 'phone';
export interface Grade { contrast?: number; saturation?: number; gamma?: number; warmth?: number; sharpen?: boolean }

export interface SegmentOptions {
  aspect?: Aspect; // default: the project's root comp aspect
  size?: [number, number]; // comp size; output is 1.1x this
  cx?: number; // 0..1 horizontal crop centre (0.5 = centre)
  cy?: number; // 0..1 vertical crop centre
  rotate?: 0 | 90 | 180 | 270; // extra rotation, on top of the file's own rotation metadata
  grade?: GradeName | Grade;
  name?: string; // output basename (media/<name>.mp4)
  handles?: number; // seconds, default 0.7
  fps?: number; // default 30
}

export interface SegmentResult {
  file: string; // relative: media/<name>.mp4
  width: number;
  height: number;
  duration: number; // of the written file
  handleIn: number; // seconds of handle actually before `from` (use as the layer's trimIn)
  handleOut: number;
  encoder: string;
  hwDecode: boolean;
  seconds: number; // wall time
}

export interface ExportProgress {
  id: string; done: number; total: number; phase: 'render' | 'finished' | 'error' | 'cancelled'; out?: string; error?: string;
  // Final exports (task 5.2) only:
  kind?: 'preview' | 'final';
  stage?: 'render' | 'encode' | 'whatsapp';
  fraction?: number; // 0..1 over all stages
  etaSeconds?: number; // time left
  result?: FinalExportResult;
}

// Final export presets (D12, task 5.2). 'project' keeps the root comp's own size.
export type FinalPreset = 'reel' | 'square' | 'landscape' | 'project';
export const FINAL_PRESETS: Record<Exclude<FinalPreset, 'project'>, {label: string; size: [number, number]}> = {
  reel: {label: 'Reel 1080×1920', size: [1080, 1920]},
  square: {label: 'Square 1080×1080', size: [1080, 1080]},
  landscape: {label: 'Landscape 1920×1080', size: [1920, 1080]},
};
export interface RenderedFile { file: string; size: number; width: number; height: number; duration: number; bitrate: number; encoder?: string }
export interface FinalExportResult { preset: FinalPreset; main: RenderedFile; whatsapp?: RenderedFile; seconds: number }

// GET /me (contracts.md §1)
export interface Me {
  user: {id: number | string; name: string; email: string};
  workspace: {id: number | string; name: string};
  plan: {name: string};
  video: {installed: boolean; permissions: {view: boolean; edit: boolean; export: boolean; delete: boolean}};
  credits: {balance: number};
  allowance: {videos_per_month: number; used: number; resets_at: string | null};
  limits: {max_render_bytes: number; max_project_media_bytes: number; max_file_bytes: number};
  min_version: string | null;
}

export type AccessMode = 'signed-out' | 'upgrade' | 'update-required' | 'read-only' | 'full';
export interface Access { mode: AccessMode; canEdit: boolean; canExport: boolean; canSync: boolean; reason?: string }
