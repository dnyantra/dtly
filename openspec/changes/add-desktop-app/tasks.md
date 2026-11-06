# Tasks: CustomerPro Video desktop app

Estimates are for one developer. `[CP]` marks work in the CustomerPro repo (tracked there too, `add-video-app` tasks section D).

## 0. De-risk (week 1)

- [ ] 0.1 Spike: Electron 3x + `utilityProcess` running DT.ly `renderVideoParallel` with `skia-canvas` rebuilt for Electron's ABI, on macOS arm64, macOS x64 and Windows x64. Decide between utility process and a Node child process (D1). — *macOS arm64 done (apps/desktop/SPIKES.md): utilityProcess works, skia-canvas is Node-API so no rebuild; child-process fallback behind `CPV_ENGINE=child`. Windows x64 / macOS x64 not run.*
- [ ] 0.2 Spike: bundled LGPL ffmpeg/ffprobe on both OSes. Decode the KK Park 4K HEVC drone clips with hardware decode and with the software fallback; encode H.264 with VideoToolbox, Media Foundation, QSV and NVENC. Record which work on the reference laptop (D2). — *macOS arm64 done: LGPL FFmpeg 8.1 built from source (VideoToolbox), VT HEVC 10-bit decode 2.9× software; Windows LGPL build fetched but not run. See SPIKES.md (DT.ly hardcodes libx264; `eq` is GPL).*
- [ ] 0.3 Benchmark on the reference Windows laptop: render `~/Video/kkpark/project/project.json` (60 s, 23 comps). Measure the time to prepare 22 segments and to analyse 120 clips (pass 1). Compare with the D16 targets; adjust worker count and quality presets.
- [ ] 0.4 Spike `[CP]`: Cloudflare Worker proxy with a signed session token, streaming to Anthropic, token counting, budget stop, usage webhook to Laravel staging (D6).
- [ ] 0.5 Spike: `pi-agent-core` driving 5 DT.ly tool handlers in Node with Sonnet through the Worker; check tool-call streaming, abort and hooks.

## 1. DT.ly core changes (shared with web; week 2)

- [x] 1.1 Move tool definitions and handlers from `src/mcp/server.ts` to `src/tools/` (schema, description, handler on a project path); keep the MCP server as a thin adapter; export `@dnyantra/dtly/tools`. MCP tests unchanged. _Done: `src/tools/` (contracts §3; inputs validated with zod, JSON Schema 2020-12 without `project`), MCP adapter keeps the same 26 names and input schemas._
- [x] 1.2 `DTLY_FFMPEG` / `DTLY_FFPROBE` env paths in `src/render/ffmpeg.ts` and wherever DT.ly spawns ffmpeg. _Done: `ffmpegPath()`/`ffprobePath()` read at call time; used in export, node-host, transcribe, beats._
- [x] 1.3 Blocks from `kkpark/scripts/gfx.mjs` and `build.mjs` as presets, parameterised by brand colours and fonts (D10): `block.titlePlate`, `block.chip`, `block.kickerChip`, `block.areaReveal`, `block.badge`, `block.price`, `block.bigName`, `block.endCard`, `block.logoTile`, `block.textMaskIntro`, `block.watermark`, `grade.look`. _Done: `src/presets/blocks.ts`, `brand: {colors, fonts}` param._
- [x] 1.4 `timeline.build` preset: shots → precomps, beat-snapped cuts, transitions, voiceover placement, music ducking. Test: it rebuilds the KK Park project from `shots.mjs` plus the overlays, and a contact sheet matches the original. _Done: `src/presets/timeline.ts`, `test/timeline.ts` (cut diff 0 ms, 23 comps/114 layers, contact sheet identical)._
- [x] 1.5 Beat detection in Node (onset and tempo) producing the `.beats.json` format; test against `kkpark/music/techno.beats.json` (within 20 ms on 95% of beats). _Done: `detectBeats` in `@dnyantra/dtly/node` + `dtly beats`; 99.2% within 20 ms (`test/beats.ts`)._
- [ ] 1.6 Release DT.ly 0.4.0 (the user publishes).

## 2. Desktop shell and local projects (weeks 3–4)

