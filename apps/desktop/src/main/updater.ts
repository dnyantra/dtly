// Auto-update (task 5.4, D13): electron-updater with the generic provider on R2.
//   feed = <CPV_UPDATE_URL>/<channel>/   (latest.yml / latest-mac.yml + artifacts; channel = stable | beta)
// CPV_UPDATE_URL comes from the environment or is baked in at build time (scripts/build.mjs). Updates download
// in the background and install on restart ("Restart to update"); when GET /me's min_version is above this
// version, the main process asks for a check right away. Disabled in development, self-tests and builds
// without a feed URL. macOS installs only work on signed builds (Squirrel.Mac checks the signature).
import {EventEmitter} from 'node:events';
import {app} from 'electron';
import type {UpdateChannel, UpdaterStatus} from '../shared/publish.js';
import {log} from './logger.js';

declare const __CPV_UPDATE_URL__: string | undefined;
export const updateFeedBase = () => (process.env.CPV_UPDATE_URL || (typeof __CPV_UPDATE_URL__ === 'string' ? __CPV_UPDATE_URL__ : '') || '').replace(/\/+$/, '');
export const feedUrl = (channel: UpdateChannel) => `${updateFeedBase()}/${channel}`;

type AutoUpdater = typeof import('electron-updater').autoUpdater;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export class UpdateManager extends EventEmitter {
  private u?: AutoUpdater;
  private status: UpdaterStatus;
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(private channel: UpdateChannel) {
    super();
    this.status = {state: 'idle', channel, current: app.getVersion()};
  }

  get(): UpdaterStatus { return {...this.status}; }
  private set(s: Partial<UpdaterStatus>) {
    this.status = {...this.status, ...s, channel: this.channel, current: app.getVersion()};
    this.emit('status', this.get());
  }

  private disabledReason() {
    if (process.env.CPV_SELFTEST || process.env.CPV_SMOKE) return 'Updates are off in tests';
    if (!updateFeedBase()) return 'This build has no update feed (CPV_UPDATE_URL)';
    if (!app.isPackaged && !process.env.CPV_UPDATE_DEV) return 'Updates are off in development';
    return undefined;
  }

  async start() {
    const reason = this.disabledReason();
    if (reason) { this.set({state: 'disabled', message: reason}); log('info', `updater: ${reason}`); return; }
    const mod = (await import('electron-updater')) as unknown as {autoUpdater?: AutoUpdater; default?: {autoUpdater: AutoUpdater}};
    const u = mod.autoUpdater ?? mod.default!.autoUpdater;
    this.u = u;
    u.logger = {info: (m: unknown) => log('info', `[updater] ${m}`), warn: (m: unknown) => log('warn', `[updater] ${m}`), error: (m: unknown) => log('error', `[updater] ${m}`), debug: () => undefined};
    if (!app.isPackaged) u.forceDevUpdateConfig = true; // CPV_UPDATE_DEV: try the flow from a dev tree
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    this.configure();
    u.on('checking-for-update', () => this.set({state: 'checking', message: undefined}));
    u.on('update-not-available', () => this.set({state: 'none', version: undefined, percent: undefined}));
    u.on('update-available', (i) => this.set({state: 'downloading', version: i.version, percent: 0}));
    u.on('download-progress', (p) => this.set({state: 'downloading', percent: Math.round(p.percent)}));
    u.on('update-downloaded', (i) => this.set({state: 'ready', version: i.version, percent: 100}));
    u.on('error', (e) => { this.checking = false; this.set({state: 'error', message: (e as Error).message.split('\n')[0]}); });
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  private configure() {
    if (!this.u) return;
    this.u.allowPrerelease = this.channel === 'beta';
    this.u.setFeedURL({provider: 'generic', url: feedUrl(this.channel)});
  }

  async check() {
    if (!this.u || this.checking || this.status.state === 'ready') return this.get();
    this.checking = true;
    try { await this.u.checkForUpdates(); } catch (e) { this.set({state: 'error', message: (e as Error).message.split('\n')[0]}); } finally { this.checking = false; }
    return this.get();
  }

  setChannel(channel: UpdateChannel) {
    if (channel === this.channel) return;
    this.channel = channel;
    this.configure();
    this.set({});
    void this.check();
  }

  // "Restart to update": quits, installs, relaunches.
  install() {
    if (!this.u || this.status.state !== 'ready') throw new Error('No update is ready');
    log('info', `installing update ${this.status.version}`);
    setImmediate(() => this.u!.quitAndInstall(false, true));
  }

  stop() { clearInterval(this.timer); }
}
