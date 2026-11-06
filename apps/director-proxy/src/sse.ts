import type { Usage } from "./prices";

export const emptyUsage = (): Usage => ({
	input_tokens: 0,
	output_tokens: 0,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
});

const FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

/** Copy numeric usage fields from an Anthropic usage object onto `into`. */
export function mergeUsage(into: Usage, u: unknown): void {
	if (!u || typeof u !== "object") return;
	for (const f of FIELDS) {
		const v = (u as Record<string, unknown>)[f];
		if (typeof v === "number" && Number.isFinite(v)) into[f] = v;
	}
}

/**
 * Read an Anthropic SSE stream to the end and return its usage.
 * `message_start` carries the initial usage; `message_delta` carries cumulative
 * totals that override it.
 */
export async function usageFromSse(stream: ReadableStream<Uint8Array>): Promise<{ usage: Usage; seen: boolean }> {
	const usage = emptyUsage();
	let seen = false;
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	const handle = (event: string) => {
		const data = event
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data) return;
		let msg: { type?: string; message?: { usage?: unknown }; usage?: unknown };
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (msg.type === "message_start") {
			mergeUsage(usage, msg.message?.usage);
			seen = true;
		} else if (msg.type === "message_delta") {
			mergeUsage(usage, msg.usage);
			seen = true;
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += value;
		let m: RegExpExecArray | null;
		const sep = /\r?\n\r?\n/g;
		let last = 0;
		while ((m = sep.exec(buf))) {
			handle(buf.slice(last, m.index));
			last = m.index + m[0].length;
		}
		buf = buf.slice(last);
	}
	if (buf.trim()) handle(buf);
	return { usage, seen };
}
