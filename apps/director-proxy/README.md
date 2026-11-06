# Director proxy (Cloudflare Worker)

Sits between the DT.ly desktop app and the Anthropic Messages API. The app never
holds a model key. Contract: `openspec/changes/add-desktop-app/contracts.md` §2,
design D6.

Per `POST /v1/messages` the Worker:

1. verifies the session JWT (HS256, `DIRECTOR_PROXY_SECRET`, `exp`);
2. rejects a `model` that is not in the token's `models` (or has no price) with `403 model_not_allowed`;
3. returns `402 {error:"budget_exhausted"}` if the session meter (Durable Object keyed by `sid`) has spent ≥ `bud`;
4. loads prompt bundle `pv` from Laravel (signed GET, cached per version in the isolate);
5. **replaces** `system` with the bundle's `system` and sets `metadata.user_id = "<org>:<usr>"`;
6. strips tool definitions not in `allowed_tools`; `400 tool_not_allowed` if history contains a
   `tool_use` / `server_tool_use` of an unlisted tool, or `tool_choice` names one;
7. forwards to `https://api.anthropic.com/v1/messages` with `x-api-key`,
   `anthropic-version: 2023-06-01`, and the client's `anthropic-beta` if present;
8. passes the response through unchanged (SSE when `stream: true`), reads usage
   (`message_start` + `message_delta` for streams), computes the cost in micro-USD
   from the price table, adds it to the meter, and reports it to Laravel in
   `waitUntil`, retrying 5xx with backoff.

`GET /health` → `{ok:true}`. `OPTIONS` is allowed only for `Origin: app://…`; everything else gets no CORS headers.

Error bodies: `{error, message}` with `invalid_token` (401), `invalid_request` (400),
`model_not_allowed` (403), `tool_not_allowed` (400), `budget_exhausted` (402),
`prompt_unavailable` (502). Anthropic errors are passed through unchanged and not metered.

## Setup

Requires Node 22+ (Wrangler 4). `.nvmrc` pins 24.

```sh
cd apps/director-proxy
npm install
npm test            # vitest in the Workers runtime (@cloudflare/vitest-plugin)
npm run typecheck
cp .dev.vars.example .dev.vars   # local secrets for `npm run dev`
npm run dev
```

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `LARAVEL_URL` | var (`wrangler.toml`) | CustomerPro base URL, e.g. `https://customerpro.example.com` |
| `DIRECTOR_PROXY_SECRET` | **secret** | Shared with Laravel: signs session JWTs and the HMAC headers |
| `ANTHROPIC_API_KEY` | **secret** | Upstream key |
| `ANTHROPIC_BASE_URL` | optional var | Default `https://api.anthropic.com` |
| `USAGE_RETRY_ATTEMPTS` / `USAGE_RETRY_BASE_MS` | optional vars | Usage report retries (default 5 attempts, 500 ms base, doubling) |
| `METER` | Durable Object binding | `SessionMeter`, one instance per `sid` (SQLite-backed, migration `v1`) |

```sh
npx wrangler secret put DIRECTOR_PROXY_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
```

## Deploy

```sh
npm run deploy      # = wrangler deploy
```

Then give Laravel the Worker URL as the `proxy_url` it returns from `POST director/sessions`.

## What Laravel must do

All HMACs are `hex(hmac_sha256(DIRECTOR_PROXY_SECRET, message))`, lowercase hex.
`time` is Unix seconds as a decimal string, sent in `X-Proxy-Time`.

### Issue the session token

HS256 JWT signed with `DIRECTOR_PROXY_SECRET`:

```json
{"sid":"<string>","org":7,"usr":42,"prj":"<id>","mode":"build",
 "models":["claude-sonnet-5-5"],"bud":2000000,"pv":"<prompt version>",
 "iat":1762400000,"exp":1762407200}
```

`sid` must be a non-empty string; `bud` is micro-USD (number); `exp` is required.

### Serve the prompt bundle (verify the Worker's signature)

`GET {LARAVEL_URL}/api/desktop/v1/director/prompt/{pv}` with headers `X-Proxy-Time`, `X-Proxy-Signature`.

Signed message (exact bytes):

```
"GET\n/api/desktop/v1/director/prompt/{pv}\n" + time
```

`{pv}` is URL-encoded (`rawurlencode`) as it appears in the path. The signed path is always
this literal path, even if `LARAVEL_URL` has a sub-path. Respond
`{"version": "...", "system": "...", "allowed_tools": ["layer_add", ...]}`. A bundle
is cached per version for the life of the isolate, so **never change a published
version**; publish a new `pv` instead.

```php
$time = $request->header('X-Proxy-Time');
$path = '/api/desktop/v1/director/prompt/' . rawurlencode($pv);
$expected = hash_hmac('sha256', "GET\n{$path}\n{$time}", config('services.director_proxy.secret'));
abort_unless(hash_equals($expected, (string) $request->header('X-Proxy-Signature'))
    && abs(time() - (int) $time) <= 300, 401);
```

### Accept usage reports (verify the Worker's signature)

`POST {LARAVEL_URL}/api/desktop/v1/director/usage`, JSON body:

```json
{"id":"<uuid v4>","sid":"...","org":7,"model":"claude-sonnet-5-5",
 "input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":0,
 "cache_creation_input_tokens":0,"cost_usd_micros":4000,"at":"2026-11-06T12:00:00.000Z"}
```

Signed message (exact bytes; `rawBody` is the request body as received):

```
time + "\n" + rawBody
```

```php
$raw = $request->getContent();
$time = $request->header('X-Proxy-Time');
$expected = hash_hmac('sha256', $time . "\n" . $raw, config('services.director_proxy.secret'));
abort_unless(hash_equals($expected, (string) $request->header('X-Proxy-Signature'))
    && abs(time() - (int) $time) <= 300, 401);
// upsert by `id`; answer 200 on duplicates too
```

The Worker retries network errors and 5xx (5 attempts, 0.5 s / 1 s / 2 s / 4 s backoff) with
the same `id` and body, re-signed with a fresh `time` on each attempt. Any 4xx stops retries.

### Prices (micro-USD per token; keep in sync with `src/prices.ts`)

| Model | Input | Output | Cache read | Cache write (5 min) |
|---|---|---|---|---|
| `claude-haiku-5-5` | 0.1 | 0.5 | 0.01 | 0.125 |
| `claude-sonnet-5-5` | 2 | 10 | 0.2 | 2.5 |
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 |

`cost_usd_micros = ceil(sum(tokens × price))` per upstream call. All `cache_creation_input_tokens`
are priced at the 5-minute write rate.

## Notes

- The budget check runs before forwarding, and the meter is updated after the call, so concurrent
  calls in one session can overshoot `bud` by up to one call each. Laravel settles at reported usage.
- Only these request fields are forwarded: `model, messages, max_tokens, stream, temperature, top_p,
  top_k, stop_sequences, tools, tool_choice, thinking`. `system` and `metadata` are set by the
  Worker; anything else (e.g. `mcp_servers`, `container`) is dropped.
- A meter's storage is deleted 7 days after its token's `exp`.
