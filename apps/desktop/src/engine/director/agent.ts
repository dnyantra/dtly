// Our small agent interface (D7) and its implementation on Pi (`@earendil-works/pi-agent-core` + `pi-ai`,
// pinned exactly in package.json). Everything else in the director talks to `DirectorAgent` only, so Pi can be
// replaced by another loop without touching tools, hooks or UI.
//
// Model calls go only to the director session's proxy_url (`POST {proxy_url}/v1/messages`) with the session
// token as `Authorization: Bearer`. The Worker owns the system prompt (it drops ours), so we send none.
import {Agent, type AgentMessage, type AgentTool} from '@earendil-works/pi-agent-core';
import {createModels, createProvider, type Model} from '@earendil-works/pi-ai';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type {DirectorErrorCode} from '../../shared/director.js';

export type ToolContent = {type: 'text'; text: string} | {type: 'image'; mimeType: string; data: string};
export interface ToolOutput { content: ToolContent[]; isError?: boolean }
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: any, signal?: AbortSignal): Promise<ToolOutput>;
}
export interface ToolCallInfo { id: string; name: string; input: any }
export interface AgentHooks {
  // Before a tool runs: block it (the reason goes back to the model); `stop` also ends the run after this turn.
  beforeTool?(call: ToolCallInfo): Promise<{block: true; reason: string; stop?: boolean} | undefined> | {block: true; reason: string; stop?: boolean} | undefined;
  afterTool?(call: ToolCallInfo, out: ToolOutput): Promise<void> | void;
  // Checked after every turn: true ends the run at that safe point.
  shouldStop?(): boolean;
}
export type AgentEvent =
  | {type: 'text'; delta: string}
  | {type: 'assistant'; text: string}
  | {type: 'tool_start'; id: string; name: string; input: any}
  | {type: 'tool_end'; id: string; name: string; isError: boolean; text: string}
  | {type: 'turn_end'; usage?: {input: number; output: number; cacheRead: number; cacheWrite: number}};

export interface AgentError { code: DirectorErrorCode; status?: number; message: string }
export interface RunResult { stop: 'end' | 'aborted' | 'error'; error?: AgentError; text: string }

export type UserContent = {type: 'text'; text: string} | {type: 'image'; mimeType: string; data: string};

export interface AgentOptions {
  proxyUrl: string;
  token: string;
  model: string;
  tools: AgentToolDef[];
  hooks?: AgentHooks;
  onEvent?: (e: AgentEvent) => void;
  history?: unknown[]; // a transcript from messages() of an earlier run (another session is fine)
  maxTokens?: number;
  keepImages?: number; // tool results whose images stay in context (older ones are replaced by a note)
  fetch?: typeof fetch;
}

export interface DirectorAgent {
  run(content: UserContent[]): Promise<RunResult>;
  abort(): void;
  messages(): unknown[]; // JSON-serialisable transcript, sanitised (no errored/aborted turns, no dangling tool calls)
}

// ---------------------------------------------------------------- errors from the Worker
const KNOWN: DirectorErrorCode[] = ['budget_exhausted', 'insufficient_credits', 'model_not_allowed', 'tool_not_allowed', 'invalid_token', 'prompt_unavailable'];
export const classifyHttpError = (status: number, body: string): AgentError => {
  let code: string | undefined, message: string | undefined;
  try { const j = JSON.parse(body); code = typeof j.error === 'string' ? j.error : j.error?.type; message = j.message ?? j.error?.message; } catch { /* not JSON */ }
  const known = KNOWN.find((k) => k === code);
  const byStatus: Record<number, DirectorErrorCode> = {402: 'budget_exhausted', 401: 'invalid_token', 403: 'model_not_allowed', 502: 'prompt_unavailable'};
  return {code: known ?? byStatus[status] ?? 'error', status, message: message ?? (body.slice(0, 200) || `The director proxy returned ${status}`)};
};

// ---------------------------------------------------------------- transcript hygiene
type Msg = {role: string; content?: unknown; stopReason?: string; toolCallId?: string};
const toolCallIds = (m: Msg) => (Array.isArray(m.content) ? (m.content as {type: string; id?: string}[]).filter((c) => c.type === 'toolCall').map((c) => c.id!) : []);
export const sanitizeTranscript = (messages: unknown[]): unknown[] => {
  const ms = (messages as Msg[]).filter((m) => m.role !== 'system' && !(m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted')));
  const results = new Set(ms.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId));
  const out: Msg[] = [];
  const keptCalls = new Set<string>();
  for (const m of ms) {
    if (m.role === 'assistant') {
      const ids = toolCallIds(m);
      if (ids.some((id) => !results.has(id))) continue; // tool calls without results: drop the whole turn
      ids.forEach((id) => keptCalls.add(id));
    }
    if (m.role === 'toolResult' && !keptCalls.has(m.toolCallId!)) continue;
    out.push(m);
  }
  // A transcript must not end on an assistant turn that still expects tool results, nor start with a result.
  while (out.length && out[0].role !== 'user') out.shift();
  return JSON.parse(JSON.stringify(out));
};

// Keeps images only in the last `keep` messages that carry them (contact sheets are large).
export const pruneImages = <T>(messages: T[], keep: number): T[] => {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as Msg;
    if (!Array.isArray(m.content) || !(m.content as {type: string}[]).some((c) => c.type === 'image')) continue;
    if (++seen <= keep) continue;
    out[i] = {...m, content: (m.content as {type: string}[]).map((c) => (c.type === 'image' ? {type: 'text', text: '[image omitted to save context; render or view it again if needed]'} : c))} as T;
  }
  return out;
};

