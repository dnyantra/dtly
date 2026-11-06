# Releasing CustomerPro Video (task 5.4, design D13)

Builds are made with `electron-builder` from a staged app folder (`scripts/stage.mjs`). Everything that makes a
build *official* (signing, notarization, the update feed, crash reports) comes from environment variables, read
by `electron-builder.config.cjs` and `scripts/build.mjs`. Without them you get an unsigned internal build with
auto-update and crash reporting switched off, exactly as before.

## 1. Accounts and certificates (one-time)

| What | Where | Who / cost | Used for |
|---|---|---|---|
| Apple Developer Program (organisation) | developer.apple.com | CustomerPro's legal entity, D-U-N-S number, US$99/yr | Developer ID |
| **Developer ID Application** certificate | Xcode or developer.apple.com → Certificates, exported as `.p12` with its private key | Account Holder creates it | Signing the macOS app (`CSC_LINK`) |
| App-specific password for an Apple ID in the team (or an App Store Connect API key, preferred) | appleid.apple.com / App Store Connect → Users and Access → Keys | any team member with the Developer role | Notarization |
| Azure subscription + **Trusted Signing** account and a *Public Trust* certificate profile | portal.azure.com → Trusted Signing | identity validation of CustomerPro (a few days), ~US$10/month | Signing the Windows installer |
| An Entra ID app registration (service principal) with the role *Trusted Signing Certificate Profile Signer* on the account | Entra ID → App registrations | Azure admin | `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` |
| *(alternative)* an OV code-signing certificate as `.pfx` | a CA (Sectigo, DigiCert…) | ~US$200–400/yr; SmartScreen reputation builds slowly | `WIN_CSC_LINK` instead of Azure |
| Cloudflare R2 bucket with a public custom domain, e.g. `downloads.customerpro.in` | Cloudflare dash → R2 | CustomerPro | Update feed and downloads |
| R2 API token with write access to that bucket | R2 → Manage API tokens | CustomerPro | Uploading releases (`aws s3` / `rclone`) |
| *(optional)* a crash-report collector that accepts Crashpad minidumps (Sentry / BugSplat / Backtrace, or your own endpoint) | the vendor | CustomerPro | `CPV_CRASH_URL` |

Keep the `.p12`, `.pfx`, passwords and client secrets in the CI secret store (or 1Password), never in the repo.

## 2. Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `CPV_UPDATE_URL` | `scripts/build.mjs` (baked into the app), `electron-builder.config.cjs` | Base URL of the feed, e.g. `https://downloads.customerpro.in/releases/desktop`. The app reads `<url>/<channel>/latest*.yml`. Empty → no auto-update. |
| `CPV_CHANNEL` | `electron-builder.config.cjs` | `stable` (default) or `beta`: which folder this build's `app-update.yml` and `latest*.yml` belong to. |
| `CPV_CRASH_URL` | `scripts/build.mjs` (baked in) | Crashpad submit URL. Empty → the "Send crash reports" toggle is unavailable. Even when set, reports are **opt-in** (Account → Send crash reports) and contain only the minidump, app version, channel and platform. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | electron-builder | Developer ID Application `.p12` (file path, https URL or base64) and its password. Or `CSC_NAME` for an identity already in the keychain. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | electron-builder (`@electron/notarize`) | Notarization. Alternative: `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | electron-builder (Azure Trusted Signing) | The service principal. |
| `CPV_AZURE_ENDPOINT`, `CPV_AZURE_ACCOUNT`, `CPV_AZURE_CERT_PROFILE`, `CPV_AZURE_PUBLISHER` | `electron-builder.config.cjs` | Trusted Signing endpoint (e.g. `https://eus.codesigning.azure.net`), account name, certificate profile name, and the publisher name exactly as in the certificate (`CN=…`). |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | electron-builder | Only if you use an OV `.pfx` instead of Azure. |

Run `CPV_BUILDER_DEBUG=1 npm run dist:mac` to print which of signing / notarization / Azure / feed are on.

Runtime-only overrides (for testing an installed build): `CPV_UPDATE_URL` and `CPV_CRASH_URL` in the
environment override the baked-in values; `CPV_UPDATE_DEV=1` lets a dev tree (`npm start`) run the updater.

## 3. Build

Prerequisites: DT.ly's `dist/` built in the repo root (`npm run build` there), the LGPL ffmpeg for the target in
`resources/ffmpeg/<platform>-<arch>/` (`npm run ffmpeg:fetch -- --mac-build` or `--win`).

