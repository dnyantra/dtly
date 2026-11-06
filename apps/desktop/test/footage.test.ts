import fs from 'node:fs';
import path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {configureFfmpeg, probe} from '../src/engine/ffmpeg.js';
import {addSegmentLayer, analysePass1, contactSheet, extractAudio, previewSafe, segmentPrepare} from './footage-exports.js';
import {createProject} from '../src/engine/projects.js';
import {importMedia, listSources, locateSource, quickHash, readSources} from '../src/engine/sources.js';
import {DRONE, ffprobeJson, IPHONE, makeClip, makeImage, tmpDir} from './helpers.js';

beforeAll(() => configureFfmpeg());

describe('media bin (task 2.4)', () => {
  it('imports folders in place, copies photos, hashes, probes, thumbnails; dedupes; missing + Locate', async () => {
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'shoot', 'a.mp4'));
    makeClip(path.join(raw, 'shoot', 'b.mp4'), {w: 1080, h: 1920, audio: false, dur: 2});
    makeImage(path.join(raw, 'logo.png'));
    fs.writeFileSync(path.join(raw, 'shoot', 'notes.txt'), 'ignored');
    const dir = createProject({name: 'Bin', root: tmpDir('root')});
    const r = await importMedia(dir, [path.join(raw, 'shoot'), path.join(raw, 'logo.png')]);
    expect(r.added.map((e) => e.name).sort()).toEqual(['a.mp4', 'b.mp4', 'logo.png']);
    const a = r.added.find((e) => e.name === 'a.mp4')!;
    expect(a.path).toBe(path.join(raw, 'shoot', 'a.mp4')); // referenced, not copied
    expect(a.copiedTo).toBeUndefined();
    expect(a.hash).toBe(quickHash(a.path));
    expect(a.probe?.video).toMatchObject({codec: 'h264', width: 1920, height: 1080, fps: 30});
    expect(a.probe?.audio?.codec).toBe('aac');
    expect(fs.existsSync(path.join(dir, a.thumb!))).toBe(true);
    const logo = r.added.find((e) => e.name === 'logo.png')!;
    expect(logo.copiedTo).toBe('media/logo.png');
    expect(fs.existsSync(path.join(dir, 'media/logo.png'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'media'))).toEqual(['logo.png']); // no video copied

    const again = await importMedia(dir, [path.join(raw, 'shoot', 'a.mp4')]);
    expect(again.added).toHaveLength(0);
    expect(again.skipped[0].reason).toMatch(/already/);

    // Move the folder: both clips go missing; locating one finds the other.
    fs.renameSync(path.join(raw, 'shoot'), path.join(raw, 'moved'));
    expect(listSources(dir).filter((s) => s.missing).map((s) => s.name).sort()).toEqual(['a.mp4', 'b.mp4']);
    expect(() => locateSource(dir, a.id, path.join(raw, 'moved', 'b.mp4'))).toThrow(/different file/);
    const loc = locateSource(dir, a.id, path.join(raw, 'moved', 'a.mp4'));
    expect(loc.relocated).toHaveLength(2);
    expect(listSources(dir).every((s) => !s.missing)).toBe(true);
    expect(readSources(dir).sources.find((s) => s.id === a.id)!.path).toBe(path.join(raw, 'moved', 'a.mp4'));
  });
});

describe('footage pass 1 (task 2.5)', () => {
  it('makes a 1280x720 contact sheet of 6 frames and a 16 kHz mono wav; caches by hash', async () => {
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'talk.mp4'), {dur: 5});
    makeClip(path.join(raw, 'silent.mp4'), {audio: false, dur: 2});
    const dir = createProject({name: 'P1', root: tmpDir('root')});
    const {added} = await importMedia(dir, [raw]);
    const talk = added.find((e) => e.name === 'talk.mp4')!;
    const sheet = await contactSheet(dir, talk.id);
    expect(sheet.times).toHaveLength(6);
    const png = ffprobeJson(path.join(dir, sheet.file)).streams[0];
    expect([png.width, png.height]).toEqual([1280, 720]);
    const audio = await extractAudio(dir, talk.id);
    expect('file' in audio).toBe(true);
    const wav = ffprobeJson(path.join(dir, (audio as {file: string}).file)).streams[0];
    expect([wav.codec_name, Number(wav.sample_rate), wav.channels]).toEqual(['pcm_s16le', 16000, 1]);
    const mtime = fs.statSync(path.join(dir, sheet.file)).mtimeMs;
    await contactSheet(dir, talk.id); // cached
    expect(fs.statSync(path.join(dir, sheet.file)).mtimeMs).toBe(mtime);
    const res = await analysePass1(dir, added.map((e) => e.id));
    expect(res.every((r) => r.ok)).toBe(true);
    const silent = added.find((e) => e.name === 'silent.mp4')!;
    expect(await extractAudio(dir, silent.id)).toEqual({none: true});
  });
});

