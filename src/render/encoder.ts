// H.264 encoder choice for MP4 exports. libx264 is GPL, so LGPL FFmpeg builds (the desktop app's)
// only have the OS hardware encoders. 'auto' uses libx264 when the FFmpeg build has it, else the
// first platform hardware encoder that FFmpeg lists AND that passes a tiny test encode (a listed
// encoder can still fail at runtime, e.g. NVENC without an NVIDIA GPU). The result is cached per
// FFmpeg binary for the life of the process.
//
// Quality: callers give an x264-style CRF (default 18, lower = better). Each encoder gets the
// nearest equivalent:
//   libx264            -crf N -preset medium
//   h264_videotoolbox  -q:v round(100 - 1.6·N)      (CRF 16 → 74, 18 → 71, 23 → 63)
//   h264_mf            -rate_control quality -quality round(100 - 1.6·N)
//   h264_nvenc         -rc constqp -qp N
//   h264_qsv           -global_quality N            (ICQ / CQP)
//   h264_amf           -rc cqp -qp_i N -qp_p N
// If the quality mode fails the test encode (VideoToolbox's -q:v needs Apple Silicon, for one),
// the encoder falls back to an average bitrate, -b:v, sized from the frame size, fps and CRF.
import {spawnSync} from 'node:child_process';
import {ffmpegPath} from './ffmpeg.js';

export type VideoEncoder = 'libx264' | 'h264_videotoolbox' | 'h264_mf' | 'h264_qsv' | 'h264_nvenc' | 'h264_amf';
export type VideoEncoderChoice = VideoEncoder | 'auto';
export const VIDEO_ENCODERS: readonly VideoEncoder[] = ['libx264', 'h264_videotoolbox', 'h264_mf', 'h264_qsv', 'h264_nvenc', 'h264_amf'];

/** A resolved encoder: the name plus how its quality is controlled. */
export interface ResolvedEncoder {
  encoder: VideoEncoder;
  rate: 'quality' | 'bitrate';
}

/** Hardware encoders worth trying on each platform, in order of preference. */
export const hardwareEncoders = (platform: NodeJS.Platform = process.platform): VideoEncoder[] =>
  platform === 'darwin' ? ['h264_videotoolbox'] : platform === 'win32' ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'] : ['h264_nvenc', 'h264_qsv', 'h264_amf'];

/** Encoder names from `ffmpeg -hide_banner -encoders` output (lines like " V....D libx264  ..."). */
export const parseEncoders = (text: string): string[] =>
  text.split(/\r?\n/).map((l) => /^\s*V[.A-Z]{5}\s+([\w-]+)\s/.exec(l)?.[1]).filter((n): n is string => !!n);

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const PIX: Record<VideoEncoder, string> = {libx264: 'yuv420p', h264_videotoolbox: 'yuv420p', h264_nvenc: 'yuv420p', h264_qsv: 'nv12', h264_amf: 'nv12', h264_mf: 'nv12'};

export interface EncodeShape { width?: number; height?: number; fps?: number }

/** Average bitrate (bits/s) that roughly matches an x264 CRF at this frame size: ~9 Mb/s for 1080×1920 at 30 fps, CRF 18. */
export const bitrateFor = (crf = 18, {width = 1080, height = 1920, fps = 30}: EncodeShape = {}) =>
  Math.round(width * height * fps * 0.15 * 2 ** ((18 - crf) / 6));