- [x] 2.1 `apps/desktop` scaffold: Electron, `electron-builder`, Preact shell, preload bridge, `contextIsolation`, CSP; engine process (D1) with typed IPC. — *Electron 45; Studio export button routed to the shell (`features.render:'browser'`).*
- [x] 2.2 Project folders (D3): create, open recent, rename, delete (to trash), relative sources, `sources.json`, `.customerpro.json`. — *Root `~/CustomerPro Video` (`CPV_PROJECTS_ROOT`).*
- [x] 2.3 Studio inside the app: engine runs the DT.ly Studio server per open project; shell frames it with the embed config (D4); a save from the agent shows in Studio live. — *Front proxy injects the embed config until DT.ly accepts one (requested).*
- [x] 2.4 Media bin: import files or folders (referenced in place), probe, thumbnails, hash, missing-file state, photos and logo copied into `media/`.
- [x] 2.5 Footage pass 1 without AI: contact sheets and audio extraction stored for later (AI captions come in 4.2). — *Cache is per project for now; cross-project reuse comes with 4.2.*
- [x] 2.6 `segment_prepare` (D8) as an engine function and a manual UI ("Add to timeline" from a clip with in and out points, crop position and aspect). — *Tested on a real KK Park DJI 4K HEVC clip; LGPL-safe grades.*
- [x] 2.7 Preview export: watermarked 720p, progress, cancel, open folder.
- [x] 2.8 Internal unsigned builds for macOS and Windows; diagnostics export. — *mac arm64 dmg built and self-tested (packaged engine + windowed smoke); win x64 NSIS cross-built on mac with LGPL ffmpeg, not yet run on Windows.*

## 3. CustomerPro link (weeks 5–6)

- [ ] 3.1 `[CP]` `api/desktop/v1` (pattern of `routes/mobile.php`): device-code sign-in (`/auth/device`, `/auth/device/poll`), web approval page `desktop/link`, Sanctum token with ability `desktop`, device records, Settings → Devices revoke.
- [ ] 3.2 `[CP]` `GET /me`: user, workspace, plan, Video installed, `video.*` permissions, credit balance, monthly allowance and used, limits, `min_version`.
- [x] 3.3 App: sign-in screen, token in `safeStorage`, workspace switch, plan and permission states (no Video → upgrade link; read-only; no export). — *Against a mock of contracts.md §1; workspace switch = sign out and approve another workspace.*
- [ ] 3.4 `[CP]` Project sync endpoints: list, create, get, `PUT` with rev compare-and-set (reuse `VideoProjectStore::save`), plus `VideoSrcGuard` relative `media/…`, `vo/…`, `music/…` sources resolved to the project's R2 folder.
- [x] 3.5 App: link a local project to a CustomerPro project, push on save, pull on open, conflict copy (D9). — *Missing media is downloaded with `GET projects/{id}/media` on open from the web.*
- [ ] 3.6 `[CP]` Media upload: multipart presign for project media, register files in `video_project_files` (CustomerPro D14).
- [x] 3.7 App: "Edit on the web too" uploads prepared media; resumable uploads with progress. — *Expired part URLs are renewed with `POST media/resign` (resume, not restart).*
- [ ] 3.8 `customerpro-video://` protocol in the app; `[CP]` "Open in desktop app" button and "last edited on" on the web. — *App side done (protocol, single instance; a project not on this computer gets a folder, project.json and its media); web side pending.*
- [ ] 3.9 `[CP]` Brand kit, fonts and logo API; app applies them to blocks.

## 4. AI director (weeks 6–8)

