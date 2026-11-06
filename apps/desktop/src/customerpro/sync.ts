// Project sync with CustomerPro (D9): rev compare-and-set. Push on save (debounced), pull on open,
// 409 → "changed on the web": load theirs, or keep mine as a copy. Never a silent overwrite.
import fs from 'node:fs';
import path from 'node:path';
import type {LinkFile} from '../shared/types.js';
import {checkRelativeSources, duplicateProject, projectFile, projectHash, readJson, readLink, sha256, writeJsonAtomic, writeLink} from '../engine/projects.js';
import {ApiError, CustomerProClient, NetworkError, type RemoteProject} from './client.js';

export type SyncStatus =
  | {state: 'unlinked'}
  | {state: 'synced'; rev: number; at: string}
  | {state: 'pending'} // a push is scheduled
  | {state: 'pushing'}
  | {state: 'offline'; message: string} // waiting for the connection; retried
  | {state: 'conflict'; localRev: number; remoteRev: number}
  | {state: 'error'; message: string}
  | {state: 'blocked'; message: string}; // signed out / no permission / update required

export interface SyncDeps {
  client: CustomerProClient;
  canSync: () => boolean;
  blockedReason?: () => string;
  onStatus?: (dir: string, s: SyncStatus) => void;
  debounceMs?: number;
  retryMs?: number;
}

const writeProjectJson = (dir: string, project: unknown) => {
  writeJsonAtomic(projectFile(dir), project);
  return projectHash(dir);
};

