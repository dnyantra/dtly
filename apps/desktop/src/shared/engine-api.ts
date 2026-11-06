// Typed IPC between the main process and the engine (utility process, D1).
// Requests: {id, method, params} → {id, result} | {id, error}. Events: {event, data}.
import type {AnalysisEntry, AnalysisFile, ExportProgress, FinalPreset, ProjectPreset, ProjectSummary, SegmentOptions, SegmentResult, SourceEntry, SourceState} from './types.js';
import type {FfmpegInfoLite} from './misc.js';
import type {DirectorEngineApi, DirectorEvent, HostCall} from './director.js';

export interface EngineApi extends DirectorEngineApi {
  ping(): {pong: true; pid: number; versions: Record<string, string | undefined>};
  info(): {ffmpeg: FfmpegInfoLite; dtly: string; node: string; electron?: string; projectsRoot: string};
  listProjects(p: {extra?: string[]}): ProjectSummary[];
  createProject(p: {name: string; preset?: ProjectPreset; project?: unknown}): ProjectSummary;
  renameProject(p: {dir: string; name: string}): ProjectSummary;
  duplicateProject(p: {dir: string; name: string}): ProjectSummary;
  openProject(p: {dir: string; readOnly?: boolean; parentOrigin?: string}): {project: ProjectSummary; studioUrl: string};
  closeProject(): {closed: boolean};
  setStudioOptions(p: {readOnly?: boolean}): {ok: true};
  readProjectFile(p: {dir: string}): {project: unknown; hash: string};
  writeProjectFile(p: {dir: string; project: unknown}): {hash: string};
  importMedia(p: {dir: string; paths: string[]}): {added: SourceEntry[]; skipped: {path: string; reason: string}[]};
  listSources(p: {dir: string}): SourceState[];
  locateSource(p: {dir: string; id: string; path: string}): {relocated: string[]};
  removeSource(p: {dir: string; id: string}): {ok: true};
  analyse(p: {dir: string; ids?: string[]}): {id: string; ok: boolean; error?: string}[];
  analysis(p: {dir: string}): AnalysisFile;
  contactSheet(p: {dir: string; id: string; force?: boolean}): NonNullable<AnalysisEntry['sheet']>;
  extractAudio(p: {dir: string; id: string}): NonNullable<AnalysisEntry['audio']>;
  segmentPrepare(p: {dir: string; id: string; from: number; to: number; opts?: SegmentOptions}): SegmentResult;
  addToTimeline(p: {dir: string; id: string; from: number; to: number; opts?: SegmentOptions; at?: number}): {segment: SegmentResult; layerId: string};
  startPreviewExport(p: {dir: string}): {id: string; out: string};
  cancelExport(p: {id: string}): {cancelled: boolean};
  // Final export (task 5.2): no watermark, ~8 Mbps, optional WhatsApp copy < 16 MB. Events: 'export' (kind 'final').
  startFinalExport(p: {dir: string; preset: FinalPreset; whatsapp?: boolean; whatsappMaxBytes?: number; id?: string}): {id: string; out: string};
  cancelTask(p: {task: string}): {cancelled: boolean};
  diagnostics(): Record<string, unknown>;
}

export type EngineMethod = keyof EngineApi;
export type Params<M extends EngineMethod> = Parameters<EngineApi[M]>[0];
export type Result<M extends EngineMethod> = ReturnType<EngineApi[M]>;

export interface EngineEvents {
  progress: {task: string; done: number; total: number; label?: string};
  export: ExportProgress;
  projectChanged: {dir: string; source: 'studio' | 'disk'; hash: string};
  log: {level: 'info' | 'warn' | 'error'; message: string};
  director: DirectorEvent; // AI director progress (tasks 4.2–4.5)
  hostCall: HostCall; // engine → main: CustomerPro call for the director, answered with hostReply
}
export type EngineEvent = keyof EngineEvents;

export type EngineRequest = {id: number; method: EngineMethod; params: unknown};
export type EngineReply = {id: number; result?: unknown; error?: {message: string; code?: string}};
export type EngineEventMsg = {event: EngineEvent; data: unknown};
