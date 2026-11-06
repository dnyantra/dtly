// The CustomerPro session in the main process: device sign-in, token in safeStorage, GET /me on start and
// hourly, access gating. Offline: the last /me (no token in it) is used so local editing keeps working (D15).
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ApiError, CustomerProClient, NetworkError, type DeviceStart} from '../customerpro/client.js';
import {signInWithDeviceCode} from '../customerpro/device-auth.js';
import {computeAccess} from '../customerpro/gating.js';
import type {Access, Me} from '../shared/types.js';
import {log} from './logger.js';
import {TokenStore} from './token-store.js';

export interface AccountState {
  signedIn: boolean;
  me?: Me;
  access: Access;
  online: boolean;
  signIn?: {user_code: string; verification_url: string; expires_at: number} | {error: string};
  baseUrl: string;
}

export class AccountManager extends EventEmitter {
  readonly client: CustomerProClient;
  private tokens: TokenStore;
  private me?: Me;
  private online = true;
  private signIn?: AccountState['signIn'];
  private signInAbort?: AbortController;
  private timer?: NodeJS.Timeout;

  constructor(private dir: string, private appVersion: string, baseUrl?: string) {
    super();
    this.tokens = new TokenStore(dir);
    this.client = new CustomerProClient({
      baseUrl,
      getToken: () => this.tokens.load()?.token,
      onUnauthorized: () => this.localSignOut('Your session ended (signed out or device revoked on CustomerPro)'),
    });
  }

  async init() {
    await this.tokens.init();
    if (this.tokens.load()) this.me = this.readCachedMe();
  }

  private get meFile() { return path.join(this.dir, 'me.json'); }
  private readCachedMe(): Me | undefined { try { return JSON.parse(fs.readFileSync(this.meFile, 'utf8')) as Me; } catch { return undefined; } }

  state(): AccountState {
    const signedIn = !!this.tokens.load();
    return {signedIn, me: signedIn ? this.me : undefined, access: computeAccess(signedIn ? this.me : undefined, this.appVersion), online: this.online, signIn: this.signIn, baseUrl: this.client.baseUrl};
  }
  access() { return this.state().access; }
  private changed() { this.emit('changed', this.state()); }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60 * 60 * 1000);
  }
  stop() { clearInterval(this.timer); this.signInAbort?.abort(); }

  async refresh() {
    if (!this.tokens.load()) { this.changed(); return this.state(); }
    try {
      this.me = await this.client.me();
      this.online = true;
      fs.mkdirSync(this.dir, {recursive: true});
      fs.writeFileSync(this.meFile, JSON.stringify(this.me));
    } catch (e) {
      if (e instanceof NetworkError) { this.online = false; log('warn', 'offline: using the last account state'); }
      else if (!(e instanceof ApiError && e.status === 401)) log('error', 'GET /me failed', e);
    }
    this.changed();
    return this.state();
  }

  async startSignIn(openUrl: (url: string) => void) {
    this.signInAbort?.abort();
    const ac = new AbortController();
    this.signInAbort = ac;
    this.signIn = undefined;
    try {
      const token = await signInWithDeviceCode(this.client, {
        deviceName: `${os.hostname().replace(/\.local$/, '')} (CustomerPro Video)`,
        platform: process.platform === 'win32' ? 'win' : 'mac',
        appVersion: this.appVersion,
        signal: ac.signal,
        onCode: (s: DeviceStart) => {
          this.signIn = {user_code: s.user_code, verification_url: s.verification_url, expires_at: Date.now() + s.expires_in * 1000};
          this.changed();
          openUrl(s.verification_url);
        },
      });
      if (!(await this.tokens.save(token))) log('warn', 'OS encryption unavailable: the session is kept in memory only');
      this.signIn = undefined;
      log('info', `signed in as user ${token.user.id} in workspace ${token.workspace.id}`);
      await this.refresh();
    } catch (e) {
      log('warn', `sign-in failed: ${(e as Error).message}`);
      this.signIn = (e as {code?: string}).code === 'cancelled' ? undefined : {error: (e as Error).message};
      this.changed();
    } finally { if (this.signInAbort === ac) this.signInAbort = undefined; }
    return this.state();
  }

  cancelSignIn() { this.signInAbort?.abort(); this.signIn = undefined; this.changed(); }

  async signOut() {
    try { if (this.tokens.load()) await this.client.logout(); } catch (e) { log('warn', 'logout call failed (signing out locally)', e); }
    this.localSignOut();
  }

  // Local projects stay on disk; only the session goes.
  private localSignOut(reason?: string) {
    this.tokens.clear();
    this.me = undefined;
    fs.rmSync(this.meFile, {force: true});
    if (reason) { log('warn', reason); this.signIn = {error: reason}; }
    this.changed();
  }
}
