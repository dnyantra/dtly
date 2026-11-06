# Spikes 0.1 and 0.2 (desktop shell, track B)

Measured on 2026-11-06 on an Apple M1 MacBook, macOS 26.1, Electron 45.2.3 (Node 24.22.2, ABI 150), DT.ly 0.3.1 `dist/`.
Windows and macOS x64 have **not** been run yet: they need real machines (task 0.3, reference laptop).

## 0.1 Electron + utilityProcess + DT.ly renderer + skia-canvas

**Result: works. The engine runs in a `utilityProcess` (D1). No `@electron/rebuild` is needed.**

- skia-canvas 4.x is a Rust/Neon **Node-API** addon (`@skia-canvas/<platform>/skia.node`, NAPI v10). Node-API is
  ABI-stable, so the prebuilt binary npm installs for Node also loads in Electron's utility process. `@electron/rebuild`
  has nothing to rebuild. (The design assumed a NAN/V8 addon; for this version the risk doesn't apply.)
- `renderVideoParallel` works inside the utility process, including the multi-worker path: DT.ly `fork()`s its own
  `cli.js chunk …`, and Electron's `child_process.fork` runs the Electron Helper binary in Node mode (`ELECTRON_RUN_AS_NODE`),
  so the chunks get the same Node and skia-canvas.
- The **child-process fallback** (Electron binary with `ELECTRON_RUN_AS_NODE=1`, not a separately shipped Node) is also
  implemented and passes the same test (`CPV_ENGINE=child`). It needs no extra runtime, so if a Windows machine has trouble
  with utility processes we switch with one env flag.
- Exports run in a further child (`dist/engine/render-child.js`, its own process group) so **cancel** kills the whole tree
  (render child, DT.ly chunk workers, ffmpeg). DT.ly's renderer has no abort signal.
- Packaged (asar): DT.ly and skia-canvas must be `asarUnpack`ed, and DT.ly must be **imported from `app.asar.unpacked`**.
  Otherwise DT.ly derives `…/app.asar/…/fonts/Baloo2.ttf` from `import.meta.url` and native skia-canvas can't open paths
  inside the asar ("Not a directory"). `src/engine/dtly.ts` does this.

| Test (`npm run test:engine-electron`, packaged self-test) | Result |
|---|---|
| Electron 45 dev, utilityProcess: create project → Studio check → 2 s 1080×1920 project → watermarked 720p MP4 | PASS, 0.9 s render |
| Electron 45 dev, child-process fallback, same | PASS, 0.8–1.2 s |
| Packaged unsigned `.app` (asar, LGPL ffmpeg), 2 s project | PASS, 1.0 s |
| Packaged, 12 s project (parallel chunk workers, 360 frames) | PASS, 2.1 s |
| Windows x64, macOS x64 | not run (no machines here) |

**Decision: utility process** (D1 as designed). Fallback stays in code behind `CPV_ENGINE=child`.

## 0.2 ffmpeg strategy

**Result: bundle an LGPL ffmpeg/ffprobe per platform in `resources/ffmpeg/<platform>-<arch>/`. The engine finds it
first and sets `DTLY_FFMPEG`/`DTLY_FFPROBE` (DT.ly honours them now); the system ffmpeg is a development fallback.**

`scripts/fetch-ffmpeg.mjs`:

- `--win`: BtbN `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip` (static, LGPL, ~130 MB per exe; recorded sha256
  `44ab22eb…b78f`). Placed in `resources/ffmpeg/win32-x64`. **Not executed here** (no Windows machine).
- `--mac-build`: builds FFmpeg 8.1 from source with `--disable-gpl --disable-nonfree --enable-videotoolbox
  --enable-audiotoolbox`, static libav*, min macOS 13. About 3 minutes on the M1. The result links only system
  frameworks (`otool -L`), 21 MB each, `lgpl: true`. The only H.264 encoder is `h264_videotoolbox`. There are no prebuilt
  LGPL macOS builds from a source we'd trust (evermeet/osxexperts are GPL), so we build our own. CI should do this per
  arch (arm64 now, x64 to do).
- `--from <url>` for an internal build on R2; `--system` copies the PATH ffmpeg (dev only, GPL and dylibs on Homebrew).

### HEVC decode of the KK Park drone footage

Clip: `DJI_20261101174018_0380_D.MP4`. HEVC Main 10, 3840×2160, 10-bit 4:2:0, 29.97 fps, 6.3 s, 189 frames (plus a DJI
mjpeg preview stream and data tracks, which the probe skips).

| Operation (6.3 s 4K HEVC 10-bit) | Time |
|---|---|
| Decode only, VideoToolbox (`-hwaccel videotoolbox`) | **1.71 s** (≈110 fps) |
| Decode only, software | 4.95 s (≈38 fps) |
| VT decode → scale/crop 1188×2112 → VT H.264 encode | 2.06 s |
| VT decode → scale/crop → libx264 CRF 16 (GPL build) | 9.34 s |
| `segment_prepare` 2.0–4.5 s + 0.7 s handles (3.9 s output), libx264 (GPL dev ffmpeg) | 7.2 s, 18.7 MB |
| `segment_prepare` same range, `h264_videotoolbox` q 74 (LGPL build) | **3.9 s**, 23.6 MB |

Hardware decode is on by default (`-hwaccel videotoolbox` on macOS, `d3d11va` on Windows, else `auto`). ffmpeg falls
back to software decode by itself if the hardware path fails; `CPV_NO_HWDECODE=1` forces software.
iPhone clips (HEVC 10-bit, 1920×1080 with −90° rotation side data) are read as 1080×1920 display size and auto-rotated.

### Findings that matter for D2 / DT.ly

1. **DT.ly's exporter hardcodes `-c:v libx264`** (`src/render/export.ts`), so an LGPL ffmpeg can't export at all. With the
   LGPL build, ffmpeg exits on the unknown encoder, and DT.ly then **crashes on an unhandled stdin `EPIPE`**, which hides
   ffmpeg's real error. Stopgap in the app: `dist/engine/encoder-shim.js` is loaded with `--import` into the export
   child (DT.ly's chunk workers inherit `execArgv`). It rewrites libx264 args to the platform encoder only when the ffmpeg
   in use lacks libx264. **DT.ly change requested:** an encoder option or env (`DTLY_H264_ENCODER`/args), plus handling of
   `EPIPE` on ffmpeg stdin so the real error surfaces.
   **Resolved (2026-11-06):** DT.ly now picks the encoder itself (`videoEncoder: 'auto'`, `DTLY_VIDEO_ENCODER`) and
   rejects with ffmpeg's stderr on EPIPE. The app's encoder shim is removed. Final exports render a CRF 16 master with
   DT.ly and re-encode it to ~8 Mbps in `src/engine/export-final.ts` (DT.ly's option is quality-based, not bitrate).
2. **The `eq` filter is GPL-only.** KK Park's `prep.mjs` grades (`eq=contrast:saturation:gamma`) fail on an LGPL build.
   `segment_prepare` rebuilds the "drone" and "phone" looks from LGPL filters (`lutyuv` for contrast and gamma, `hue=s=`,
   `colorbalance`, `unsharp`). They are visually equivalent; the check was a side-by-side frame from the drone clip.
   `drawtext` is also absent (no libfreetype), so contact sheets carry no burned-in timestamps; the times are returned as data.
3. CRF 16 has no exact VideoToolbox equivalent. `h264Args()` maps it to `-q:v 74` (VT), `-cq 18` (NVENC),
   `-global_quality 18` (QSV) and `cqp 16/18` (AMF), with `CPV_H264_ENCODER` to force one. The VT files are about 25%
   bigger than x264 CRF 16 at similar quality: fine for intermediates. **Open question 3 (libx264 fallback, GPL review)
   still stands** for PCs without a hardware encoder. LGPL builds then fall to `h264_mf` (Media Foundation) or fail clearly.
4. Windows hardware encode (Media Foundation, QSV, NVENC, AMF) is untested; it needs the reference laptop (0.2/0.3).