/** FFmpeg output options for an encoder at an x264-style CRF (including -c:v and -pix_fmt). */
export const videoEncoderArgs = (enc: VideoEncoder | ResolvedEncoder, crf = 18, shape: EncodeShape = {}): string[] => {
  const {encoder, rate} = typeof enc === 'string' ? {encoder: enc, rate: 'quality' as const} : enc;
  const head = ['-c:v', encoder, '-pix_fmt', PIX[encoder]];
  if (encoder === 'libx264') return [...head, '-crf', String(crf), '-preset', 'medium'];
  if (rate === 'bitrate') {
    const b = bitrateFor(crf, shape);
    return [...head, '-b:v', String(b), '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(b * 2)];
  }
  const q = String(Math.round(clamp(100 - 1.6 * crf, 1, 100)));
  const n = String(Math.round(clamp(crf, 0, 51)));
  switch (encoder) {
    case 'h264_videotoolbox': return [...head, '-q:v', q];
    case 'h264_mf': return [...head, '-rate_control', 'quality', '-quality', q];
    case 'h264_nvenc': return [...head, '-rc', 'constqp', '-qp', n];
    case 'h264_qsv': return [...head, '-global_quality', n];
    case 'h264_amf': return [...head, '-rc', 'cqp', '-qp_i', n, '-qp_p', n];
  }
};

// ---- probing (cached per FFmpeg binary) ----

const listed = new Map<string, string[]>();
const tested = new Map<string, boolean>();
const resolved = new Map<string, ResolvedEncoder>();

/** Encoders the FFmpeg build lists (`ffmpeg -encoders`), cached. */
export const listEncoders = (bin = ffmpegPath()): string[] => {
  let l = listed.get(bin);
  if (!l) {
    const r = spawnSync(bin, ['-hide_banner', '-encoders'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    l = r.status === 0 ? parseEncoders(r.stdout) : [];
    listed.set(bin, l);
  }
  return l;
};

/** A tiny test encode (3 frames of 256×256 raw RGBA from stdin, to the null muxer), cached. */
export const testEncoder = (enc: ResolvedEncoder, bin = ffmpegPath()): boolean => {
  const key = `${bin}\0${enc.encoder}\0${enc.rate}`;
  let ok = tested.get(key);
  if (ok === undefined) {
    const w = 256, h = 256;
    const r = spawnSync(bin, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', '30', '-i', '-', ...videoEncoderArgs(enc, 18, {width: w, height: h, fps: 30}), '-frames:v', '3', '-f', 'null', '-'],
      {input: Buffer.alloc(w * h * 4 * 3, 80), timeout: 20000, stdio: ['pipe', 'ignore', 'pipe']});
    ok = r.status === 0;
    tested.set(key, ok);
  }
  return ok;
};

export interface PickOptions {
  /** Encoder names the FFmpeg build lists. */
  listed: string[];
  platform?: NodeJS.Platform;
  /** Test encode; true when the encoder works in this mode. */
  works: (enc: ResolvedEncoder) => boolean;
}

/** Pure selection logic behind 'auto' (exported for tests). Returns null when nothing works. */
export const pickEncoder = (choice: VideoEncoderChoice, {listed: names, platform = process.platform, works}: PickOptions): ResolvedEncoder | null => {
  const tryOne = (encoder: VideoEncoder): ResolvedEncoder | null => {
    if (encoder === 'libx264') return {encoder, rate: 'quality'}; // software: listed means it works
    for (const rate of ['quality', 'bitrate'] as const) if (works({encoder, rate})) return {encoder, rate};
    return null;
  };
  if (choice !== 'auto') return names.includes(choice) ? tryOne(choice) : null;
  for (const e of ['libx264' as const, ...hardwareEncoders(platform)]) {
    if (!names.includes(e)) continue;
    const r = tryOne(e);
    if (r) return r;
  }
  return null;
};

const isChoice = (s: string): s is VideoEncoderChoice => s === 'auto' || (VIDEO_ENCODERS as readonly string[]).includes(s);

/**
 * The H.264 encoder to use: `choice`, else env DTLY_VIDEO_ENCODER, else 'auto'.
 * An explicit encoder the build doesn't list (or that fails its test) is still returned in quality
 * mode, so FFmpeg's own error explains the problem; 'auto' with no usable encoder throws.
 */
export const resolveVideoEncoder = (choice?: VideoEncoderChoice, bin = ffmpegPath()): ResolvedEncoder => {
  if (choice && !isChoice(choice)) throw new Error(`Unknown video encoder "${choice}": use auto, ${VIDEO_ENCODERS.join(', ')}`);
  const env = process.env.DTLY_VIDEO_ENCODER?.trim();
  if (!choice && env && !isChoice(env)) throw new Error(`DTLY_VIDEO_ENCODER=${env} is not one of: auto, ${VIDEO_ENCODERS.join(', ')}`);
  const want: VideoEncoderChoice = choice ?? (env as VideoEncoderChoice | undefined) ?? 'auto';
  if (want === 'libx264') return {encoder: 'libx264', rate: 'quality'};
  const key = `${bin}\0${want}`;
  const hit = resolved.get(key);
  if (hit) return hit;
  const names = listEncoders(bin);
  const r = pickEncoder(want, {listed: names, works: (e) => testEncoder(e, bin)});
  if (!r) {
    if (want !== 'auto') return {encoder: want, rate: 'quality'};
    const hw = hardwareEncoders().filter((e) => names.includes(e));
    throw new Error(
      `FFmpeg at ${bin} has no usable H.264 encoder: no libx264` + (hw.length ? `, and ${hw.join(', ')} failed a test encode` : ', and no hardware H.264 encoder') +
        '. Use an FFmpeg build with libx264 or a hardware encoder (set DTLY_FFMPEG), or pick one with DTLY_VIDEO_ENCODER.',
    );
  }
  resolved.set(key, r);
  return r;
};

/** Forget cached probes (tests, or after swapping the FFmpeg binary in place). */
export const clearEncoderCache = () => { listed.clear(); tested.clear(); resolved.clear(); };
