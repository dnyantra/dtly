// ffmpeg / ffprobe for the engine: which binaries, which codecs, and a cancellable runner.
// Order: DTLY_FFMPEG / DTLY_FFPROBE env → bundled resources/ffmpeg/<platform>-<arch>/ → PATH.
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {Probe} from '../shared/types.js';

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export const bundledFfmpegDir = (resourcesDir?: string) => {
  const dirs = [resourcesDir, process.env.CPV_RESOURCES].filter(Boolean) as string[];
  for (const d of dirs) {
    const dir = path.join(d, 'ffmpeg', `${process.platform}-${process.arch}`);
    if (fs.existsSync(path.join(dir, exe('ffmpeg')))) return dir;
  }
  return undefined;
};

// Sets DTLY_FFMPEG / DTLY_FFPROBE (read by DT.ly core) and puts the folder first on PATH
// (for DT.ly builds that still spawn plain `ffmpeg`). Call once at engine start.
export const configureFfmpeg = (resourcesDir?: string) => {
  if (!process.env.DTLY_FFMPEG) {
    const dir = bundledFfmpegDir(resourcesDir);
    if (dir) {
      process.env.DTLY_FFMPEG = path.join(dir, exe('ffmpeg'));
      process.env.DTLY_FFPROBE = path.join(dir, exe('ffprobe'));
    }
  }
  for (const v of [process.env.DTLY_FFMPEG, process.env.DTLY_FFPROBE]) {
    if (v && path.isAbsolute(v)) {
      const dir = path.dirname(v);
      const parts = (process.env.PATH ?? '').split(path.delimiter);
      if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(path.delimiter);
    }
  }
  // Packaged macOS apps start with a minimal PATH; Homebrew's ffmpeg is a dev fallback only.
  if (process.platform === 'darwin') {
    const parts = (process.env.PATH ?? '').split(path.delimiter);
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin']) if (!parts.includes(d)) parts.push(d);
    process.env.PATH = parts.join(path.delimiter);
  }
};

export const ffmpegPath = () => process.env.DTLY_FFMPEG || 'ffmpeg';
export const ffprobePath = () => process.env.DTLY_FFPROBE || 'ffprobe';

export interface FfmpegInfo { ffmpeg: string; ffprobe: string; version: string; lgpl: boolean; encoders: string[]; hwaccels: string[] }
let info: FfmpegInfo | undefined;
export const ffmpegInfo = (refresh = false): FfmpegInfo => {
  if (info && !refresh) return info;
  const v = spawnSync(ffmpegPath(), ['-hide_banner', '-version'], {encoding: 'utf8'});
  if (v.error || v.status !== 0) throw new Error(`ffmpeg not found (${ffmpegPath()}). Install it or run \`npm run ffmpeg:fetch\`.`);
  const enc = spawnSync(ffmpegPath(), ['-hide_banner', '-encoders'], {encoding: 'utf8'}).stdout ?? '';
  const hw = spawnSync(ffmpegPath(), ['-hide_banner', '-hwaccels'], {encoding: 'utf8'}).stdout ?? '';
  info = {
    ffmpeg: ffmpegPath(),
    ffprobe: ffprobePath(),
    version: v.stdout.split('\n')[0] ?? '',
    lgpl: !/--enable-gpl/.test(v.stdout),
    encoders: [...enc.matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]),
    hwaccels: hw.split('\n').slice(1).map((s) => s.trim()).filter(Boolean),
  };
  return info;
};