- [ ] 4.1 `[CP]` Director sessions: `POST /director/sessions` holds credits, issues the signed token; Worker production deploy; usage webhook, settle, `usage_records`; daily reconcile job.
- [x] 4.2 Pass-1 analysis with Haiku through the Worker; `analysis.json` cache by hash; per-file failures reported and skipped. — *App side (`src/engine/director/analysis.ts`): shared cache `~/CustomerPro Video/.cache/analysis/<hash>.json`, mirrored into each project's `analysis.json`. Tested against a mock Worker only.*
- [ ] 4.3 Speech-to-text and voiceover through CustomerPro (`[CP]` endpoints wrapping `LlmClient::transcribe` and `synthesizeSpeech`, charged in credits); voiceover silence trimming in the engine. — *App side done (`speech/transcribe`, `speech/synthesize` clients; `vo_generate` trims silence with LGPL `silenceremove`); `[CP]` endpoints open.*
- [x] 4.4 Agent loop on `pi-agent-core` (pinned, behind our interface): tool registration from `@dnyantra/dtly/tools` plus footage, audio and block tools; hooks for path guard, step caps, confirm before delete, validate and save with rev, credits meter. — *`@earendil-works/pi-agent-core`/`pi-ai` 1.4.0 behind `src/engine/director/agent.ts`; blocks and timeline go through DT.ly `preset_apply` (no separate block_apply/timeline_build tools). Mock Worker tests only.*
- [x] 4.5 Director panel UI: brief, style picker (CustomerPro D13 styles), plan card (beats, shots with timestamps, text, voiceover, facts with sources, gaps), approve or edit plan, build progress, chat edits, stop. — *`src/renderer/director/`; styles are 4 hardcoded defaults until CustomerPro serves the workspace's styles.*
- [ ] 4.6 Music library (D11): `[CP]` track list with beat grids on R2; `music_pick` tool; the owner's own track gets beat detection. — *App side done: `music_pick` (library id → music/ + beats; owner track → rights confirm + DT.ly `detectBeats`); `[CP]` library open.*
- [ ] 4.7 Pilot comparison: same 5 briefs on Sonnet 5.5 and one open model through OpenRouter; record cost, steps, retries and owner acceptance per finished reel.

## 5. Export, publish, release (weeks 8–9)

- [ ] 5.1 `[CP]` `POST /exports`: allowance or credits per CustomerPro D12, signed grant; raise `video.max_render_bytes` to about 150 MB.
- [x] 5.2 Final export presets: Reel 1080×1920 at about 8 Mbps, Square, Landscape, a WhatsApp copy under 16 MB. — *`src/engine/export-final.ts`: grant first (POST exports, confirm dialog with allowance / re-export / credits), DT.ly master → 8 Mbps H.264 + AAC 192k, WhatsApp copy sized from duration (720p when needed, re-encoded if the encoder overshoots); progress, time left, cancel.*
- [x] 5.3 Publish: multipart upload to `renders/`, `renders.store`, Media Library; "Post" and "Send on WhatsApp" open the web composer with the asset. — *Single PUT (server always answers `single`, ≤150 MB) with progress, retries and re-presign; main then `whatsapp` variant. The composers (`/social/posts/create`, `/campaigns/create`) can't take a media id yet: the app passes `?media_asset=ID` for when `[CP]` supports it; the owner picks the video in the Media Library picker.*
- [ ] 5.4 Signing and notarization (Apple Developer ID; Azure Trusted Signing or an OV certificate); `electron-updater` on R2 with `stable` and `beta` channels; minimum-version enforcement. — *Config and code done (env-driven `electron-builder.config.cjs`, `src/main/updater.ts`, "Restart to update", min_version triggers an immediate check; RELEASING.md). Nothing signed or published yet: needs the Apple and Azure accounts and the R2 bucket.*
- [ ] 5.5 `[CP]` Download page and "Get the desktop app" in the Video app; release notes.
- [x] 5.6 Opt-in crash reporting (no media, no project text). — *Electron crashReporter, submit URL `CPV_CRASH_URL` (build or run time), off by default, toggle in Account; report ids in the diagnostics export.*
- [ ] 5.7 Acceptance test (proposal.md): the KK Park raw folder plus brief on the reference laptop → published reel, ≤3 edit rounds, <₹300 model cost, export under 10 minutes.
- [ ] 5.8 Pilot with 10 reels from 3–5 real customers; collect cost and time per reel and feed the numbers back into credit pricing.

## Ownership (parallel work)

| Track | Tasks | Where |
|---|---|---|
| A. DT.ly core | 1.1–1.6 | `~/Video/dtly/src` |
| B. Desktop shell | 2.x, 3.3, 3.5, 3.7, 3.8 (app side), 4.4–4.5, 5.2–5.4, 5.6 | `~/Video/dtly/apps/desktop` |
| C. CustomerPro API | 3.1, 3.2, 3.4, 3.6, 3.8 (web), 3.9, 4.3, 4.6, 5.1, 5.5 | CustomerPro `feat/video-app` |
| D. Proxy | 0.4, 4.1 | Cloudflare Worker + CustomerPro |
