import type { SessionMeter } from "./meter";

export interface Env {
	/** Base URL of CustomerPro (Laravel), e.g. https://app.customerpro.in */
	LARAVEL_URL: string;
	/** Shared HS256/HMAC secret with Laravel (wrangler secret). */
	DIRECTOR_PROXY_SECRET: string;
	/** Anthropic API key (wrangler secret). */
	ANTHROPIC_API_KEY: string;
	/** Optional override, defaults to https://api.anthropic.com */
	ANTHROPIC_BASE_URL?: string;
	/** Optional: base backoff for usage-report retries in ms (default 500). */
	USAGE_RETRY_BASE_MS?: string;
	/** Optional: attempts for usage report (default 5). */
	USAGE_RETRY_ATTEMPTS?: string;
	METER: DurableObjectNamespace<SessionMeter>;
}
