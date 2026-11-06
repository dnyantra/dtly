/**
 * Prices in micro-USD per token, from contracts.md §2. Keep in sync with Laravel.
 * Stored as thousandths of a micro-USD so the arithmetic stays exact in integers.
 */
const PRICES_MILLI: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"claude-haiku-5-5": { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
	"claude-sonnet-5-5": { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2500 },
	"claude-opus-5-5": { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 5000 },
};

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

export function hasPrice(model: string): boolean {
	return Object.hasOwn(PRICES_MILLI, model);
}

/** Cost of one call in whole micro-USD, rounded up. Cache writes use the 5-minute price. */
export function costMicros(model: string, u: Usage): number {
	const p = PRICES_MILLI[model];
	if (!p) throw new Error(`no price for ${model}`);
	const milli =
		u.input_tokens * p.input +
		u.output_tokens * p.output +
		u.cache_read_input_tokens * p.cacheRead +
		u.cache_creation_input_tokens * p.cacheWrite;
	return Math.ceil(milli / 1000);
}
