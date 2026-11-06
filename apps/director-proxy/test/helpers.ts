import { base64UrlEncode, hmacSha256Hex } from "../src/crypto";
import type { SessionClaims } from "../src/jwt";

export const SECRET = "test-secret";
const enc = new TextEncoder();

export async function signJwt(claims: Partial<SessionClaims>, secret = SECRET, alg = "HS256"): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const full = {
		sid: "s-" + crypto.randomUUID(),
		org: 7,
		usr: 42,
		prj: "p1",
		mode: "build",
		models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
		bud: 1_000_000,
		pv: "v1",
		iat: now,
		exp: now + 3600,
		...claims,
	};
	const h = base64UrlEncode(enc.encode(JSON.stringify({ alg, typ: "JWT" })));
	const p = base64UrlEncode(enc.encode(JSON.stringify(full)));
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const s = base64UrlEncode(await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`)));
	return `${h}.${p}.${s}`;
}

export { hmacSha256Hex };

export interface Recorded {
	url: string;
	method: string;
	headers: Headers;
	body: string;
}

export type Handler = (r: Recorded) => Response | Promise<Response>;

/** Route table for the fetch mock; records every outbound request. */
export class FetchMock {
	calls: Recorded[] = [];
	anthropic: Handler = () => Response.json(messageResponse());
	bundle: Handler = () => Response.json({ version: "v1", system: "SERVER SYSTEM", allowed_tools: ["layer_add", "render_frame"] });
	usage: Handler = () => new Response("{}", { status: 200 });

	fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const req = new Request(input, init);
		const r: Recorded = { url: req.url, method: req.method, headers: req.headers, body: await req.text() };
		this.calls.push(r);
		const u = new URL(r.url);
		if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") return this.anthropic(r);
		if (u.host === "laravel.test" && u.pathname.startsWith("/api/desktop/v1/director/prompt/")) return this.bundle(r);
		if (u.host === "laravel.test" && u.pathname === "/api/desktop/v1/director/usage") return this.usage(r);
		return new Response("unexpected " + r.url, { status: 599 });
	};

	to(host: string, path?: string): Recorded[] {
		return this.calls.filter((c) => {
			const u = new URL(c.url);
			return u.host === host && (!path || u.pathname.startsWith(path));
		});
	}
}

export function messageResponse(usage: Record<string, number> = {}) {
	return {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5-5",
		content: [{ type: "text", text: "hi" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
	};
}

export function sse(events: Array<[string, unknown]>): string {
	return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
