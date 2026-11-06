import type { Env } from "./env";
import { TokenError, verifySessionToken, type SessionClaims } from "./jwt";
import { BundleError, loadBundle, reportUsage, type PromptBundle } from "./laravel";
import { costMicros, hasPrice, type Usage } from "./prices";
import { emptyUsage, mergeUsage, usageFromSse } from "./sse";

export { SessionMeter } from "./meter";
export type { Env } from "./env";

export const ANTHROPIC_VERSION = "2023-06-01";

/** Request fields forwarded to Anthropic. Anything else (mcp_servers, container, …) is dropped. */
const FORWARDED_FIELDS = [
	"model",
	"messages",
	"max_tokens",
	"stream",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
	"tools",
	"tool_choice",
	"thinking",
	"metadata",
	"output_config",
] as const;

/** Upstream response headers not passed back to the client. */
const DROP_RESPONSE_HEADERS = ["content-length", "set-cookie", "anthropic-organization-id"];

type Json = Record<string, unknown>;

function json(status: number, body: Json, extra?: HeadersInit): Response {
	const h = new Headers(extra);
	h.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { status, headers: h });
}

const err = (status: number, error: string, message: string) => json(status, { error, message });

function corsHeaders(req: Request): Headers {
	const h = new Headers();
	const origin = req.headers.get("Origin");
	if (origin && origin.startsWith("app://")) {
		h.set("Access-Control-Allow-Origin", origin);
		h.set("Vary", "Origin");
	}
	return h;
}

function withCors(req: Request, res: Response): Response {
	const cors = corsHeaders(req);
	if (![...cors.keys()].length) return res;
	const out = new Response(res.body, res);
	cors.forEach((v, k) => out.headers.set(k, v));
	return out;
}

function preflight(req: Request): Response {
	const origin = req.headers.get("Origin");
	if (!origin || !origin.startsWith("app://")) return new Response(null, { status: 403 });
	const h = corsHeaders(req);
	h.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, anthropic-beta, anthropic-version");
	h.set("Access-Control-Max-Age", "86400");
	return new Response(null, { status: 204, headers: h });
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "OPTIONS") return preflight(req);
		if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
			return json(200, { ok: true });
		}
		if (url.pathname === "/v1/messages") {
			if (req.method !== "POST") return err(405, "method_not_allowed", "Use POST");
			return withCors(req, await messages(req, env, ctx));
		}
		return err(404, "not_found", "Not found");
	},
} satisfies ExportedHandler<Env>;

