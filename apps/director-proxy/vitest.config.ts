import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			miniflare: {
				bindings: {
					LARAVEL_URL: "https://laravel.test",
					DIRECTOR_PROXY_SECRET: "test-secret",
					ANTHROPIC_API_KEY: "sk-test",
					USAGE_RETRY_BASE_MS: "1",
				},
			},
		}),
	],
});