export class SyncManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private chains = new Map<string, Promise<unknown>>();
  private status = new Map<string, SyncStatus>();
  constructor(private d: SyncDeps) {}

  getStatus(dir: string): SyncStatus { return this.status.get(path.resolve(dir)) ?? (readLink(dir) ? {state: 'synced', rev: readLink(dir)!.rev, at: readLink(dir)!.lastSyncedAt ?? ''} : {state: 'unlinked'}); }
  private set(dir: string, s: SyncStatus) { this.status.set(path.resolve(dir), s); this.d.onStatus?.(path.resolve(dir), s); return s; }

  // One sync operation at a time per project.
  private serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(dir);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    return next;
  }

  private guard(dir: string) {
    if (!this.d.canSync()) { this.set(dir, {state: 'blocked', message: this.d.blockedReason?.() ?? 'Sync is not available'}); return false; }
    return true;
  }

  // Link a local folder to a CustomerPro project: an existing one (pull it) or a new one (push ours).
  async link(dir: string, o: {projectId?: number | string; orgId: number | string; name?: string; preset?: 'reel' | 'square' | 'portrait' | 'landscape'}) {
    return this.serial(dir, async () => {
      if (o.projectId !== undefined) {
        const remote = await this.d.client.getProject(o.projectId);
        const hash = writeProjectJson(dir, remote.project);
        writeLink(dir, {orgId: o.orgId, projectId: remote.id, rev: remote.rev, syncedHash: hash, lastSyncedAt: new Date().toISOString()});
        return this.set(dir, {state: 'synced', rev: remote.rev, at: new Date().toISOString()});
      }
      const local = readJson<{name?: string}>(projectFile(dir), {});
      const created = await this.d.client.createProject({name: o.name ?? local.name ?? path.basename(dir), preset: o.preset ?? 'reel'});
      writeLink(dir, {orgId: o.orgId, projectId: created.id, rev: created.rev, syncedHash: undefined});
      return this.pushNow(dir, true);
    });
  }

  unlink(dir: string) { writeLink(dir, undefined); return this.set(dir, {state: 'unlinked'}); }

  // Called on every save (Studio, director, tools). Debounced; offline saves are retried.
  schedulePush(dir: string) {
    const key = path.resolve(dir);
    if (!readLink(dir)) return;
    const link = readLink(dir)!;
    try { if (link.syncedHash && projectHash(dir) === link.syncedHash) return; } catch { return; }
    clearTimeout(this.timers.get(key));
    this.set(dir, {state: 'pending'});
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.push(dir).catch(() => undefined); }, this.d.debounceMs ?? 2000));
  }

  push(dir: string) { return this.serial(dir, () => this.pushNow(dir)); }

  private async pushNow(dir: string, force = false): Promise<SyncStatus> {
    const link = readLink(dir);
    if (!link) return this.set(dir, {state: 'unlinked'});
    if (!this.guard(dir)) return this.getStatus(dir);
    const raw = fs.readFileSync(projectFile(dir));
    const hash = sha256(raw);
    if (!force && hash === link.syncedHash) return this.set(dir, {state: 'synced', rev: link.rev, at: link.lastSyncedAt ?? ''});
    const project = JSON.parse(raw.toString('utf8'));
    const bad = checkRelativeSources(project);
    if (bad.length) return this.set(dir, {state: 'error', message: `These sources are not inside the project's media, vo or music folders: ${bad.slice(0, 3).join(', ')}`});
    this.set(dir, {state: 'pushing'});
    try {
      const r = await this.d.client.putProject(link.projectId, project, link.rev);
      const at = new Date().toISOString();
      writeLink(dir, {...link, rev: r.rev, syncedHash: hash, lastSyncedAt: at});
      return this.set(dir, {state: 'synced', rev: r.rev, at});
    } catch (e) {
      return this.failed(dir, e, link);
    }
  }

  private failed(dir: string, e: unknown, link: LinkFile): SyncStatus {
    if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
      return this.set(dir, {state: 'conflict', localRev: link.rev, remoteRev: Number(e.body.rev ?? NaN)});
    }
    if (e instanceof NetworkError) {
      const key = path.resolve(dir);
      clearTimeout(this.timers.get(key));
      this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.push(dir).catch(() => undefined); }, this.d.retryMs ?? 30000));
      return this.set(dir, {state: 'offline', message: 'Waiting for the connection; changes will sync when it is back'});
    }
    return this.set(dir, {state: 'error', message: (e as Error).message});
  }

  // On open: newer on the web and unchanged here → load it; changed here only → push; both → conflict.
  pull(dir: string) {
    return this.serial(dir, async (): Promise<SyncStatus> => {
      const link = readLink(dir);
      if (!link) return this.set(dir, {state: 'unlinked'});
      if (!this.guard(dir)) return this.getStatus(dir);
      let remote: RemoteProject;
      try { remote = await this.d.client.getProject(link.projectId); } catch (e) { return this.failed(dir, e, link); }
      const localChanged = !link.syncedHash || projectHash(dir) !== link.syncedHash;
      const remoteChanged = remote.rev !== link.rev;
      if (remoteChanged && localChanged) return this.set(dir, {state: 'conflict', localRev: link.rev, remoteRev: remote.rev});
      if (remoteChanged) {
        const hash = writeProjectJson(dir, remote.project);
        const at = new Date().toISOString();
        writeLink(dir, {...link, rev: remote.rev, syncedHash: hash, lastSyncedAt: at});
        return this.set(dir, {state: 'synced', rev: remote.rev, at});
      }
      if (localChanged) return this.pushNow(dir);
      return this.set(dir, {state: 'synced', rev: link.rev, at: link.lastSyncedAt ?? ''});
    });
  }

  // "Changed on the web": theirs → load the web version; keep-mine → save ours as a new local project, then load theirs.
  resolveConflict(dir: string, choice: 'theirs' | 'keep-mine') {
    return this.serial(dir, async () => {
      const link = readLink(dir);
      if (!link) throw new Error('Project is not linked');
      let copy: string | undefined;
      if (choice === 'keep-mine') {
        const name = readJson<{name?: string}>(projectFile(dir), {}).name ?? path.basename(dir);
        copy = duplicateProject(dir, `${name} (desktop copy)`);
      }
      const remote = await this.d.client.getProject(link.projectId);
      const hash = writeProjectJson(dir, remote.project);
      const at = new Date().toISOString();
      writeLink(dir, {...link, rev: remote.rev, syncedHash: hash, lastSyncedAt: at});
      this.set(dir, {state: 'synced', rev: remote.rev, at});
      return {copy};
    });
  }

  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
