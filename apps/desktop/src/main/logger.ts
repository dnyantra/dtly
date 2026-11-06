// Main-process log: a rotating file in userData/logs plus a ring buffer for diagnostics. Tokens are redacted.
import fs from 'node:fs';
import path from 'node:path';
import {redact} from '../shared/misc.js';

const ring: string[] = [];
let file: string | undefined;

export const initLog = (dir: string) => {
  fs.mkdirSync(dir, {recursive: true});
  file = path.join(dir, 'main.log');
  try { if (fs.statSync(file).size > 5e6) fs.renameSync(file, `${file}.1`); } catch { /* new */ }
};

export const log = (level: 'info' | 'warn' | 'error', ...parts: unknown[]) => {
  const msg = redact(parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  ring.push(line);
  if (ring.length > 2000) ring.splice(0, ring.length - 2000);
  if (file) { try { fs.appendFileSync(file, `${line}\n`); } catch { /* disk full */ } }
  if (process.env.CPV_LOG_STDOUT) console.log(line);
};

export const logTail = (n = 500) => ring.slice(-n);
export const logFile = () => file;
