import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fixtures are made (and checked) with the system ffmpeg/ffprobe, resolved before the engine prepends its
// bundled LGPL build to PATH (that build has no libx264 and no lavfi test sources needed here).
const sys = (n: string) => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n]).toString().split('\n')[0].trim(); } catch { return n; } };
const FFMPEG = sys('ffmpeg'), FFPROBE = sys('ffprobe');

export const tmpDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cpv-${name}-`));

// A small synthetic clip: 1920x1080 testsrc with a tone, 4 s, rotation metadata optional.
export const makeClip = (file: string, o: {w?: number; h?: number; dur?: number; audio?: boolean} = {}) => {
  const {w = 1920, h = 1080, dur = 4, audio = true} = o;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`, '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', file);
  execFileSync(FFMPEG, args);
  return file;
};
export const makeImage = (file: string) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:size=400x300', '-frames:v', '1', file]);
  return file;
};
export const ffprobeJson = (file: string) =>
  JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString()) as {streams: Record<string, any>[]; format: Record<string, any>};

export const KKPARK = '/Users/mayurkakade/Video/kkpark/raw/Kk cricket';
export const DRONE = path.join(KKPARK, 'Drone shot', 'DJI_20261101174018_0380_D.MP4');
export const IPHONE = path.join(KKPARK, 'IMG_3391.MOV');