1. Bump `version` in `apps/desktop/package.json` (semver; betas as `0.3.0-beta.1`).
2. macOS (on a Mac):
   ```sh
   export CPV_UPDATE_URL=https://downloads.customerpro.in/releases/desktop CPV_CHANNEL=stable
   export CSC_LINK=~/secrets/developer-id.p12 CSC_KEY_PASSWORD=…
   export APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=…
   npm run dist:mac
   ```
   Output in `release/`: `CustomerPro Video-<v>-arm64.dmg`, `CustomerPro Video-<v>-arm64-mac.zip`, their
   `.blockmap`s and `latest-mac.yml`. Check: `spctl -a -vv "release/mac-arm64/CustomerPro Video.app"` says
   *accepted, source=Notarized Developer ID*; `xcrun stapler validate` on the dmg passes.
   x64 Macs: add `x64` to the `arch` lists in `electron-builder.config.cjs` and fetch `resources/ffmpeg/darwin-x64`
   (built on an Intel Mac or with `arch -x86_64`), or build a `universal` target.
3. Windows (on Windows, or cross-built on a Mac for an unsigned build; Azure signing needs Windows or
   `osslsigncode`-capable CI):
   ```powershell
   $env:CPV_UPDATE_URL="https://downloads.customerpro.in/releases/desktop"; $env:CPV_CHANNEL="stable"
   $env:AZURE_TENANT_ID="…"; $env:AZURE_CLIENT_ID="…"; $env:AZURE_CLIENT_SECRET="…"
   $env:CPV_AZURE_ENDPOINT="https://eus.codesigning.azure.net"; $env:CPV_AZURE_ACCOUNT="customerpro"
   $env:CPV_AZURE_CERT_PROFILE="customerpro-public"; $env:CPV_AZURE_PUBLISHER="CustomerPro …"
   npm run dist:win
   ```
   Output: `CustomerPro-Video-Setup-<v>.exe`, `.blockmap`, `latest.yml`. Check the signature with
   `Get-AuthenticodeSignature`.
4. Smoke-test the packaged app before publishing: `node scripts/smoke.mjs --app "<path to the executable>"` and
   `CPV_SELFTEST=out.json "<executable>"` (packaged engine + final export).

Both scripts pass `--publish never`: electron-builder never uploads anything.

## 4. Publish to R2

Layout (one folder per channel; the app reads `<CPV_UPDATE_URL>/<channel>/`):

```
releases/desktop/stable/latest-mac.yml   latest.yml
releases/desktop/stable/CustomerPro Video-0.3.0-arm64-mac.zip (+ .blockmap)   …-arm64.dmg
releases/desktop/stable/CustomerPro-Video-Setup-0.3.0.exe (+ .blockmap)
releases/desktop/beta/…                  same, for beta builds
```

Upload the artifacts **first** and the `latest*.yml` **last** (clients follow the yml as soon as it changes):

```sh
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…   # R2 API token
R2=https://<account-id>.r2.cloudflarestorage.com
DEST=s3://customerpro-downloads/releases/desktop/stable
cd release
aws s3 cp . $DEST/ --endpoint-url $R2 --recursive --exclude "*" \
  --include "*.dmg" --include "*.zip" --include "*.exe" --include "*.blockmap"
aws s3 cp latest-mac.yml $DEST/ --endpoint-url $R2 --cache-control "no-cache"
aws s3 cp latest.yml     $DEST/ --endpoint-url $R2 --cache-control "no-cache"
```

(`rclone copy` works the same.) A Windows and a macOS build of one version may be published separately; each
platform only reads its own yml.

- **Beta:** build with `CPV_CHANNEL=beta`, upload to `…/beta/`. Owners who tick *Account → Get beta updates*
  read that folder. Promote a beta by rebuilding with `CPV_CHANNEL=stable` (the feed URL is inside the app).
- **Download page:** link the dmg/exe from `…/stable/` on the CustomerPro "Get the desktop app" page (task 5.5).
- **Rollback:** re-upload the previous version's `latest*.yml`. Clients already on the bad version stay there
  (`allowDowngrade` is off); ship a fixed higher version instead.
- **Forcing an update:** raise `video.desktop.min_version` in CustomerPro's config. `GET /me` returns it; older
  apps keep local editing but block sync, AI and publishing, fetch the update immediately and show
  "Restart to update" (or a link to the download page if the update can't be installed automatically).

## 5. Notes

- macOS auto-update only installs on **signed** builds (Squirrel.Mac checks the signature); unsigned internal
  builds show the update as an error and the owner downloads it by hand.
- The engine forks the Electron helper (`ELECTRON_RUN_AS_NODE`) and DT.ly's chunk workers; the hardened-runtime
  entitlements in `build-resources/entitlements.mac.plist` (JIT, unsigned executable memory, library validation
  off) cover them and the native skia-canvas addon. Test a signed build's final export before the first release.
- Crash reports: the app sends Crashpad minidumps only when the owner opted in. Configure the collector to drop
  attachments and to keep the `_version`, `channel`, `platform` fields. Report ids appear in the diagnostics export.
