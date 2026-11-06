// The narrow surface the shell UI gets through the preload bridge (contextIsolation, no Node in the page).
import type {AccountState} from '../main/account.js';
import type {SyncStatus} from '../customerpro/sync.js';
import type {RemoteProjectRow} from '../customerpro/client.js';
import type {AnalysisFile, ExportProgress, ProjectPreset, ProjectSummary, SegmentOptions, SegmentResult, SourceState} from './types.js';
import type {DirectorEvent, DirectorPlan, DirectorState, DirectorStatus} from './director.js';
import type {AppSettings, ExportQuoteResult, FinalStartResult, PublishedLinks, PublishEvent, UpdaterStatus} from './publish.js';
import type {DownloadReport} from '../customerpro/media-sync.js';
import type {FinalPreset} from './types.js';

export interface Channels {
  'app:info': {in: void; out: {version: string; electron: string; engine: string; ffmpeg?: string; ffmpegLgpl?: boolean; projectsRoot: string; dev: boolean}};
  'app:openExternal': {in: {url: string}; out: void};
  'app:reveal': {in: {path: string}; out: void};
  'app:diagnostics': {in: void; out: {file?: string}};
  'projects:list': {in: void; out: ProjectSummary[]};
  'projects:create': {in: {name: string; preset: ProjectPreset}; out: ProjectSummary};
  'projects:openDialog': {in: void; out: ProjectSummary | null};
  'projects:open': {in: {dir: string}; out: {project: ProjectSummary; studioUrl: string; sync: SyncStatus}};
  'projects:close': {in: void; out: void};
  'projects:rename': {in: {dir: string; name: string}; out: ProjectSummary};
  'projects:trash': {in: {dir: string}; out: void};
  'media:list': {in: {dir: string}; out: SourceState[]};
  'media:importDialog': {in: {dir: string; folders?: boolean}; out: {added: number; skipped: {path: string; reason: string}[]} | null};
  'media:importPaths': {in: {dir: string; paths: string[]}; out: {added: number; skipped: {path: string; reason: string}[]}};
  'media:locate': {in: {dir: string; id: string}; out: {relocated: string[]} | null};
  'media:remove': {in: {dir: string; id: string}; out: void};
  'media:analyse': {in: {dir: string; ids?: string[]}; out: {id: string; ok: boolean; error?: string}[]};
  'media:analysis': {in: {dir: string}; out: AnalysisFile};
  'media:cancel': {in: {task: string}; out: void};
  'footage:addToTimeline': {in: {dir: string; id: string; from: number; to: number; opts?: SegmentOptions}; out: {segment: SegmentResult; layerId: string}};
  'export:preview': {in: {dir: string}; out: {id: string; out: string}};
  'export:cancel': {in: {id: string}; out: void};
  'account:get': {in: void; out: AccountState};
  'account:signIn': {in: void; out: AccountState};
  'account:cancelSignIn': {in: void; out: void};
  'account:signOut': {in: void; out: void};
  'account:refresh': {in: void; out: AccountState};
  'sync:status': {in: {dir: string}; out: SyncStatus};
  'sync:remoteProjects': {in: void; out: RemoteProjectRow[]};
  'sync:link': {in: {dir: string; projectId?: number | string}; out: SyncStatus};
  'sync:unlink': {in: {dir: string}; out: SyncStatus};
  'sync:pull': {in: {dir: string}; out: SyncStatus};
  'sync:push': {in: {dir: string}; out: SyncStatus};
  'sync:resolve': {in: {dir: string; choice: 'theirs' | 'keep-mine'}; out: {copy?: string}};
  'sync:uploadMedia': {in: {dir: string}; out: {path: string; url?: string; error?: string}[]};
  'director:status': {in: void; out: DirectorStatus};
  'director:state': {in: {dir: string}; out: DirectorState};
  'director:analyse': {in: {dir: string; ids?: string[]; force?: boolean}; out: {runId: string}};
  'director:plan': {in: {dir: string; brief: string; styleId?: string; premium?: boolean}; out: {runId: string}};
  'director:approve': {in: {dir: string; plan: DirectorPlan; premium?: boolean}; out: {runId: string}};
  'director:chat': {in: {dir: string; text: string; premium?: boolean}; out: {runId: string}};
  'director:continue': {in: {dir: string; premium?: boolean}; out: {runId: string}};
  'director:stop': {in: {dir: string}; out: {stopped: boolean}};
  'director:answer': {in: {id: string; ok: boolean}; out: {ok: boolean}};
  'director:savePlan': {in: {dir: string; plan: DirectorPlan}; out: {ok: true}};
  // Final export, publish, media download, updates, settings (tasks 5.2–5.4, 5.6, 3.8)
  'export:quote': {in: {dir: string}; out: ExportQuoteResult};
  'export:final': {in: {dir: string; preset: FinalPreset; whatsapp: boolean; autoPublish: boolean}; out: FinalStartResult};
  'publish:start': {in: {dir: string; exportId: number | string}; out: PublishedLinks};
  'publish:cancel': {in: {exportId: number | string}; out: void};
  'media:downloadRemote': {in: {dir: string}; out: DownloadReport};
  'updater:status': {in: void; out: UpdaterStatus};
  'updater:check': {in: void; out: UpdaterStatus};
  'updater:install': {in: void; out: void};
  'settings:get': {in: void; out: AppSettings};
  'settings:set': {in: Partial<AppSettings>; out: AppSettings};
}
export type Channel = keyof Channels;