// H.264 at "CRF 16" quality: libx264 when the build has it (GPL), otherwise the OS hardware encoder
// at a matching constant quality / high bitrate (LGPL builds, D2).
export const h264Args = (crf = 16, bitrateHint = '24M'): {args: string[]; encoder: string} => {
  const encs = ffmpegInfo().encoders;
  const force = process.env.CPV_H264_ENCODER;
  const pick = force && encs.includes(force) ? force
    : encs.includes('libx264') ? 'libx264'
    : ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264'].find((e) => encs.includes(e));
  if (!pick) throw new Error('This ffmpeg has no H.264 encoder');
  const pix = ['-pix_fmt', 'yuv420p'];
  switch (pick) {
    case 'libx264': return {encoder: pick, args: ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast', ...pix]};
    case 'h264_videotoolbox': return {encoder: pick, args: ['-c:v', pick, '-q:v', String(Math.round(100 - crf * 1.6)), '-allow_sw', '1', '-profile:v', 'high', ...pix]};
    case 'h264_nvenc': return {encoder: pick, args: ['-c:v', pick, '-rc', 'vbr', '-cq', String(crf + 2), '-b:v', '0', '-preset', 'p5', ...pix]};
    case 'h264_qsv': return {encoder: pick, args: ['-c:v', pick, '-global_quality', String(crf + 2), '-pix_fmt', 'nv12']};
    case 'h264_amf': return {encoder: pick, args: ['-c:v', pick, '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2), ...pix]};
    default: return {encoder: pick, args: ['-c:v', pick, '-b:v', bitrateHint, ...pix]};
  }
};

// H.264 at a target average bitrate (final exports, D12: ~8 Mbps; WhatsApp copies sized to fit 16 MB).
// `bitrate` in bits per second. Peak is capped at 1.25× so players and WhatsApp accept the stream.
export const h264BitrateArgs = (bitrate: number, o: {profile?: 'high' | 'main'} = {}): {args: string[]; encoder: string} => {
  const encs = ffmpegInfo().encoders;
  const force = process.env.CPV_H264_ENCODER;
  const pick = force && encs.includes(force) ? force
    : encs.includes('libx264') ? 'libx264'
    : ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libopenh264'].find((e) => encs.includes(e));
  if (!pick) throw new Error('This ffmpeg has no H.264 encoder');
  const b = String(Math.round(bitrate)), max = String(Math.round(bitrate * 1.25)), buf = String(Math.round(bitrate * 2));
  const profile = o.profile ?? 'high';
  const pix = ['-pix_fmt', 'yuv420p'];
  switch (pick) {
    case 'libx264': return {encoder: pick, args: ['-c:v', pick, '-b:v', b, '-maxrate', max, '-bufsize', buf, '-preset', 'medium', '-profile:v', profile, ...pix]};
    case 'h264_videotoolbox': return {encoder: pick, args: ['-c:v', pick, '-b:v', b, '-allow_sw', '1', '-profile:v', profile, ...pix]};
    case 'h264_nvenc': return {encoder: pick, args: ['-c:v', pick, '-rc', 'vbr', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-preset', 'p5', '-profile:v', profile, ...pix]};
    case 'h264_qsv': return {encoder: pick, args: ['-c:v', pick, '-b:v', b, '-maxrate', max, '-bufsize', buf, '-profile:v', profile, '-pix_fmt', 'nv12']};
    case 'h264_amf': return {encoder: pick, args: ['-c:v', pick, '-rc', 'vbr_peak', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-profile:v', profile, ...pix]};
    default: return {encoder: pick, args: ['-c:v', pick, '-b:v', b, ...pix]};
  }
};

// Hardware decode first (VideoToolbox / D3D11 / …); ffmpeg falls back to software on its own.
export const hwDecodeArgs = (): string[] => {
  if (process.env.CPV_NO_HWDECODE) return [];
  const hw = ffmpegInfo().hwaccels;
  if (process.platform === 'darwin' && hw.includes('videotoolbox')) return ['-hwaccel', 'videotoolbox'];
  if (process.platform === 'win32' && hw.includes('d3d11va')) return ['-hwaccel', 'd3d11va'];
  return hw.length ? ['-hwaccel', 'auto'] : [];
};

export class Cancelled extends Error { constructor() { super('Cancelled'); this.name = 'Cancelled'; } }

// Runs ffmpeg/ffprobe; rejects with the stderr tail; kills the process on abort.
export const run = (bin: string, args: string[], opts: {signal?: AbortSignal; onStderr?: (s: string) => void; stdout?: boolean} = {}) =>
  new Promise<{stdout: Buffer; stderr: string}>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Cancelled());
    const p = spawn(bin, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => { if (opts.stdout !== false) out.push(d); });
    p.stderr.on('data', (d: Buffer) => { const s = d.toString(); err = (err + s).slice(-8000); opts.onStderr?.(s); });
    const onAbort = () => p.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, {once: true});
    p.on('error', (e) => { opts.signal?.removeEventListener('abort', onAbort); reject(e); });
    p.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) reject(new Cancelled());
      else if (code === 0) resolve({stdout: Buffer.concat(out), stderr: err});
      else reject(new Error(`${path.basename(bin)} failed (${code}): ${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });

const num = (v: unknown) => (v === undefined || v === null || v === 'N/A' ? undefined : Number(v));
const fpsOf = (r?: string) => {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
};

export const probe = async (file: string): Promise<Probe> => {
  const {stdout} = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout.toString()) as {format?: Record<string, unknown>; streams?: Record<string, any>[]};
  const streams = j.streams ?? [];
  // Attached pictures (cover art, DJI's mjpeg preview) are not the video.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.codec_name !== 'mjpeg') ?? streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio' && s.codec_name);
  const p: Probe = {container: j.format?.format_name as string | undefined, duration: num(j.format?.duration), size: num(j.format?.size)};
  if (v) {
    const rot = Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
    const rotation = ((Math.round(rot) % 360) + 360) % 360;
    const w = Number(v.width), h = Number(v.height);
    const swap = rotation === 90 || rotation === 270;
    const bits = /10le|10be|p010/.test(v.pix_fmt ?? '') ? 10 : /12le/.test(v.pix_fmt ?? '') ? 12 : 8;
    p.video = {codec: v.codec_name, profile: v.profile, width: w, height: h, fps: Math.round(fpsOf(v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate) * 1000) / 1000, pixFmt: v.pix_fmt, bitDepth: bits, rotation, displayWidth: swap ? h : w, displayHeight: swap ? w : h};
    if (p.duration === undefined) p.duration = num(v.duration);
  }
  if (a) p.audio = {codec: a.codec_name, channels: Number(a.channels ?? 0), sampleRate: Number(a.sample_rate ?? 0)};
  return p;
};
