// The CustomerPro session token, encrypted with Electron safeStorage (Keychain on macOS, DPAPI on Windows; D5/D14).
// Loaded once at start (async safeStorage API) and kept in memory; never written in clear text.
import fs from 'node:fs';
import path from 'node:path';
import {safeStorage} from 'electron';
import type {TokenResult} from '../customerpro/client.js';

export class TokenStore {
  private memory?: TokenResult;
  private encryption = false;
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, 'session.bin'); }

  async init() {
    this.encryption = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
    if (!this.encryption || !fs.existsSync(this.file)) return;
    try {
      const r = await safeStorage.decryptStringAsync(fs.readFileSync(this.file));
      this.memory = JSON.parse(r.result) as TokenResult;
      if (r.shouldReEncrypt) await this.save(this.memory);
    } catch { this.memory = undefined; }
  }

  load(): TokenResult | undefined { return this.memory; }

  // Returns false when the OS has no encryption: then the session lasts only until the app quits.
  async save(t: TokenResult) {
    this.memory = t;
    if (!this.encryption) return false;
    fs.mkdirSync(this.dir, {recursive: true});
    fs.writeFileSync(this.file, await safeStorage.encryptStringAsync(JSON.stringify(t)), {mode: 0o600});
    return true;
  }

  clear() { this.memory = undefined; fs.rmSync(this.file, {force: true}); }
}