export interface Events {
  progress: {task: string; done: number; total: number; label?: string};
  export: ExportProgress;
  account: AccountState;
  sync: {dir: string; status: SyncStatus};
  upload: {dir: string; path: string; sent: number; size: number; fileIndex: number; files: number};
  media: {dir: string}; // the bin changed
  open: {dir: string}; // open this project (deep link, menu)
  menu: {action: 'new' | 'open' | 'import' | 'close' | 'home'};
  engine: {state: 'crashed' | 'restarted'};
  publish: PublishEvent;
  updater: UpdaterStatus;
  director: DirectorEvent;
}
export type EventName = keyof Events;

export const CHANNELS: Channel[] = [
  'app:info', 'app:openExternal', 'app:reveal', 'app:diagnostics',
  'projects:list', 'projects:create', 'projects:openDialog', 'projects:open', 'projects:close', 'projects:rename', 'projects:trash',
  'media:list', 'media:importDialog', 'media:importPaths', 'media:locate', 'media:remove', 'media:analyse', 'media:analysis', 'media:cancel',
  'footage:addToTimeline', 'export:preview', 'export:cancel',
  'account:get', 'account:signIn', 'account:cancelSignIn', 'account:signOut', 'account:refresh',
  'sync:status', 'sync:remoteProjects', 'sync:link', 'sync:unlink', 'sync:pull', 'sync:push', 'sync:resolve', 'sync:uploadMedia',
  'director:status', 'director:state', 'director:analyse', 'director:plan', 'director:approve', 'director:chat', 'director:continue', 'director:stop', 'director:answer', 'director:savePlan',
  'export:quote', 'export:final', 'publish:start', 'publish:cancel', 'media:downloadRemote',
  'updater:status', 'updater:check', 'updater:install', 'settings:get', 'settings:set',
];
export const EVENTS: EventName[] = ['progress', 'export', 'account', 'sync', 'upload', 'media', 'open', 'menu', 'engine', 'publish', 'updater', 'director'];

export interface CpvBridge {
  invoke<C extends Channel>(channel: C, payload: Channels[C]['in']): Promise<Channels[C]['out']>;
  on<E extends EventName>(event: E, fn: (data: Events[E]) => void): () => void;
  pathForFile(file: File): string; // drag-and-drop import
  platform: string;
}
