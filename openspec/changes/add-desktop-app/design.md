# Design: CustomerPro Video desktop app

## Context

- **DT.ly today** (`@dnyantra/dtly` 0.3.1): JSON project model, Node renderer on `skia-canvas` plus system ffmpeg (`renderVideoParallel`), a local Studio server (`src/studio/server.ts`, 127.0.0.1, token, HTTP Range for video, live reload), 26 MCP tools (`src/mcp/server.ts`), presets (`kinetic.sequence`, `opener.*`, `transition.between`, `element.*` …), and the Studio embed config (`window.DTLY`, 0.3.1).
- **CustomerPro today**: the web Video app (phase 1 on `feat/video-app`): `video_projects` with rev compare-and-set, Studio served in an iframe with the `studio-api` contract, renders uploaded to R2 and recorded as `MediaAsset`. It also has a first-party mobile API (`routes/mobile.php`, `api/mobile/v1`): Sanctum tokens with an ability, device records, uploads, a web handoff. It runs on Hostinger shared hosting (no long-running processes, PHP time limits).
- **Reference job**: `~/Video/kkpark`. 120 raw clips (25 drone clips in 4K HEVC, iPhone clips), 3.2 GB → 22 shots, 23 comps, 114 layers, 294 keyframes, 8 voiceover lines, a beat grid, a 60-second reel at 1080×1920.

## Goals / Non-goals

**Goals**
- A CustomerPro-branded desktop app on Windows and macOS that turns a raw folder plus a brief into a published reel.
- Keep one engine: the same project format, Studio, presets and tools as DT.ly and the web app.
- CustomerPro owns accounts, plans, credits, AI keys, prompts and publishing.

**Non-goals (first version)**
- Linux; phones and tablets.
- Real-time collaboration (sync is turn-based with revisions).
- Use without a CustomerPro account; bring-your-own AI key.
- A full non-linear editor (multi-track audio editing, colour wheels). Studio's feature set is the editor.

## Decisions

### D1. Electron, with the engine in a utility process

- **Main process:** windows, menus, protocol handler, auto-update, keychain, the session with CustomerPro.
- **Engine** (`utilityProcess`, Node): DT.ly ops and renderer, the local Studio server, the footage pipeline (ffmpeg/ffprobe), and the agent loop. Rendering and analysis never block the UI. A crash restarts only the engine.
- **Renderer windows:** the app shell UI (Preact, like Studio) and Studio itself. `contextIsolation: true`, `nodeIntegration: false`, a narrow `preload` bridge.

Electron over Tauri: DT.ly is Node, and so are `skia-canvas`, the MCP SDK and Pi. Tauri would still need Node as a bundled extra process.

**Risk to clear first (task 0.1):** `skia-canvas` is a native module. Rebuild it for Electron's ABI with `@electron/rebuild`. If that fails on either OS, ship a pinned Node runtime and run the engine as a plain child process instead; the design is otherwise unchanged.

### D2. Bundled ffmpeg, LGPL build, OS hardware codecs

- Ship `ffmpeg` and `ffprobe` per platform. Point DT.ly's `checkFfmpeg` at the bundled binaries via an env var. The DT.ly change is small: a `DTLY_FFMPEG` path, default `ffmpeg`.
- Use an LGPL build. Decode HEVC and encode H.264 with the OS hardware codecs (VideoToolbox on macOS; Media Foundation, QSV, NVENC or AMF on Windows) and fall back to software decode. Avoid `libx264` and `libx265` (GPL) unless the licence review says otherwise (open question 3).
- Run ffmpeg as a separate process, never linked.

### D3. Project = a folder; raw media referenced, not copied

```
~/CustomerPro Video/<Project name>/
  project.json            DT.ly project (sources relative: media/…, music/…, vo/…)
  media/                  prepared segments (H.264, vertical crop, graded) + photos + logo
  vo/  music/             generated voiceover, chosen track (+ .beats.json)
  sources.json            raw files referenced in place: path, size, mtime, hash, probe
  analysis.json           per-source analysis cache (keyed by hash)
  director/               conversation log (jsonl), plan.json, usage.json
  renders/                exports
  .customerpro.json       link: org id, project id, last synced rev
```

- Raw files are referenced by path and never copied, so a 3.2 GB folder costs no disk or upload. A moved or deleted raw file is shown as missing; already-prepared segments keep working.
- **Sources in `project.json` are always relative** (`media/board.mp4`). That makes one file valid on both sides (D9): the desktop resolves relative paths against the project folder, the web against the project's R2 media folder.

