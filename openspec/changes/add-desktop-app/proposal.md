# Add the CustomerPro Video desktop app

## Why

The KK Park reel (`~/Video/kkpark`) shows what customers want: a folder of raw drone and phone footage plus a brief becomes a 60-second, beat-cut, voiced, motion-graphics reel. Claude Code made it with DT.ly, ffmpeg and the local renderer. The web Video app in CustomerPro can't do that job well yet:

- 4K HEVC drone footage doesn't decode in every browser, and 22 live 4K layers are too heavy to edit in a tab.
- A 3.2 GB raw folder would have to be uploaded before anything happens.
- Export in the browser (WebCodecs, single tab) is slow with glow, blur and mattes, and still to be built.
- The AI director would need DT.ly's tools rebuilt to run in the browser.

On a desktop all four are already solved: DT.ly's Node renderer, its local Studio server, its MCP tools and ffmpeg all run there today. Wrapping them in an installable app gets customers a KK Park-quality reel sooner than finishing the hardest parts of the web version.

## What Changes

- **New installable app, "CustomerPro Video"**, for Windows and macOS, built with Electron in this repo (`apps/desktop`). It is a CustomerPro product: signing in with a CustomerPro account (Video app installed, `video.*` permissions) is required.
- **Local-first projects.** Raw footage stays where it is on disk; the app analyses it in place, then prepares only the chosen segments (trim, crop to vertical, convert to H.264) into the project folder.
- **The same Studio editor** as the web app (one bundle, embed config), served by DT.ly's local server.
- **AI director on the desktop**: the agent loop (Pi `pi-agent-core`) runs in the app with DT.ly's tools in-process and local footage tools (contact sheets, frames, audio). Every model call goes through a CustomerPro-owned proxy that holds the keys, owns the system prompt, enforces limits and charges credits.
- **Higher-level building blocks in DT.ly core** (from KK Park's `gfx.mjs`/`build.mjs`): graphic blocks as presets and a timeline tool that builds the shot sequence, beat-snapped cuts, transitions, voiceover placement and ducking. The web app gets these too.
- **Music library** with beat grids precomputed.
- **Local export** with DT.ly's parallel renderer; **publish** sends the MP4 (and a WhatsApp-size copy) to the CustomerPro Media Library, counted against the plan's monthly videos or charged per CustomerPro D12.
- **Project sync** with CustomerPro: the same project opens on the web and on the desktop ("Open in desktop app").
- **Signed installers and auto-update**, downloaded from the CustomerPro Video app.

CustomerPro-side work (desktop API, device sign-in, model proxy, sync, download page) is listed here as dependencies and planned in the CustomerPro repo's `add-video-app` change (D16, tasks section D).

## Capabilities

### New Capabilities
- `desktop-shell`: install, sign in, home, project folders, Studio window, updates, security.
- `footage`: import raw media in place, analyse it, prepare chosen segments, music library.
- `director`: brief → analysis → plan → build → check frames → edit, through the CustomerPro proxy.
- `customerpro-link`: device sign-in, plan and permission checks, project and media sync, open-in-desktop.
- `export-publish`: local render, export allowance and charging, publish to Media Library.
- `blocks-timeline`: DT.ly presets for real-estate/promo graphic blocks and the timeline builder.

### Modified Capabilities
- None in DT.ly's published behaviour; the blocks and timeline are additions. The Studio embed config (0.3.1) is reused unchanged.

## Impact

- **DT.ly repo:** new `apps/desktop` (Electron), new presets in `src/presets/`, the tools in `src/mcp/server.ts` split into a shared `src/tools/` module used by both MCP and the desktop agent.
- **CustomerPro:** new `api/desktop/v1` routes (pattern of `routes/mobile.php`: Sanctum tokens with a `desktop` ability, device records), a device sign-in page, the model proxy, project sync endpoints, relative `media/…` sources allowed by `VideoSrcGuard`, a download page, and a Settings → Devices entry.
- **Infrastructure:** Cloudflare Worker for the model proxy (recommended, D6), R2 bucket path for release files, Apple Developer account, Windows code signing.
- **Cost:** about 8–9 weeks for one developer to the pilot (tasks.md), plus about $99/year Apple and about $120–400/year Windows signing.

## Acceptance test

On a mid-range Windows laptop (Core i5 or Ryzen 5, 16 GB RAM, no discrete GPU), starting from the KK Park raw folder, the logo and a written brief, an owner gets an approved 60-second 1080×1920 reel published to their Media Library:

- within 3 rounds of edits,
- for under ₹300 of model cost to us,
- with export taking under 10 minutes.
