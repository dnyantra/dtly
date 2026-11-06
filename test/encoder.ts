// H.264 encoder choice and FFmpeg failure handling in the exporter, with a fake ffmpeg
// (DTLY_FFMPEG) for the auto-pick and the EPIPE path, plus a real hardware export when available.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newProject} from '../src/index.js';
import {bitrateFor, clearEncoderCache, listEncoders, parseEncoders, pickEncoder, renderVideo, resolveVideoEncoder, videoEncoderArgs, writeProject} from '../src/node.js';

const step = (s: string) => console.log(`✓ ${s}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-enc-'));

// ---- parsing and pure selection ----
const LGPL_MAC = ` Encoders:
 V..... = Video
 ------
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;
const GPL = `${LGPL_MAC} V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)\n`;
const WIN = ' V....D h264_amf  AMD AMF H.264 Encoder (codec h264)\n V....D h264_mf  H264 via MediaFoundation (codec h264)\n V....D h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)\n V....D h264_qsv  H264 (Intel Quick Sync Video acceleration) (codec h264)\n';
assert.deepEqual(parseEncoders(LGPL_MAC), ['h264_videotoolbox', 'hevc_videotoolbox']);
const all = () => true;
assert.deepEqual(pickEncoder('auto', {listed: parseEncoders(GPL), platform: 'darwin', works: all}), {encoder: 'libx264', rate: 'quality'});
assert.deepEqual(pickEncoder('auto', {listed: parseEncoders(LGPL_MAC), platform: 'darwin', works: all}), {encoder: 'h264_videotoolbox', rate: 'quality'});
// VideoToolbox without constant-quality support (Intel Macs) → bitrate mode.
assert.deepEqual(pickEncoder('auto', {listed: parseEncoders(LGPL_MAC), platform: 'darwin', works: (e) => e.rate === 'bitrate'}), {encoder: 'h264_videotoolbox', rate: 'bitrate'});
// Windows: NVENC listed but no NVIDIA GPU, no Quick Sync → AMF... all fail but Media Foundation.
const tried: string[] = [];
assert.deepEqual(pickEncoder('auto', {listed: parseEncoders(WIN), platform: 'win32', works: (e) => { tried.push(`${e.encoder}:${e.rate}`); return e.encoder === 'h264_mf'; }}), {encoder: 'h264_mf', rate: 'quality'});
assert.deepEqual(tried, ['h264_nvenc:quality', 'h264_nvenc:bitrate', 'h264_qsv:quality', 'h264_qsv:bitrate', 'h264_amf:quality', 'h264_amf:bitrate', 'h264_mf:quality']);
assert.equal(pickEncoder('auto', {listed: [], platform: 'linux', works: all}), null);
assert.equal(pickEncoder('h264_nvenc', {listed: parseEncoders(LGPL_MAC), platform: 'darwin', works: all}), null);
step('ffmpeg -encoders parsing; auto prefers libx264, else the first hardware encoder that passes its test encode');

// ---- quality mapping ----
const opt = (a: string[], f: string) => a[a.indexOf(f) + 1];
assert.deepEqual(videoEncoderArgs('libx264', 18), ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium']);
assert.equal(opt(videoEncoderArgs('h264_videotoolbox', 16), '-q:v'), '74');
assert.equal(opt(videoEncoderArgs('h264_nvenc', 18), '-qp'), '18');
assert.equal(opt(videoEncoderArgs('h264_qsv', 20), '-global_quality'), '20');
assert.equal(opt(videoEncoderArgs('h264_amf', 18), '-qp_p'), '18');
assert.equal(opt(videoEncoderArgs('h264_mf', 18), '-quality'), '71');
assert.equal(opt(videoEncoderArgs({encoder: 'h264_videotoolbox', rate: 'bitrate'}, 18, {width: 1080, height: 1920, fps: 30}), '-b:v'), String(bitrateFor(18)));
assert.ok(bitrateFor(12) > bitrateFor(18) && bitrateFor(18) > bitrateFor(24));
step('CRF → -crf / -q:v / -qp / -global_quality / -quality, bitrate fallback');

// ---- fake ffmpeg: auto-pick through `ffmpeg -encoders` + test encodes, and the EPIPE path ----
if (process.platform !== 'win32') {
  const fake = path.join(dir, 'ffmpeg');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  -version*) echo "ffmpeg version fake"; exit 0;;
  *-encoders*) printf '%s' "$FAKE_ENCODERS"; exit 0;;
esac
case "$*" in
  *"-f null"*) case "$*" in *"$FAKE_WORKS"*) cat > /dev/null; exit 0;; esac; echo "Error initializing encoder" >&2; exit 1;;