### D4. Studio in the app

- The engine runs DT.ly's Studio server for the open project.
- The Studio bundle is the same one the web app embeds, with `window.DTLY` set to:
  - `brand: 'CustomerPro Video'`
  - `media: 'direct'`
  - `features: {render: 'server', events: true, svgImport: true}`
- The app shell (home, media bin, director panel, export queue, account) sits around Studio. Studio loads in its own frame from the same origin, because its CSS is global.
- Live reload already works: agent saves stream into Studio over SSE, as with Claude Code today.

### D5. Sign-in: device code, Sanctum token with a `desktop` ability

- The app shows a code and opens `customerpro.in/desktop/link?code=…`.
- The owner, already signed in on the web, approves and picks the workspace.
- The app polls and receives a Sanctum token with ability `desktop`, a 90-day expiry renewed on use, and a device record.
- This is the pattern of `routes/mobile.php`: `api/desktop/v1`, inside `auth:sanctum` so tenancy scoping is live.
- Tokens are stored with Electron `safeStorage` (Keychain or DPAPI) and revocable in Settings → Devices on the web.
- On start and every hour, `GET /me` returns user, workspace, plan, Video installed or not, permissions, credit balance, monthly video allowance and limits. The app follows them:
  - no Video app → upgrade screen;
  - no `video.edit` → read-only;
  - no `video.export` → no publish.

### D6. AI calls go through a CustomerPro proxy on a Cloudflare Worker

The app never holds a model key. Hostinger PHP is a poor streaming proxy: requests last 30–120 s, output is buffered, and worker slots are few. So:

1. The app asks Laravel to start a director session: `POST /director/sessions {project_id, mode}`.
2. Laravel:
   - checks the plan and permissions;
   - **holds credits** for a budget (CreditWallet hold), sized to the mode;
   - returns a short-lived signed session token (org, user, project, budget, allowed models, expiry 2 h).
3. The app calls the Worker with that token. The Worker:
   - verifies the token;
   - **replaces the system prompt with the server-owned one** (platform rules + workspace style; fetched from Laravel and cached by version);
   - checks the tool list against an allowlist;
   - streams to Anthropic, or to OpenRouter for open models;
   - counts tokens and stops at the budget.
4. The Worker reports usage to Laravel (signed webhook, batched, retried). Laravel **settles** the hold at the actual cost × markup and writes `usage_records`. An unsettled hold auto-settles at the reported usage after 24 h.

Fallback, if a Worker is not wanted: the same contract served by Laravel, non-streaming, `max_tokens` ≤ 8K per step. It works, with worse latency.

Models: Haiku 5.5 for footage analysis, Sonnet 5.5 for build and edits, Opus 5.5 for "premium" or from-scratch builds. Open models through OpenRouter can be enabled per task by config after the pilot comparison.

### D7. Agent loop: Pi `pi-agent-core` in the engine, DT.ly tools in-process

- Split `src/mcp/server.ts` into `src/tools/` (definitions, schemas, handlers on a project file) plus a thin MCP adapter. The desktop agent registers the same handlers with Pi. One source of truth for Claude Code, the MCP server and the app.
- Tools offered to the director:
  - **project:** `project_describe`, `layer_*`, `property_set`, `keyframe_*`, `comp_*`, `preset_list`/`preset_apply`, `captions_add`, `svg_import`;
  - **look:** `render_frame`, `render_sheet` (images go back to the model);
  - **footage (D8):** `media_list`, `media_sheet`, `media_frames`, `media_transcribe`, `doc_pages`, `analysis_save`, `segment_prepare`;
  - **audio:** `vo_generate` (Sarvam through the CustomerPro API), `music_pick`;
  - **blocks (D10):** `block_apply`, `timeline_build`.
- **Not offered:** shell, arbitrary file read or write, network. Tools see only the project folder and the raw files the owner added.
- Pi hooks enforce:
  - before a tool call: path guard, step cap (build 80, edit 20), confirm before deleting layers or comps the owner made;
  - after a tool call: validate the project and save with a revision check (an owner editing in Studio at the same time wins, and the agent re-reads);
  - a running credits meter in the panel.
