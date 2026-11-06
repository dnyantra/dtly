import { DurableObject } from "cloudflare:workers";

/** How long a session meter is kept after the token expires. */
const RETAIN_MS = 7 * 24 * 3600 * 1000;

/**
 * Per-session spend meter, one instance per `sid`. Durable Object methods run
 * one at a time on the instance, so `add` is atomic.
 */
export class SessionMeter extends DurableObject {
	async spent(): Promise<number> {
		return (await this.ctx.storage.get<number>("spent")) ?? 0;
	}

	/** Add `micros` and return the new total. `expSec` schedules cleanup. */
	async add(micros: number, expSec?: number): Promise<number> {
		const total = (await this.spent()) + Math.max(0, Math.ceil(micros));
		await this.ctx.storage.put("spent", total);
		if (expSec && (await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(expSec * 1000 + RETAIN_MS);
		}
		return total;
	}

	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
