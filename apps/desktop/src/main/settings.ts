// App settings in userData/settings.json: update channel, crash-report opt-in, the last export price seen.
import fs from 'node:fs';
import path from 'node:path';
import type {UpdateChannel} from '../shared/publish.js';

export interface StoredSettings { updateChannel: UpdateChannel; crashReports: boolean; lastExportPrice?: number }
const DEFAULTS: StoredSettings = {updateChannel: 'stable', crashReports: false};

export class SettingsStore {
  private cache?: StoredSettings;
  constructor(private dir: string) {}
  private get file() { return path.join(this.dir, 'settings.json'); }
  get(): StoredSettings {
    if (!this.cache) {
      let s: Partial<StoredSettings> = {};
      try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredSettings>; } catch { /* first run */ }
      this.cache = {
        ...DEFAULTS,
        updateChannel: s.updateChannel === 'beta' ? 'beta' : 'stable',
        crashReports: s.crashReports === true,
        lastExportPrice: typeof s.lastExportPrice === 'number' && s.lastExportPrice > 0 ? s.lastExportPrice : undefined,
      };
    }
    return {...this.cache};
  }
  set(patch: Partial<StoredSettings>) {
    const next = {...this.get(), ...patch};
    this.cache = next;
    fs.mkdirSync(this.dir, {recursive: true});
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return {...next};
  }
}
