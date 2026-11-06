// ffmpeg helpers for the director's footage and audio tools (all LGPL filters, D2).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ffmpegPath, hwDecodeArgs, probe, run} from '../ffmpeg.js';
import {CACHE_DIR} from '../projects.js';

export const scratch = (dir: string, name: string) => {
  const d = path.join(dir, CACHE_DIR, 'director');
  fs.mkdirSync(d, {recursive: true});
  return path.join(d, name);
};
const tag = () => crypto.randomBytes(4).toString('hex');

// Frames at the given times in one PNG grid (cells 16:9, letterboxed). Used by media_sheet / media_frames.
export const framesSheet = async (dir: string, file: string, times: number[], o: {signal?: AbortSignal; width?: number} = {}) => {
  const n = times.length;
  const cols = n <= 3 ? n : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const W = o.width ?? 1280;
  const cw = Math.floor(W / cols / 2) * 2, ch = Math.floor((cw * 9) / 16 / 2) * 2;
  const out = scratch(dir, `frames-${tag()}.png`);
  const inputs = times.flatMap((t) => [...hwDecodeArgs(), '-ss', Math.max(0, t).toFixed(3), '-i', file]);
  const cells = times.map((_, i) => `[${i}:v:0]trim=end_frame=1,scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24[c${i}]`);
  for (let i = n; i < rows * cols; i++) cells.push(`color=c=black:s=${cw}x${ch}:d=0.04,format=rgb24,trim=end_frame=1[c${i}]`);
  const rowF = [...Array(rows).keys()].map((r) => (cols === 1 ? `[c${r}]copy[r${r}]` : `${[...Array(cols).keys()].map((c) => `[c${r * cols + c}]`).join('')}hstack=inputs=${cols}[r${r}]`));
  const final = rows === 1 ? '[r0]copy[out]' : `${[...Array(rows).keys()].map((r) => `[r${r}]`).join('')}vstack=inputs=${rows}[out]`;
  await run(ffmpegPath(), ['-v', 'error', '-y', ...inputs, '-filter_complex', [...cells, ...rowF, final].join(';'), '-map', '[out]', '-frames:v', '1', out], {signal: o.signal});
  return out;
};

// A photo scaled to fit 1024 px (PNG), for the model.
export const downscaleImage = async (dir: string, file: string, max = 1024, signal?: AbortSignal) => {
  const out = scratch(dir, `img-${tag()}.png`);
  await run(ffmpegPath(), ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`, out], {signal});
  return out;
};

// 16 kHz mono WAV of a range (for speech-to-text).
export const extractRange = async (dir: string, file: string, from?: number, to?: number, signal?: AbortSignal) => {
  const out = scratch(dir, `audio-${tag()}.wav`);
  const range = [...(from !== undefined ? ['-ss', from.toFixed(3)] : []), ...(to !== undefined ? ['-t', (to - (from ?? 0)).toFixed(3)] : [])];
  await run(ffmpegPath(), ['-v', 'error', '-y', ...range, '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], {signal});
  return out;
};

// Rough speech check: is there sound above -38 dB mean? (cheap; avoids paying speech-to-text for silent/ambient clips)
export const hasSpeechLikeAudio = async (file: string, signal?: AbortSignal) => {
  const {stderr} = await run(ffmpegPath(), ['-v', 'info', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], {signal, stdout: false});
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? -99);
  return mean > -38;
};

// Voiceover: trims leading and trailing silence (silenceremove both ends via areverse), 48 kHz mono WAV.
export const trimSilence = async (input: string, out: string, o: {threshold?: string; signal?: AbortSignal} = {}) => {
  const th = o.threshold ?? '-45dB';
  const sr = `silenceremove=start_periods=1:start_duration=0:start_threshold=${th}:detection=peak`;
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const tmp = `${out}.part.wav`;
  try {
    await run(ffmpegPath(), ['-v', 'error', '-y', '-i', input, '-af', `${sr},areverse,${sr},areverse`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', tmp], {signal: o.signal});
    fs.renameSync(tmp, out);
  } finally { fs.rmSync(tmp, {force: true}); }
  return (await probe(out)).duration ?? 0;
};

export const evenTimes = (from: number, to: number, n: number) => {
  if (n <= 1) return [Math.round(((from + to) / 2) * 1000) / 1000];
  return [...Array(n).keys()].map((i) => Math.round((from + ((to - from) * i) / (n - 1)) * 1000) / 1000);
};
