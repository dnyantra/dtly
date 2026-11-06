// Pass-1 analysis cache (D8, task 4.2): one JSON per content hash in a folder shared by every project
// (~/CustomerPro Video/.cache/analysis/<hash>.json), mirrored into the project's analysis.json (`ai`).
// The same clip in a second project is analysed at once, with no credits.
import fs from 'node:fs';
import path from 'node:path';
import type {AnalysisEntry} from '../../shared/types.js';
import type {ClipAnalysis} from '../../shared/director.js';
import {readAnalysis} from '../footage.js';
import {ANALYSIS_FILE, defaultProjectsRoot, readJson, writeJsonAtomic} from '../projects.js';

export const sharedCacheDir = (projectsRoot?: string) => path.join(projectsRoot ?? defaultProjectsRoot(), '.cache', 'analysis');
const safe = (hash: string) => { if (!/^[a-f0-9]{16,128}$/i.test(hash)) throw new Error('bad hash'); return hash; };

export const readShared = (cacheDir: string, hash: string) => readJson<ClipAnalysis | undefined>(path.join(cacheDir, `${safe(hash)}.json`), undefined);
export const writeShared = (cacheDir: string, hash: string, a: ClipAnalysis) => writeJsonAtomic(path.join(cacheDir, `${safe(hash)}.json`), a);

export const setProjectAi = (dir: string, hash: string, patch: Partial<ClipAnalysis>) => {
  const a = readAnalysis(dir);
  const prev = (a.byHash[hash]?.ai ?? {}) as Partial<ClipAnalysis>;
  a.byHash[hash] = {...a.byHash[hash], ai: {...prev, ...patch}, updatedAt: new Date().toISOString()} as AnalysisEntry;
  writeJsonAtomic(path.join(dir, ANALYSIS_FILE), a);
  return a.byHash[hash].ai as ClipAnalysis;
};
export const projectAi = (dir: string, hash: string) => readAnalysis(dir).byHash[hash]?.ai as ClipAnalysis | undefined;

export const hasShared = (cacheDir: string, hash: string) => fs.existsSync(path.join(cacheDir, `${safe(hash)}.json`));