- The prompt layers follow CustomerPro D13: platform rules (server-owned), workspace style, project brief, chat. Pi is pinned to an exact version and wrapped behind our own small interface so it can be replaced.

### D8. Footage pipeline (two passes, cached)

1. **Import:** pick files or a folder. `ffprobe` each file (codec, resolution, fps, rotation, duration, audio), make a thumbnail, hash the first and last 4 MB plus the size.
2. **Pass 1, fixed and cheap:** per clip, a 6-frame contact sheet at 1280×720 and a speech check. If there is speech, extract 16 kHz audio → speech-to-text through CustomerPro. One Haiku call per clip returns a caption, motion, quality notes and the best-moment timestamps. Photos are downscaled to 1024 px; PDFs are sent as pages. Results go to `analysis.json`. Re-imports and later projects reuse the cache.
3. **Pass 2, agent-led:** while planning, the director calls `media_frames` or `media_transcribe` on specific clips and moments when pass 1 isn't enough (similar shots, shake, speech it needs).
4. **Prepare,** after the plan is approved. `segment_prepare(source, from, to, {crop:{aspect, cx, cy}, rotate, grade})` cuts the segment with 0.7 s handles, crops to the comp aspect at 1.1× the comp size, converts to H.264 at CRF 16, and writes `media/<shot>.mp4`. This is `prep.mjs` as a tool. Speed changes stay in DT.ly (`speed` on the video layer), so they can still be edited.

### D9. Sync with CustomerPro: the project file plus prepared media, on demand

- **Project file:** `GET/PUT /projects/{id}` with `rev` compare-and-set, the same as the web `studio-api`. The app pushes on save (debounced) and pulls on open and when the web reports a newer rev. On conflict, it shows "changed on the web" with a choice: load theirs, or keep mine as a copy.
- **Media:** prepared files in `media/`, `vo/` and `music/` upload to the project's R2 media folder (`{org}/video/{project}/media/…`) on Publish, or when the owner turns on "Edit on the web too". Raw files never upload.
  - Upload is multipart, resumable, with presigned PUTs from Laravel.
  - Storage after the free days is charged per CustomerPro D14.
- **CustomerPro change:** `VideoSrcGuard` accepts relative `media/…`, `vo/…`, `music/…` sources and resolves them to the project's own R2 folder.
- **Open in desktop:** the web project page shows "Open in desktop app" (`customerpro-video://open?project=ID&org=ID`, registered by the app). The projects list shows where a project was last edited.

### D10. Blocks and timeline in DT.ly core (shared with web)

- **Presets from `kkpark/scripts/gfx.mjs` and `build.mjs`**, parameterised by brand colours and fonts:
  - `block.titlePlate`, `block.chip`, `block.kickerChip`, `block.areaReveal` (traced outline + counter), `block.badge`, `block.price`, `block.bigName`, `block.endCard`, `block.logoTile`, `block.textMaskIntro`, `block.watermark`;
  - `grade.look` (adjustment-layer looks).
- **`timeline.build`** takes `{shots:[{src, trimIn, dur, speed, crop, overlay:{block, params}}], music:{src, beats}, transitions, vo:[{src, at:{shot, offset}}], duck:{lo, hi}, grade}` and produces the precomps, beat-snapped cuts (within 0.3 s, minimum 1 s per shot), transitions, voiceover layers and music ducking keyframes. That is `build.mjs` as one preset. The agent then refines with layer-level tools.
- About 40 calls build a KK Park-sized reel instead of about 250. This is the main cost lever (see the cost section).

### D11. Music library

- A curated royalty-free set (about 40 tracks to start, by mood and tempo) with `.beats.json` made offline. It is served from R2 through the CustomerPro API (licence terms in open question 5).
- An owner's own track gets beat detection in the engine (onset detection in Node; aubio-style, no Python). The owner confirms rights.

### D12. Export, allowance and publish

- **Preview export:** any time, watermarked, 720p, local only. No server call.
- **Final export:**
  1. `POST /exports {project_id, duration, preset}` → Laravel applies CustomerPro D12: within the monthly allowance, or credits charged. Re-export within 7 days is free, and so is the WhatsApp copy.
  2. Laravel returns an export grant (signed, single project, 7 days).
  3. The engine renders without the watermark: 1080×1920 H.264 at about 8 Mbps (about 60 MB a minute), AAC 192k, plus an optional WhatsApp copy under 16 MB.
