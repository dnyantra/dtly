// How the director changes project.json (D7 hooks "validate and save with a revision check"):
//  1. the tool runs on a staging copy next to project.json (same folder, so relative media paths resolve);
//  2. the result is checked: relative sources only, no deletion of layers/comps the owner made without the
//     owner's OK (asked in the UI), DT.ly validation warnings go back to the model;
//  3. commit is compare-and-set on the file's hash: if the owner saved in Studio meanwhile, the owner wins,
//     nothing is written, and the model is told to re-read the project and continue from it.
import fs from 'node:fs';
import path from 'node:path';
import {checkRelativeSources, projectFile, readJson, sha256, writeJsonAtomic} from '../projects.js';
import type {ToolOutput} from './agent.js';

export const STAGE_FILE = '.director-stage.json';
const CREATED_FILE = 'director/created.json';

type Proj = {comps?: {id: string; name?: string; layers?: {id: string; name?: string}[]}[]};
const items = (p: Proj) => {
  const m = new Map<string, string>();
  for (const c of p.comps ?? []) {
    m.set(`comp:${c.id}`, `comp "${c.name ?? c.id}"`);
    for (const l of c.layers ?? []) m.set(`layer:${c.id}/${l.id}`, `layer "${l.name ?? l.id}" in ${c.name ?? c.id}`);
  }
  return m;
};

export interface StoreOptions {
  confirm: (question: string, detail?: string) => Promise<boolean>;
  validate?: (project: unknown) => Promise<string[]> | string[];
  onCommit?: (hash: string) => void;
  onConflict?: () => void;
}

export class ProjectStore {
  private created: Set<string>;
  constructor(readonly dir: string, private o: StoreOptions) {
    this.created = new Set(readJson<string[]>(path.join(dir, CREATED_FILE), []));
  }
  get stagePath() { return path.join(this.dir, STAGE_FILE); }
  isAgentMade(key: string) { return this.created.has(key); }
  // The owner's layers/comps: everything that exists now and the director didn't create.
  ownerItems() { return [...items(readJson<Proj>(projectFile(this.dir), {})).keys()].filter((k) => !this.created.has(k)); }

  async mutate(run: (stagePath: string) => Promise<ToolOutput>): Promise<ToolOutput> {
    const file = projectFile(this.dir);
    const buf = fs.readFileSync(file);
    const h0 = sha256(buf);
    const before = JSON.parse(buf.toString()) as Proj;
    fs.writeFileSync(this.stagePath, buf);
    try {
      const out = await run(this.stagePath);
      if (out.isError) return out;
      const after = readJson<Proj | null>(this.stagePath, null);
      if (!after) return {content: [{type: 'text', text: 'Error: the change produced no project'}], isError: true};
      const bad = checkRelativeSources(after as never);
      if (bad.length) return {content: [{type: 'text', text: `Error: not applied. Layer sources must be files inside the project (media/…, vo/…, music/…), not ${bad.slice(0, 3).join(', ')}. Use segment_prepare, vo_generate or music_pick to bring media in.`}], isError: true};

      const b = items(before), a = items(after);
      const removedOwner = [...b.keys()].filter((k) => !a.has(k) && !this.created.has(k));
      if (removedOwner.length) {
        const names = removedOwner.map((k) => b.get(k)!);
        const ok = await this.o.confirm(`The director wants to delete ${names.length === 1 ? names[0] : `${names.length} things you made`}. Allow?`, names.join('\n'));
        if (!ok) return {content: [{type: 'text', text: `Not applied: the owner did not allow deleting ${names.join(', ')}. Keep them and reach the goal another way (hide, move or retime instead).`}], isError: true};
      }
      const warnings = (await this.o.validate?.(after)) ?? [];

      // Compare-and-set: the owner's save in Studio wins.
      if (sha256(fs.readFileSync(file)) !== h0) {
        this.o.onConflict?.();
        return {content: [{type: 'text', text: 'CONFLICT: the owner changed the project in Studio while you worked. Their version wins and your change was NOT applied. Call project_describe to re-read the project, then redo the change on the updated project if it still makes sense (keep what the owner did).'}], isError: true};
      }
      writeJsonAtomic(file, after);
      for (const k of a.keys()) if (!b.has(k)) this.created.add(k);
      for (const k of b.keys()) if (!a.has(k)) this.created.delete(k);
      writeJsonAtomic(path.join(this.dir, CREATED_FILE), [...this.created]);
      this.o.onCommit?.(sha256(fs.readFileSync(file)));
      if (warnings.length) out.content.push({type: 'text', text: `Saved, with validation warnings:\n${warnings.slice(0, 20).join('\n')}`});
      return out;
    } finally {
      fs.rmSync(this.stagePath, {force: true});
      fs.rmSync(`${this.stagePath}.tmp`, {force: true});
    }
  }
}