esac
echo "[vost#0:0 @ 0x1] Unknown encoder '$FAKE_FAIL'" >&2
echo "Error opening output files: Encoder not found" >&2
exit 8
`, {mode: 0o755});
  const saved = {...process.env};
  try {
    const mac = process.platform === 'darwin';
    process.env.DTLY_FFMPEG = fake;
    process.env.FAKE_ENCODERS = LGPL_MAC + WIN;
    // macOS: VideoToolbox works only in bitrate mode; elsewhere NVENC fails and Quick Sync works.
    process.env.FAKE_WORKS = mac ? '-c:v h264_videotoolbox -pix_fmt yuv420p -b:v' : '-c:v h264_qsv';
    delete process.env.DTLY_VIDEO_ENCODER;
    clearEncoderCache();
    fs.writeFileSync(log, '');
    assert.deepEqual(listEncoders(), ['h264_videotoolbox', 'hevc_videotoolbox', 'h264_amf', 'h264_mf', 'h264_nvenc', 'h264_qsv']);
    assert.deepEqual(resolveVideoEncoder(), mac ? {encoder: 'h264_videotoolbox', rate: 'bitrate'} : {encoder: 'h264_qsv', rate: 'quality'});
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((l) => l.includes('-f null')).length, mac ? 2 : 3, 'test encodes until one works');
    resolveVideoEncoder();
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, calls.length, 'cached: no new probes');
    process.env.DTLY_VIDEO_ENCODER = 'libx264';
    assert.deepEqual(resolveVideoEncoder(), {encoder: 'libx264', rate: 'quality'});
    process.env.DTLY_VIDEO_ENCODER = 'h264_bogus';
    assert.throws(() => resolveVideoEncoder(), /DTLY_VIDEO_ENCODER=h264_bogus/);
    delete process.env.DTLY_VIDEO_ENCODER;
    step('auto-pick with a fake ffmpeg: lists encoders, probes once, caches; bad DTLY_VIDEO_ENCODER rejected');

    // EPIPE: ffmpeg exits at once without reading the 8 MB frames. The render must reject with
    // ffmpeg's own error, not crash the process with an unhandled 'write EPIPE'.
    const file = path.join(dir, 'p.json');
    writeProject(file, newProject({name: 'epipe', duration: 2, background: '#203040'}));
    process.env.FAKE_FAIL = 'libx264';
    let unhandled: unknown;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    await assert.rejects(renderVideo(file, path.join(dir, 'x.mp4'), {videoEncoder: 'libx264'}), (e: Error) => /ffmpeg failed \(8\)/.test(e.message) && /Unknown encoder 'libx264'/.test(e.message));
    await new Promise((r) => setTimeout(r, 200));
    process.off('uncaughtException', onUnhandled);
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, undefined, `unhandled: ${unhandled}`);
    step('ffmpeg exits early (EPIPE on stdin) → rejected with the stderr tail, no crash');
  } finally {
    process.env = saved;
    clearEncoderCache();
  }
}

// ---- real exports with the system ffmpeg ----
if (spawnSync('ffmpeg', ['-version']).status === 0) {
  const file = path.join(dir, 'real.json');
  writeProject(file, newProject({name: 'real', duration: 1, background: '#305070'}));
  const names = listEncoders();
  for (const enc of (['libx264', 'h264_videotoolbox'] as const).filter((e) => names.includes(e))) {
    const out = path.join(dir, `${enc}.mp4`);
    const r = await renderVideo(file, out, {videoEncoder: enc, to: 0.5});
    assert.equal(r.encoder, enc);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_frames', '-of', 'csv=p=0', out], {encoding: 'utf8'});
    if (probe.status === 0) assert.match(probe.stdout.trim(), /^h264,15$/);
    step(`real export with ${enc} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  }
  step(`auto on this machine → ${resolveVideoEncoder('auto').encoder}`);
}

fs.rmSync(dir, {recursive: true, force: true});
console.log('Encoder tests passed.');
