import { hmacSha256Hex } from "./crypto";
import type { Env } from "./env";
import type { Usage } from "./prices";

export interface PromptBundle {
	version: string | number;
	system: string;
	allowed_tools: string[];
}

export class BundleError extends Error {}

function baseUrl(env: Env): string {
	return env.LARAVEL_URL.replace(/\/+$/, "");
}

export function bundlePath(pv: string | number): string {
	return `/api/desktop/v1/director/prompt/${encodeURIComponent(String(pv))}`;
}

/** In-isolate cache. Bundles are immutable per version, so no TTL. */
const memo = new Map<string, PromptBundle>();
/** Shared in-flight fetches so concurrent calls fetch a version once. */
const inflight = new Map<string, Promise<PromptBundle>>();

/** For tests. */
export function clearBundleCache(): void {
	memo.clear();
	inflight.clear();
}

/** Signed GET of the prompt bundle (contracts.md §2), cached per version. */
export async function loadBundle(env: Env, pv: string | number): Promise<PromptBundle> {
	const key = String(pv);
	const hit = memo.get(key);
	if (hit) return hit;
	let p = inflight.get(key);
	if (!p) {
		p = fetchBundle(env, pv).finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	const bundle = await p;
	memo.set(key, bundle);
	return bundle;
}

async function fetchBundle(env: Env, pv: string | number): Promise<PromptBundle> {
	const path = bundlePath(pv);
	const time = String(Math.floor(Date.now() / 1000));
	const sig = await hmacSha256Hex(env.DIRECTOR_PROXY_SECRET, `GET\n${path}\n${time}`);
	const res = await fetch(baseUrl(env) + path, {
		method: "GET",
		headers: { Accept: "application/json", "X-Proxy-Time": time, "X-Proxy-Signature": sig },
	});
	if (!res.ok) throw new BundleError(`prompt bundle ${key(pv)}: HTTP ${res.status}`);
	const body = (await res.json()) as Partial<PromptBundle>;
	if (typeof body.system !== "string" || !Array.isArray(body.allowed_tools)) {
		throw new BundleError(`prompt bundle ${key(pv)}: bad shape`);
	}
	return { version: body.version ?? pv, system: body.system, allowed_tools: body.allowed_tools.map(String) };
}

const key = (pv: string | number) => String(pv);

export interface UsageReport extends Usage {
	id: string;
	sid: string;
	org: string | number;
	model: string;
	cost_usd_micros: number;
	at: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the usage report with HMAC headers. Retries network errors and 5xx with
 * exponential backoff; 2xx and 4xx end the loop. Returns the final status (0 = network).
 */
export async function reportUsage(env: Env, report: UsageReport): Promise<number> {
	const raw = JSON.stringify(report);
	const attempts = Number(env.USAGE_RETRY_ATTEMPTS ?? 5) || 5;
	const base = Number(env.USAGE_RETRY_BASE_MS ?? 500);
	let status = 0;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) await sleep(base * 2 ** (i - 1));
		// Fresh time + signature on each attempt so a slow retry is not rejected as stale.
		const time = String(Math.floor(Date.now() / 1000));
		const sig = await hmacSha256Hex(env.DIRECTOR_PROXY_SECRET, `${time}\n${raw}`);
		try {
			const res = await fetch(`${baseUrl(env)}/api/desktop/v1/director/usage`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Proxy-Time": time, "X-Proxy-Signature": sig },
				body: raw,
			});
			status = res.status;
			await res.body?.cancel();
			if (status < 500) {
				if (status >= 400) console.error(`usage report ${report.id} rejected: HTTP ${status}`);
				return status;
			}
		} catch (e) {
			status = 0;
			console.warn(`usage report ${report.id} attempt ${i + 1} failed`, e);
		}
	}
	console.error(`usage report ${report.id} gave up after ${attempts} attempts (last ${status})`);
	return status;
}