describe('segment_prepare (task 2.6, D8)', () => {
  it('cuts with handles, crops to 1.1x comp size, encodes H.264, and adds a layer', async () => {
    const raw = tmpDir('raw');
    makeClip(path.join(raw, 'land.mp4'), {dur: 6});
    const dir = createProject({name: 'Seg', root: tmpDir('root')});
    const {added} = await importMedia(dir, [raw]);
    const seg = await segmentPrepare(dir, added[0].id, 2, 3.5, {cx: 0.3, grade: 'phone', name: 'shot1'});
    expect(seg).toMatchObject({file: 'media/shot1.mp4', width: 1188, height: 2112});
    expect(seg.handleIn).toBeCloseTo(0.7, 3);
    expect(seg.handleOut).toBeCloseTo(0.7, 3);
    expect(seg.duration).toBeGreaterThan(2.8);
    expect(seg.duration).toBeLessThan(3.05);
    const v = ffprobeJson(path.join(dir, seg.file)).streams.find((s) => s.codec_type === 'video')!;
    expect([v.codec_name, v.width, v.height, v.pix_fmt]).toEqual(['h264', 1188, 2112, 'yuv420p']);
    expect(ffprobeJson(path.join(dir, seg.file)).streams.some((s) => s.codec_type === 'audio')).toBe(false);
    // Handles clamp at the clip start.
    const early = await segmentPrepare(dir, added[0].id, 0.2, 1, {name: 'early'});
    expect(early.handleIn).toBeCloseTo(0.2, 3);
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    const l1 = addSegmentLayer(project, seg, 2, 3.5);
    const l2 = addSegmentLayer(project, early, 0.2, 1);
    expect(l1).toMatchObject({type: 'video', src: 'media/shot1.mp4', trimIn: 0.7, inPoint: 0, outPoint: 1.5, size: [1188, 2112]});
    expect(l2.inPoint).toBe(1.5);
    expect(l1.transform.scale[0]).toBeCloseTo(90.909, 2);
    expect(previewSafe(project)).toBe(true);
  });

  it.skipIf(!fs.existsSync(DRONE))('prepares a real 4K HEVC 10-bit DJI drone clip (hardware decode)', async () => {
    const dir = createProject({name: 'Drone', root: tmpDir('root')});
    const {added} = await importMedia(dir, [DRONE]);
    expect(added[0].probe?.video).toMatchObject({codec: 'hevc', width: 3840, height: 2160, bitDepth: 10});
    const t0 = Date.now();
    const seg = await segmentPrepare(dir, added[0].id, 2.0, 4.5, {aspect: '9:16', cx: 0.5});
    const v = ffprobeJson(path.join(dir, seg.file)).streams.find((s) => s.codec_type === 'video')!;
    expect([v.codec_name, v.width, v.height]).toEqual(['h264', 1188, 2112]);
    expect(Number(eval(v.r_frame_rate))).toBe(30);
    expect(seg.duration).toBeGreaterThan(3.7);
    console.log(`drone segment: ${seg.encoder}, hwDecode=${seg.hwDecode}, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${(fs.statSync(path.join(dir, seg.file)).size / 1e6).toFixed(1)} MB`);
    const sheet = await contactSheet(dir, added[0].id);
    expect(fs.existsSync(path.join(dir, sheet.file))).toBe(true);
    // LGPL path (no libx264): the OS hardware encoder at matching quality.
    if (process.platform === 'darwin') {
      process.env.CPV_H264_ENCODER = 'h264_videotoolbox';
      try {
        const t1 = Date.now();
        const vt = await segmentPrepare(dir, added[0].id, 2.0, 4.5, {name: 'drone-vt'});
        expect(vt.encoder).toBe('h264_videotoolbox');
        const s2 = ffprobeJson(path.join(dir, vt.file)).streams.find((s) => s.codec_type === 'video')!;
        expect([s2.codec_name, s2.width, s2.height]).toEqual(['h264', 1188, 2112]);
        console.log(`drone segment: ${vt.encoder}, ${((Date.now() - t1) / 1000).toFixed(1)} s, ${(fs.statSync(path.join(dir, vt.file)).size / 1e6).toFixed(1)} MB`);
      } finally { delete process.env.CPV_H264_ENCODER; }
    }
  });

  it.skipIf(!fs.existsSync(IPHONE))('reads iPhone rotation metadata and prepares a vertical segment', async () => {
    const dir = createProject({name: 'Phone', root: tmpDir('root')});
    const {added} = await importMedia(dir, [IPHONE]);
    const pv = added[0].probe!.video!;
    expect(pv.rotation === 90 || pv.rotation === 270).toBe(true);
    expect([pv.displayWidth, pv.displayHeight]).toEqual([1080, 1920]);
    const seg = await segmentPrepare(dir, added[0].id, 0.5, 1.5, {});
    const v = (await probe(path.join(dir, seg.file))).video!;
    expect([v.width, v.height, v.rotation]).toEqual([1188, 2112, 0]);
  });
});
