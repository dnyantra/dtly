// Opt-in crash reporting (task 5.6, D14). Electron's crashReporter (Crashpad minidumps) sent to a configurable
// submit URL: CPV_CRASH_URL at run time, or baked in at build time (scripts/build.mjs). Off by default; with no
// URL the toggle is unavailable. Reports carry only the minidump plus app version, channel and platform:
// no project names, no project text, no media, no paths, no account data.
import {app, crashReporter} from 'electron';
import {log} from './logger.js';

declare const __CPV_CRASH_URL__: string | undefined;
export const crashSubmitUrl = () => process.env.CPV_CRASH_URL || (typeof __CPV_CRASH_URL__ === 'string' ? __CPV_CRASH_URL__ : '') || '';

let started = false;

// Called before app ready with the stored choice, and again whenever the owner flips the toggle.
export const applyCrashReporting = (enabled: boolean, extra: {channel: string}) => {
  const url = crashSubmitUrl();
  if (!url) return {available: false, enabled: false};
  try {
    if (enabled && !started) {
      crashReporter.start({
        submitURL: url,
        productName: 'CustomerPro Video',
        companyName: 'CustomerPro',
        uploadToServer: true,
        compress: true,
        rateLimit: true,
        ignoreSystemCrashHandler: true,
        // Only these fields; never project, media or account data.
        globalExtra: {_version: app.getVersion(), channel: extra.channel, platform: `${process.platform}-${process.arch}`},
      });
      started = true;
      log('info', 'crash reporting on');
    } else if (started) {
      crashReporter.setUploadToServer(enabled);
      log('info', `crash reporting ${enabled ? 'on' : 'off'}`);
    }
  } catch (e) { log('warn', 'crash reporter', e); }
  return {available: true, enabled};
};

// For the diagnostics export: report ids only, so support can find a crash the owner sent.
export const crashSummary = () => {
  if (!started) return {enabled: false, configured: !!crashSubmitUrl()};
  try {
    return {enabled: crashReporter.getUploadToServer(), uploaded: crashReporter.getUploadedReports().slice(-10).map((r) => ({id: r.id, date: r.date}))};
  } catch { return {enabled: true}; }
};
