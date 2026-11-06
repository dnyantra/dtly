import type { Env as ProxyEnv } from "../src/env";

declare global {
	namespace Cloudflare {
		interface Env extends ProxyEnv {}
	}
}