- **Publish:** upload to the project's `renders/` (presign, multipart) → `renders.store` → `MediaAsset` (`for_social`) → visible in Media Library, posts and WhatsApp. CustomerPro's `video.max_render_bytes` rises to about 150 MB.
- **Honest limit:** a determined user can patch a desktop app to skip the watermark. The grant makes casual misuse impossible, and publishing (the step that matters for CustomerPro) is checked on the server.

### D13. Updates, signing, distribution

- Packaging: `electron-builder`.
  - macOS: `.dmg`, universal or arm64 plus x64, notarized with an Apple Developer ID.
  - Windows: NSIS `.exe`, signed with Azure Trusted Signing or an OV certificate.
- `electron-updater` with the generic provider on R2 (`releases/desktop/{channel}/latest*.yml`); channels `stable` and `beta`. Updates download in the background and install on restart. The server can require a minimum version (`/me` returns `min_version`).
- Download from the CustomerPro Video app (Projects tab, "Get the desktop app") and a public page.

### D14. Security

- The local Studio server binds to 127.0.0.1 on a random port with a per-launch token (DT.ly already does this). CORS is closed. The token is never written to `project.json`.
- No model keys on the device. The CustomerPro token lives in the OS keychain. Logs redact tokens.
- Agent tools are limited to the project folder and the raw files the owner added. No shell, no network tool.
- Signed builds only; auto-update verifies signatures.
- Crash reports: opt-in, no media, no project text.

### D15. Offline

- Editing, preview export, analysis cache reads and footage preparation work offline.
- The AI director, voiceover, final-export grants, sync and publish need a connection. The UI says which actions are waiting and runs them when the connection returns.

### D16. Minimum hardware and performance budget

- Minimum: Windows 10 22H2+ or macOS 13+, 8 GB RAM (16 GB recommended), 10 GB free disk.
- Targets on the reference laptop (i5 or Ryzen 5, 16 GB, integrated GPU):
  - import and pass-1 analysis of 120 clips: under 10 minutes;
  - preparing 22 segments: under 5 minutes;
  - final export of the KK Park reel: under 10 minutes.
- Measured in task 0.3 before phase 1 builds on them.

## Cost to us per reel (from the CustomerPro cost discussion)

| Step | Model | Estimate |
|---|---|---|
| Pass-1 analysis, about 120 clips | Haiku 5.5 | ₹10–20 |
| Speech-to-text, a few minutes | Sarvam | ₹3–10 |
| Plan, then build with `timeline.build` and blocks (~60 steps) | Sonnet 5.5 | about ₹170 (Opus about ₹300) |
| Edits, 2–3 rounds | Sonnet 5.5 | ₹40–80 |
| **Total** | | **₹220–300**; without D10, 2–3× more |

Rendering, preparation and storage of raw files cost us nothing: they run on the customer's machine.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| `skia-canvas` under Electron | Spike in task 0.1; fallback is a Node child process |
| HEVC decode on older Windows (HEVC extension missing) | Software decode fallback in the ffmpeg build; tell the user about the 10-bit drone setting |
| Export too slow on integrated GPUs | Parallel render workers = cores − 1; draft quality for previews; measure in 0.3 |
| Worker and Laravel usage drift (lost webhook) | Idempotent usage reports with ids; daily reconcile against the Anthropic usage API |
| Users patch out the watermark | Accepted; publishing is checked on the server |
| Pi is a small project | Pin the version, wrap it behind our interface, keep the loop small enough to own |
| Two editors on one project | Revision compare-and-set as on the web; conflict copy, never silent overwrite |
| Support load across PCs | Diagnostics export (logs, versions, GPU, no media); minimum specs stated at download |

## Open Questions

1. **Price of the app:** included with every plan that has Video (recommended), or Growth and up only?
2. **Name:** "CustomerPro Video" (assumed here) or something else?
3. **ffmpeg licence:** LGPL with OS codecs (assumed). Is `libx264` software encoding needed as a fallback on PCs without a hardware encoder? That needs a GPL review.
4. **Proxy:** Cloudflare Worker (recommended) or Laravel-only to start?
5. **Music:** which licensed library or source, and can customers use the tracks on Instagram and YouTube?
6. **Teams:** may two people in one workspace edit the same project (turn-based), or should a project be locked to one editor at a time?
7. **Raw media retention:** is the "never upload raw" default right, or should agencies be able to archive raw folders to R2 (charged per D14)?
