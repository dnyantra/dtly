// AI director (tasks 4.2, 4.4, 4.5): types shared by the engine (agent loop), the main process (CustomerPro
// calls) and the Director panel. No model key ever lives in the app: every model call goes through the
// CustomerPro proxy with a short-lived session token (D6, contracts.md §2).
//
// Host rules when the director runs tools (enforced in src/engine/director/guard.ts):
//  - reads: the project folder + raw files the owner added (sources.json);
//  - writes: the project folder only (DT.ly's ToolContext.allowWrite plus our own check of every output path);
//  - no shell, no arbitrary file access, no network tool (D7, D14).

export type DirectorMode = 'analyse' | 'build' | 'edit';
export type DirectorPhase = 'analyse' | 'plan' | 'build' | 'edit';

export interface DirectorStatus { available: boolean; reason?: string }

// Step caps per run (D7): tool calls for build/edit, model calls (one per clip) for analysis.
export const STEP_CAPS: Record<DirectorPhase, number> = {analyse: 200, plan: 80, build: 80, edit: 20};

// Ready styles (CustomerPro D13). The workspace's own styles arrive later from CustomerPro.
export interface StylePreset { id: string; name: string; description: string; style: string }
export const STYLES: StylePreset[] = [
  {id: 'energetic', name: 'Energetic promo', description: 'Fast cuts on the beat, bold kinetic text, punchy voiceover.',
    style: 'Energetic and confident. Cuts on the beat (1–2 s shots), bold short on-screen text (max 5 words), kinetic title moves, punchy voiceover, strong end card with the call to action.'},
  {id: 'premium', name: 'Premium / real estate', description: 'Slow drone reveals, clean type, calm music.',
    style: 'Premium and calm. Longer shots (2.5–4 s) with slow push-ins, drone reveals first, clean minimal type with generous spacing, warm grade, measured voiceover, facts shown as small chips.'},
  {id: 'local', name: 'Friendly local business', description: 'Warm, people-first, simple Hinglish.',
    style: 'Warm and friendly. People and faces first, simple everyday Hinglish, captions for every spoken line, bright colours from the brand, phone number on screen at the end.'},
  {id: 'explainer', name: 'Clear explainer', description: 'Step by step, captions, numbers on screen.',
    style: 'Clear and informative. One idea per beat, numbered steps, every number and fact on screen with its source, full captions, neutral music under the voice.'},
];

export interface PlanShot { clip: string; from: number; to: number; note?: string }
export interface PlanBeat { name: string; duration: number; shots: PlanShot[]; text?: string; vo?: string }
export interface PlanFact { text: string; source: string }
export interface DirectorPlan {
  title: string;
  duration: number;
  music: {mood: string; trackId?: string};
  voice?: {language: string; speaker: string};
  beats: PlanBeat[];
  facts: PlanFact[];
  gaps: string[];
}

// Pass-1 analysis of one source (cached by content hash, shared by all projects).
export interface ClipAnalysis {
  caption: string;
  motion?: string;
  quality?: string;
  best?: {t: number; why?: string}[];
  speech?: string; // transcript (if any)
  tags?: string[];
  notes?: unknown; // analysis_save from the agent
  model?: string;
  at?: string;
}

export type DoneReason = 'finished' | 'stopped' | 'budget' | 'step_cap' | 'error' | 'offline';

export type DirectorEventBody =
  | {type: 'phase'; phase: DirectorPhase}
  | {type: 'text'; delta: string}
  | {type: 'message'; role: 'assistant' | 'user' | 'system'; text: string}
  | {type: 'tool'; id: string; name: string; state: 'start' | 'end' | 'error' | 'blocked'; summary: string}
  | {type: 'plan'; plan: DirectorPlan}
  | {type: 'credits'; spent: number; budget: number}
  | {type: 'confirm'; id: string; question: string; detail?: string}
  | {type: 'progress'; done: number; total: number; label?: string}
  | {type: 'done'; reason: DoneReason; error?: string; code?: string; results?: {id: string; ok: boolean; cached?: boolean; error?: string}[]};
export type DirectorEvent = {dir: string; runId: string} & DirectorEventBody;

export interface DirectorLogEntry { at: string; role: 'assistant' | 'user' | 'system' | 'tool'; text: string }

export interface DirectorState {
  plan?: DirectorPlan;
  approved?: boolean;
  log: DirectorLogEntry[];
  running?: {runId: string; phase: DirectorPhase};
  usage: {sessions: number; spent: number};
  hasConversation: boolean;
}

// Main-process services the engine's director needs (the Sanctum token stays in main). Engine → main via the
// `hostCall` engine event, answered with the `hostReply` engine method.
export interface SessionInfo { session_id: string; token: string; proxy_url: string; models: string[]; budget_credits: number; expires_at: string }
export interface MusicTrack { id: string; title: string; mood: string; bpm: number; duration: number; url: string; beats_url: string; licence: string }
export interface HostOps {
  createSession: {in: {dir: string; mode: DirectorMode; premium?: boolean}; out: SessionInfo};
  sessionStatus: {in: {sid: string}; out: {status: 'open' | 'closed'; spent_credits: number; budget_credits: number}};
  closeSession: {in: {sid: string}; out: {charged_credits: number; released_credits: number}};
  transcribe: {in: {file: string; language?: string}; out: {text: string; segments: {start: number; end: number; text: string}[]; credits_charged?: number}};
  synthesize: {in: {text: string; language: string; speaker: string; pace?: number}; out: {wavBase64: string; credits?: number}};
  music: {in: void; out: MusicTrack[]};
  brand: {in: void; out: Record<string, unknown>};
}
export type HostOp = keyof HostOps;
export type DirectorHost = {[K in HostOp]: (p: HostOps[K]['in']) => Promise<HostOps[K]['out']>};

// Errors from the proxy / CustomerPro, normalised (contracts.md §2 and the Worker's codes).
export type DirectorErrorCode = 'budget_exhausted' | 'insufficient_credits' | 'model_not_allowed' | 'tool_not_allowed' | 'invalid_token' | 'prompt_unavailable' | 'offline' | 'not_linked' | 'error';

export interface HostCall { id: number; op: HostOp; params: unknown }
export interface HostReply { id: number; result?: unknown; error?: {message: string; code?: string} }

// Engine methods for the director (merged into EngineApi).
export interface DirectorEngineApi {
  directorStatus(): DirectorStatus;
  directorState(p: {dir: string}): DirectorState;
  directorAnalyse(p: {dir: string; ids?: string[]; force?: boolean}): {runId: string};
  directorPlan(p: {dir: string; brief: string; styleId?: string; style?: string; premium?: boolean}): {runId: string};
  directorApprove(p: {dir: string; plan: DirectorPlan; premium?: boolean}): {runId: string};
  directorChat(p: {dir: string; text: string; premium?: boolean}): {runId: string};
  directorContinue(p: {dir: string; premium?: boolean}): {runId: string};
  directorStop(p: {dir: string}): {stopped: boolean};
  directorAnswer(p: {id: string; ok: boolean}): {ok: boolean};
  directorSavePlan(p: {dir: string; plan: DirectorPlan}): {ok: true};
  hostReply(p: HostReply): {ok: boolean};
}