async function messages(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// 1. token
	const auth = req.headers.get("Authorization") ?? "";
	const m = /^Bearer\s+(.+)$/i.exec(auth);
	if (!m) return err(401, "invalid_token", "Missing bearer token");
	let claims: SessionClaims;
	try {
		claims = await verifySessionToken(m[1]!.trim(), env.DIRECTOR_PROXY_SECRET);
	} catch (e) {
		if (e instanceof TokenError) return err(401, "invalid_token", e.message);
		throw e;
	}

	let body: Json;
	try {
		body = (await req.json()) as Json;
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
	} catch {
		return err(400, "invalid_request", "Body must be a JSON object");
	}

	// 2. model
	const model = body.model;
	if (typeof model !== "string" || !claims.models.includes(model) || !hasPrice(model)) {
		return err(403, "model_not_allowed", `Model ${String(model)} is not allowed for this session`);
	}

	// 7 (check part). Stop once the session has spent its budget.
	const meter = env.METER.get(env.METER.idFromName(claims.sid));
	const spent = await meter.spent();
	if (spent >= claims.bud) {
		return json(402, { error: "budget_exhausted", message: "Session budget reached", spent_usd_micros: spent, budget_usd_micros: claims.bud });
	}

	// 3. prompt bundle
	let bundle: PromptBundle;
	try {
		bundle = await loadBundle(env, claims.pv);
	} catch (e) {
		if (e instanceof BundleError) {
			console.error(e.message);
			return err(502, "prompt_unavailable", "Could not load the director prompt");
		}
		throw e;
	}

	// 4 + 5. build the upstream body
	const upstream: Json = {};
	for (const f of FORWARDED_FIELDS) if (body[f] !== undefined) upstream[f] = body[f];
	upstream.system = bundle.system;
	upstream.metadata = { user_id: `${claims.org}:${claims.usr}` };

	const toolCheck = applyToolPolicy(upstream, new Set(bundle.allowed_tools));
	if (toolCheck) return toolCheck;

	// 6. forward
	const headers = new Headers({
		"Content-Type": "application/json",
		"x-api-key": env.ANTHROPIC_API_KEY,
		"anthropic-version": ANTHROPIC_VERSION,
	});
	const beta = req.headers.get("anthropic-beta");
	if (beta) headers.set("anthropic-beta", beta);

	const base = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
	const res = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(upstream) });

	const outHeaders = new Headers(res.headers);
	for (const h of DROP_RESPONSE_HEADERS) outHeaders.delete(h);

	if (!res.ok || !res.body) {
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
	}

	const settle = (usage: Usage) => settleUsage(env, claims, model, usage);
	const isSse = (res.headers.get("Content-Type") ?? "").includes("text/event-stream");

	if (isSse) {
		// One branch goes to the client unchanged; the other is read to the end for
		// usage, even if the client disconnects early.
		const [toClient, toMeter] = res.body.tee();
		ctx.waitUntil(
			usageFromSse(toMeter)
				.then(({ usage, seen }) => (seen ? settle(usage) : undefined))
				.catch((e) => console.error("usage from stream failed", e)),
		);
		return new Response(toClient, { status: res.status, headers: outHeaders });
	}

	const text = await res.text();
	try {
		const usage = emptyUsage();
		mergeUsage(usage, (JSON.parse(text) as Json).usage);
		ctx.waitUntil(settle(usage).catch((e) => console.error("settle failed", e)));
	} catch (e) {
		console.error("could not read usage from response", e);
	}
	return new Response(text, { status: res.status, headers: outHeaders });
}

/**
 * Strip tool definitions not in the bundle's `allowed_tools`. Returns a 400
 * response if history uses a tool that is not allowed or tool_choice names one.
 */
function applyToolPolicy(upstream: Json, allowed: Set<string>): Response | null {
	if (Array.isArray(upstream.messages)) {
		for (const msg of upstream.messages as Json[]) {
			if (!msg || !Array.isArray(msg.content)) continue;
			for (const block of msg.content as Json[]) {
				if (block && (block.type === "tool_use" || block.type === "server_tool_use") && !allowed.has(String(block.name))) {
					return err(400, "tool_not_allowed", `Tool ${String(block.name)} is not allowed`);
				}
			}
		}
	}
	if (Array.isArray(upstream.tools)) {
		const kept = (upstream.tools as Json[]).filter((t) => t && typeof t.name === "string" && allowed.has(t.name));
		if (kept.length) upstream.tools = kept;
		else {
			delete upstream.tools;
			delete upstream.tool_choice;
		}
	}
	const choice = upstream.tool_choice as Json | undefined;
	if (choice && choice.type === "tool" && !allowed.has(String(choice.name))) {
		return err(400, "tool_not_allowed", `Tool ${String(choice.name)} is not allowed`);
	}
	return null;
}

async function settleUsage(env: Env, claims: SessionClaims, model: string, usage: Usage): Promise<void> {
	const cost = costMicros(model, usage);
	const meter = env.METER.get(env.METER.idFromName(claims.sid));
	await meter.add(cost, claims.exp);
	await reportUsage(env, {
		id: crypto.randomUUID(),
		sid: claims.sid,
		org: claims.org,
		model,
		...usage,
		cost_usd_micros: cost,
		at: new Date().toISOString(),
	});
}
