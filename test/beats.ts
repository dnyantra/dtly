// Beat detection: a synthetic kick pattern (always) and KK Park's techno track against the reference grid
// kkpark/music/techno.beats.json (when the kkpark folder sits next to this repo, or KKPARK=/path).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkFfmpeg, decodeMono, detectBeats, detectBeatsFromPcm, ffmpegPath, ffprobePath} from '../src/node.js';

const step = (s: string) => console.log(`✓ ${s}`);
const matched = (ref: number[], got: number[], tol: number) => ref.filter((b) => got.some((x) => Math.abs(x - b) <= tol)).length / ref.length;

// Synthetic: 128 BPM kicks (decaying 60 Hz sine + click) with off-beat hats, starting at 0.25 s.
{
  const sr = 22050, bpm = 128, dur = 20, first = 0.25, T = 60 / bpm;
  const pcm = new Float32Array(sr * dur);
  const truth: number[] = [];
  for (let t = first; t < dur - 0.5; t += T) {
    truth.push(t);
    const s0 = Math.round(t * sr);
    for (let i = 0; i < sr * 0.25 && s0 + i < pcm.length; i++) pcm[s0 + i] += 0.8 * Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp(-i / (sr * 0.06)) + (i < 40 ? 0.3 * (1 - i / 40) : 0);
    const h0 = Math.round((t + T / 2) * sr);
    for (let i = 0; i < sr * 0.03 && h0 + i < pcm.length; i++) pcm[h0 + i] += 0.15 * (Math.sin(i * 1.7) * Math.sin(i * 2.9)) * Math.exp(-i / (sr * 0.008));
  }
  const g = detectBeatsFromPcm(pcm, sr);
  const m = matched(truth.slice(1, -1), g.beats, 0.02);
  assert.ok(Math.abs(g.tempo - bpm) < 1.5, `tempo ${g.tempo}`);
  assert.ok(m >= 0.95, `synthetic match ${m}`);
  step(`synthetic 128 BPM: tempo ${g.tempo}, ${(m * 100).toFixed(1)}% of beats within 20 ms`);
}

const kk = process.env.KKPARK ?? path.resolve('../kkpark');
const wav = path.join(kk, 'music/techno.wav');
if (fs.existsSync(wav)) {
  const ref = JSON.parse(fs.readFileSync(path.join(kk, 'music/techno.beats.json'), 'utf8')) as {beats: number[]; tempo: number; duration: number};
  const t0 = Date.now();
  const g = await detectBeats(wav);
  const ms = Date.now() - t0;
  const m20 = matched(ref.beats, g.beats, 0.02), m10 = matched(ref.beats, g.beats, 0.01);
  for (const k of ['file', 'duration', 'tempo', 'beat_regularity_ms', 'first_beat', 'beats', 'bars', 'loudness_db_per_sec']) assert.ok(k in g, `has ${k}`);
  assert.equal(g.duration, ref.duration);
  assert.ok(Math.abs(g.first_beat - ref.beats[0]) <= 0.02, `first beat ${g.first_beat}`);
  assert.ok(m20 >= 0.95, `KK Park techno: only ${(m20 * 100).toFixed(1)}% of reference beats within 20 ms`);
  step(`KK Park techno.wav: ${(m20 * 100).toFixed(1)}% of ${ref.beats.length} reference beats within 20 ms (${(m10 * 100).toFixed(1)}% within 10 ms), tempo ${g.tempo} (reference ${ref.tempo}), ${g.beats.length} beats in ${ms} ms`);
} else console.log(`  (${wav} not found: skipped the KK Park reference comparison)`);
// DTLY_FFMPEG / DTLY_FFPROBE pick the binaries DT.ly spawns (read at call time).
{
  assert.equal(ffmpegPath(), process.env.DTLY_FFMPEG || 'ffmpeg');
  const saved = {f: process.env.DTLY_FFMPEG, p: process.env.DTLY_FFPROBE};
  process.env.DTLY_FFMPEG = '/nonexistent/ffmpeg';
  process.env.DTLY_FFPROBE = '/nonexistent/ffprobe';
  assert.equal(ffprobePath(), '/nonexistent/ffprobe');
  assert.throws(() => checkFfmpeg(), /DTLY_FFMPEG=\/nonexistent\/ffmpeg/);
  await assert.rejects(decodeMono(path.resolve('test/fixtures/captions.srt')));
  if (saved.f === undefined) delete process.env.DTLY_FFMPEG; else process.env.DTLY_FFMPEG = saved.f;
  if (saved.p === undefined) delete process.env.DTLY_FFPROBE; else process.env.DTLY_FFPROBE = saved.p;
  checkFfmpeg();
  step('DTLY_FFMPEG / DTLY_FFPROBE override the binaries');
}
console.log('Beat detection tests passed.');
