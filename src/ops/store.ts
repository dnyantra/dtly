import fs from 'node:fs';
import path from 'node:path';
import type {Project} from '../core/model.js';

export const readProject = (file: string): Project => {
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
  if (p.dtly !== 1) throw new Error(`${file} is not a DT.ly project`);
  return p;
};

export const writeProject = (file: string, p: Project) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
};

// Load → mutate → save, so every edit is persisted atomically.
export const editProject = <T>(file: string, fn: (p: Project) => T): T => {
  const p = readProject(file);
  const r = fn(p);
  writeProject(file, p);
  return r;
};