const textOf = (content: unknown) => (Array.isArray(content) ? (content as {type: string; text?: string}[]).filter((c) => c.type === 'text').map((c) => c.text).join('') : typeof content === 'string' ? content : '');

// ---------------------------------------------------------------- Pi implementation
const proxyModel = (o: AgentOptions): Model<'anthropic-messages'> => ({
  id: o.model, name: o.model, api: 'anthropic-messages', provider: 'customerpro',
  baseUrl: o.proxyUrl.replace(/\/+$/, ''), // the SDK appends /v1/messages
  reasoning: false, input: ['text', 'image'],
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, // the Worker meters cost; we read credits from CustomerPro
  contextWindow: 200_000, maxTokens: o.maxTokens ?? 8192,
});

export const createAgent = (o: AgentOptions): DirectorAgent => {
  let lastHttpError: AgentError | undefined;
  const baseFetch = o.fetch ?? fetch;
  // Records the Worker's error body (budget_exhausted …) before the SDK turns it into a generic message.
  const trackingFetch: typeof fetch = async (input, init) => {
    let res: Response;
    try { res = await baseFetch(input, init); } catch (e) {
      if (!(init?.signal as AbortSignal | undefined)?.aborted) lastHttpError = {code: 'offline', message: `Cannot reach the CustomerPro director (${(e as Error).message})`};
      throw e;
    }
    if (!res.ok) lastHttpError = classifyHttpError(res.status, await res.clone().text().catch(() => ''));
    return res;
  };

  const provider = createProvider({
    id: 'customerpro', name: 'CustomerPro director',
    baseUrl: o.proxyUrl,
    auth: {apiKey: {name: 'CustomerPro director session', resolve: async () => ({auth: {headers: {Authorization: `Bearer ${o.token}`}}})}},
    models: [proxyModel(o)],
    api: anthropicMessagesApi(),
  } as Parameters<typeof createProvider>[0]);
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel('customerpro', o.model);
  if (!model) throw new Error(`Model ${o.model} unavailable`);

  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const tools: AgentTool[] = o.tools.map((t) => ({
    name: t.name, label: t.name, description: t.description,
    parameters: t.inputSchema as unknown as AgentTool['parameters'],
    executionMode: 'sequential',
    execute: async (_id, params, signal) => {
      const r = await t.execute(params, signal);
      if (r.isError) throw new Error(textOf(r.content) || `${t.name} failed`);
      return {content: r.content as never, details: {}};
    },
  }));

  const agent = new Agent({
    initialState: {systemPrompt: '', model, tools, messages: (o.history ?? []) as AgentMessage[]},
    streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, {...opts, fetch: trackingFetch, maxRetries: 2}),
    toolExecution: 'sequential',
    identity: {attribution: {name: 'CustomerPro Video', url: 'https://customerpro.in'}},
    transformContext: async (messages) => pruneImages(messages, o.keepImages ?? 3),
    beforeToolCall: async ({toolCall, args}) => {
      const r = await o.hooks?.beforeTool?.({id: toolCall.id, name: toolCall.name, input: args});
      if (r?.block) return {block: true, reason: r.reason, terminate: r.stop};
      if (!byName.has(toolCall.name)) return {block: true, reason: `Unknown tool ${toolCall.name}`};
      return undefined;
    },
    afterToolCall: async ({toolCall, args, result, isError}) => {
      await o.hooks?.afterTool?.({id: toolCall.id, name: toolCall.name, input: args}, {content: result.content as ToolContent[], isError});
      return undefined;
    },
  });
  agent.finishTurn = async ({message}) => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
    return o.hooks?.shouldStop?.() ? {action: 'end'} : undefined;
  };
  agent.subscribe((e) => {
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') o.onEvent?.({type: 'text', delta: e.assistantMessageEvent.delta});
    else if (e.type === 'message_end' && e.message.role === 'assistant') {
      const t = textOf(e.message.content);
      if (t) o.onEvent?.({type: 'assistant', text: t});
    } else if (e.type === 'tool_execution_start') o.onEvent?.({type: 'tool_start', id: e.toolCallId, name: e.toolName, input: e.args});
    else if (e.type === 'tool_execution_end') o.onEvent?.({type: 'tool_end', id: e.toolCallId, name: e.toolName, isError: e.isError, text: textOf((e.result as {content?: unknown})?.content).slice(0, 300)});
    else if (e.type === 'turn_end' && e.message.role === 'assistant') {
      const u = (e.message as {usage?: {input: number; output: number; cacheRead: number; cacheWrite: number}}).usage;
      o.onEvent?.({type: 'turn_end', usage: u && {input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite}});
    }
  });

  let aborted = false;
  return {
    async run(content) {
      lastHttpError = undefined;
      aborted = false;
      await agent.prompt({role: 'user', content: content as never, timestamp: Date.now()});
      const msgs = agent.state.messages as Msg[];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant') as (Msg & {errorMessage?: string}) | undefined;
      const text = last ? textOf(last.content) : '';
      if (aborted || last?.stopReason === 'aborted') return {stop: 'aborted', text};
      if (last?.stopReason === 'error') {
        const err = lastHttpError ?? {code: 'error' as const, message: last.errorMessage ?? 'The model call failed'};
        return {stop: 'error', error: err, text};
      }
      return {stop: 'end', text};
    },
    abort() { aborted = true; agent.abort(); },
    messages() { return sanitizeTranscript(agent.state.messages as unknown[]); },
  };
};
