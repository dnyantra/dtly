# Contracts: desktop app ↔ CustomerPro ↔ director proxy

Binding for every implementation track. Change only by editing this file first.

## 1. CustomerPro desktop API — `https://<host>/api/desktop/v1`

JSON everywhere. Authenticated routes need `Authorization: Bearer <sanctum token>` (ability `desktop`). Errors: `{error: <code>, message: <human text>}` with HTTP 4xx. Codes include `invalid_token`, `plan_required` (Video not installed), `forbidden` (permission), `conflict`, `insufficient_credits`, `validation`.

### Sign-in (unauthenticated, throttled)
- `POST auth/device` `{device_name, platform: "win"|"mac", app_version}` → `200 {device_code, user_code: "ABCD-1234", verification_url, interval: 5, expires_in: 600}`
- `POST auth/device/poll` `{device_code}` →
  - `428 {error: "authorization_pending"}`
  - `410 {error: "expired_token"}`
  - `403 {error: "access_denied"}`
  - `200 {token, expires_at, user: {id, name, email}, workspace: {id, name}}`
- Web page `GET /desktop/link?code=ABCD-1234` (session auth): shows the device, "Allow" / "Deny".

### Account
- `GET me` → `{user:{id,name,email}, workspace:{id,name}, plan:{name}, video:{installed:bool, permissions:{view,edit,export,delete}}, credits:{balance}, allowance:{videos_per_month, used, resets_at}, limits:{max_render_bytes, max_project_media_bytes, max_file_bytes}, min_version}`
- `POST auth/logout` → `204` (revokes this token)

### Projects (`video.view` to read, `video.edit` to write)
- `GET projects?page=` → `{data:[{id,name,rev,updated_at,last_edited_on:"web"|"desktop"|null,poster_url}], next_page}`
- `POST projects` `{name, preset: "reel"|"square"|"portrait"|"landscape"}` → `201 {id,name,rev,project}`
- `GET projects/{id}` → `{id,name,rev,project,updated_at,last_edited_on}`
- `PUT projects/{id}` `{project, rev, client:"desktop"}` → `200 {rev, warnings:[]}` | `409 {error:"conflict", rev}` | `422 {error:"validation", errors:[...]}`
- Sources inside `project` may be relative `media/…`, `vo/…`, `music/…` (no `..`, no leading `/`). The web resolves them to `{public_r2}/{org}/video/{project}/{path}`.

### Project media (`video.edit`)
- `POST projects/{id}/media/presign` `{path, size, content_type}` →
  - small (≤ 100 MB): `{mode:"single", key, url}` — PUT the bytes to `url`
  - large: `{mode:"multipart", key, upload_id, part_size, parts:[{n, url}]}`
- `POST projects/{id}/media/complete` `{path, key, size, upload_id?, parts?:[{n, etag}]}` → `{path, url}`
- `GET projects/{id}/media` (`video.view`) → `{data:[{path, size, content_type, url, updated_at}]}`. `url` is a GET URL valid for at least 1 hour (signed or public), used to download media missing locally.
- `POST projects/{id}/media/resign` `{key, upload_id, parts:[n,…]}` (`video.edit`) → `{parts:[{n, url}]}`. Renews part URLs for an unfinished multipart upload of this project; 404 if the upload is unknown or not this project's.

### Speech (credits)
- `POST speech/transcribe` multipart `audio` (wav/mp3/m4a ≤ 25 MB), `language?` → `{text, segments:[{start,end,text}], credits_charged}`
- `POST speech/synthesize` `{text, language: "hi-IN"|..., speaker, pace?}` → `audio/wav` body, header `X-Credits-Charged`

### Director sessions (`video.edit`)
- `POST director/sessions` `{project_id, mode: "analyse"|"build"|"edit"}` → `201 {session_id, token, proxy_url, models:[...], budget_credits, expires_at}` | `402 {error:"insufficient_credits"}`
- `POST director/sessions/{session_id}/close` → `{charged_credits, released_credits}`
- `GET director/sessions/{session_id}` → `{status: "open"|"closed", spent_credits, budget_credits}`

### Export and publish (`video.export`)
- `POST exports` `{project_id, duration, preset}` → `200 {grant, export_id, charged_credits, allowance:{used, videos_per_month}, free_reexport_until}` | `402 {error:"insufficient_credits", price_credits}`
- `POST projects/{id}/renders/presign` `{filename, content_type, size, export_id}` → as media presign
- `POST projects/{id}/renders` `{key, filename, mime, duration, width, height, export_id, variant: "main"|"whatsapp"}` → `{media_asset_id, url}`

