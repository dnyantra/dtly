// electron-builder config (tasks 2.8 and 5.4). Signing, notarization and the update feed are driven by the
// environment, so a plain `npm run dist:mac` / `dist:win` on a dev machine still makes an unsigned build.
// See RELEASING.md for the accounts, certificates and commands.
//
//   macOS signing:      CSC_LINK (+ CSC_KEY_PASSWORD) = Developer ID Application .p12, or CSC_NAME = a
//                       keychain identity. Without either: unsigned (identity null).
//   macOS notarization: APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//                       (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER). Only when signing.
//   Windows signing:    Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and
//                       CPV_AZURE_ENDPOINT, CPV_AZURE_ACCOUNT, CPV_AZURE_CERT_PROFILE, CPV_AZURE_PUBLISHER.
//                       Or an OV .pfx: WIN_CSC_LINK (+ WIN_CSC_KEY_PASSWORD), picked up by electron-builder.
//   Update feed:        CPV_UPDATE_URL (e.g. https://downloads.customerpro.in/releases/desktop) and
//                       CPV_CHANNEL = stable | beta → app-update.yml points at <url>/<channel>, and
//                       latest*.yml is written next to the artifacts for upload to R2.
const env = process.env;
const has = (...keys) => keys.every((k) => !!env[k]);

const macSign = has('CSC_LINK') || has('CSC_NAME');
const notarize = macSign && (has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID') || has('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'));
const azure = has('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'CPV_AZURE_ENDPOINT', 'CPV_AZURE_ACCOUNT', 'CPV_AZURE_CERT_PROFILE', 'CPV_AZURE_PUBLISHER');
const channel = env.CPV_CHANNEL === 'beta' ? 'beta' : 'stable';
const updateUrl = (env.CPV_UPDATE_URL || '').replace(/\/+$/, '');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'in.customerpro.video',
  productName: 'CustomerPro Video',
  copyright: 'Copyright © CustomerPro',
  electronVersion: '45.2.3',
  directories: {app: 'build/stage', output: 'release', buildResources: 'build-resources'},
  files: ['dist/**', 'node_modules/**', 'package.json'],
  asar: true,
  // Native skia-canvas and DT.ly (it forks its own CLI for parallel render chunks) stay outside the asar.
  asarUnpack: ['node_modules/@dnyantra/dtly/**', 'node_modules/skia-canvas/**', 'node_modules/@skia-canvas/**', 'node_modules/pdfjs-dist/**', 'node_modules/@napi-rs/**'],
  npmRebuild: false,
  protocols: [{name: 'CustomerPro Video', schemes: ['customerpro-video']}],
  mac: {
    // LGPL ffmpeg/ffprobe per target (scripts/fetch-ffmpeg.mjs).
    extraResources: [{from: 'resources/ffmpeg/darwin-${arch}', to: 'ffmpeg/darwin-${arch}'}],
    // dmg to install; zip is what electron-updater (Squirrel.Mac) downloads.
    target: [{target: 'dmg', arch: ['arm64']}, {target: 'zip', arch: ['arm64']}],
    category: 'public.app-category.video',
    minimumSystemVersion: '13.0',
    ...(macSign
      ? {hardenedRuntime: true, gatekeeperAssess: false, entitlements: 'build-resources/entitlements.mac.plist', entitlementsInherit: 'build-resources/entitlements.mac.plist', notarize}
      : {identity: null, hardenedRuntime: false, notarize: false}),
  },
  dmg: {title: 'CustomerPro Video ${version}'},
  win: {
    extraResources: [{from: 'resources/ffmpeg/win32-${arch}', to: 'ffmpeg/win32-${arch}'}],
    target: [{target: 'nsis', arch: ['x64']}],
    ...(azure ? {azureSignOptions: {
      publisherName: env.CPV_AZURE_PUBLISHER,
      endpoint: env.CPV_AZURE_ENDPOINT,
      codeSigningAccountName: env.CPV_AZURE_ACCOUNT,
      certificateProfileName: env.CPV_AZURE_CERT_PROFILE,
    }} : {}),
    // With an update feed and a known publisher, electron-updater checks the installer's signature.
    ...(env.CPV_AZURE_PUBLISHER ? {verifyUpdateCodeSignature: true} : {verifyUpdateCodeSignature: false}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'CustomerPro-Video-Setup-${version}.${ext}',
  },
  // Generic provider on R2, one folder per channel. electron-builder only writes the files (always run with
  // --publish never); RELEASING.md uploads them.
  publish: updateUrl ? [{provider: 'generic', url: `${updateUrl}/${channel}`, channel: 'latest'}] : null,
};

if (require.main === module || env.CPV_BUILDER_DEBUG) {
  console.log(`[electron-builder] mac signing ${macSign ? 'on' : 'off'}, notarize ${notarize ? 'on' : 'off'}, windows azure signing ${azure ? 'on' : 'off'}, update feed ${updateUrl ? `${updateUrl}/${channel}` : 'none'}`);
}