### Library
- `GET music` → `{data:[{id,title,mood,bpm,duration,url,beats_url,licence}]}`
- `GET brand` → `{logo_url, colors:{primary,accent,ink}, fonts:{heading,body}, business:{name,phone,address,website}}`

## 2. Director proxy (Cloudflare Worker)

### Session token
JWT, HS256, secret `DIRECTOR_PROXY_SECRET` (shared by Laravel and the Worker). Claims:
`{sid, org, usr, prj, mode, models:[...], bud: <budget, micro-USD>, pv: <prompt version>, iat, exp}`.

### `POST {proxy_url}/v1/messages`
- Header: `Authorization: Bearer <session token>`.
- Body: Anthropic Messages API shape.
- The Worker:
  1. verifies the token (signature, `exp`);
  2. rejects a `model` not in `models`;
  3. loads the prompt bundle `pv`;
  4. **replaces** `system` with the bundle's system text (the client's `system` is dropped);
  5. drops tools not in `allowed_tools` (400 if one is used in history);
  6. forwards to Anthropic with `ANTHROPIC_API_KEY` (streaming or not, as asked);
  7. reads usage and adds the cost to the session meter (a Durable Object keyed by `sid`); once spent ≥ `bud`, later calls get `402 {error:"budget_exhausted"}`;
  8. reports usage.
- Responses pass through unchanged (SSE when `stream: true`).

### Prompt bundle (Worker → Laravel)
- `GET {LARAVEL_URL}/api/desktop/v1/director/prompt/{pv}`
- Headers: `X-Proxy-Time: <unix>`, `X-Proxy-Signature: hex(hmac_sha256(DIRECTOR_PROXY_SECRET, "GET\n/api/desktop/v1/director/prompt/{pv}\n" + time))`
- Response: `{version, system, allowed_tools:[...]}`. Cached per version.

### Usage report (Worker → Laravel)
- `POST {LARAVEL_URL}/api/desktop/v1/director/usage`
- Headers: `X-Proxy-Time`, `X-Proxy-Signature: hex(hmac_sha256(secret, time + "\n" + rawBody))`
- Body: `{id: <uuid, idempotency key>, sid, org, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd_micros, at}`
- Laravel answers `200` (also on a duplicate `id`). The Worker retries 5xx with backoff (`waitUntil`).

### Prices (micro-USD per token, Worker table; keep in sync with Laravel's)

| Model | Input | Output | Cache read | Cache write (5 min) |
|---|---|---|---|---|
| `claude-haiku-5-5` | 0.1 | 0.5 | 0.01 | 0.125 |
| `claude-sonnet-5-5` | 2 | 10 | 0.2 | 2.5 |
| `claude-opus-5-5` | 4 | 20 | 0.2 | 5 |

## 3. DT.ly shared tools — `@dnyantra/dtly/tools`

```ts
export interface ToolDef<I = any> {
  name: string;                 // same names as today's MCP tools
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema (draft 2020-12), additionalProperties:false
  handler(input: I, ctx: ToolContext): Promise<ToolResult>;
}
export interface ToolContext {
  projectPath: string;          // absolute path to project.json
  allowRead(absPath: string): boolean;  // path guard supplied by the host
  allowWrite?(absPath: string): boolean; // optional write guard supplied by the host (see below)
}
export type ToolResult = {content: Array<{type:'text', text:string} | {type:'image', mimeType:'image/png', data:string /* base64 */}>; isError?: boolean};
export const TOOLS: ToolDef[];
export function toolByName(name: string): ToolDef | undefined;
```

`allowWrite` (optional): every tool that creates a file other than the project file itself calls it with the
absolute output path before writing, and fails with `Writing <path> is not allowed` (an `isError` result) when it
returns false. Today that is `render_video` (the MP4), `map_tiles` (the PNG) and `render_frame` / `render_sheet`
(previews in `<project>/.dtly/frames/`, checked before the folder is created). Edits to `projectPath` are not
asked: the host chose that file. When `allowWrite` is absent all writes are allowed; the MCP adapter passes an
allow-all guard, as it does for `allowRead`. The desktop app allows writes inside the open project folder only.
