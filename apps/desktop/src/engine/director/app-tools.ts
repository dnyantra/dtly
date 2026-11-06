// The app's own director tools (D7/D8): footage, documents, analysis notes, segment preparation, voiceover and
// music. Each reads only through the guard (project folder + the owner's raw files) and writes only inside
// the project folder. block_apply / timeline_build are not separate tools: DT.ly's preset_apply already
// applies block.* and timeline.build (see preset_list).
import fs from 'node:fs';
import path from 'node:path';
import type {DirectorHost} from '../../shared/director.js';
import type {SegmentOptions} from '../../shared/types.js';
import {dtlyNode} from '../dtly.js';
import {probe} from '../ffmpeg.js';
import {contactSheet, readAnalysis, segmentPrepare} from '../footage.js';
import {readSources} from '../sources.js';
import type {AgentToolDef, ToolOutput} from './agent.js';
import {projectAi, setProjectAi, writeShared} from './cache.js';
import type {Guard} from './guard.js';
import {downscaleImage, evenTimes, extractRange, framesSheet, trimSilence} from './media.js';
import {renderPdfPages} from './pdf.js';

export interface AppToolContext {
  dir: string;
  guard: Guard;
  host: DirectorHost;
  cacheDir: string;
  confirm: (question: string, detail?: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

const text = (s: string): ToolOutput => ({content: [{type: 'text', text: s}]});
const png = (file: string, caption: string): ToolOutput => ({content: [{type: 'image', mimeType: 'image/png', data: fs.readFileSync(file).toString('base64')}, {type: 'text', text: caption}]});
const r2 = (n: number) => Math.round(n * 100) / 100;
const slug = (s: string) => s.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'clip';
const uniqueRel = (dir: string, folder: string, base: string, ext: string) => {
  let rel = `${folder}/${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, rel)); i++) rel = `${folder}/${base}-${i}${ext}`;
  return rel;
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({type: 'object', properties, required, additionalProperties: false});
const FILE = {type: 'string', description: 'Media id from media_list (or the file name)'};

export const appTools = (c: AppToolContext): AgentToolDef[] => [
  {
    name: 'media_list',
    description: 'List the files the owner added to this project (video, photos, audio, PDFs) with id, kind, duration, size and the pass-1 analysis (caption, best moments) when available.',
    inputSchema: obj({}),
    async execute() {
      const an = readAnalysis(c.dir);
      const lines = readSources(c.dir).sources.map((e) => {
        const v = e.probe?.video;
        const ai = an.byHash[e.hash]?.ai as {caption?: string; best?: {t: number}[]; quality?: string} | undefined;
        const missing = !fs.existsSync(e.copiedTo ? path.join(c.dir, e.copiedTo) : e.path);
        return [e.id, e.name, e.kind, e.probe?.duration ? `${r2(e.probe.duration)} s` : '', v ? `${v.displayWidth}x${v.displayHeight}` : '', e.copiedTo ?? '', missing ? 'MISSING' : '',
          ai?.caption ? `“${ai.caption}”` : '', ai?.best?.length ? `best at ${ai.best.map((b) => b.t).join(', ')} s` : '', ai?.quality ?? ''].filter(Boolean).join(' | ');
      });
      return text(lines.length ? `id | name | kind | duration | size | in project | analysis\n${lines.join('\n')}` : 'No media yet. Ask the owner to add footage.');
    },
  },
  {
    name: 'media_sheet',
    description: 'Contact sheet of a video (frames evenly spread over the whole clip) or a photo, returned as an image. The frame times are in the text.',
    inputSchema: obj({file: FILE, frames: {type: 'number', description: 'Number of frames, 2–12 (default 6)'}}, ['file']),
    async execute(a: {file: string; frames?: number}, signal) {
      const {entry, file} = c.guard.source(a.file);
      if (entry.kind === 'image') return png(await downscaleImage(c.dir, file, 1024, signal), `${entry.name} (photo)`);
      if (entry.kind !== 'video') throw new Error(`${entry.name} is ${entry.kind}; use doc_pages for PDFs and media_transcribe for audio`);
      const n = Math.max(2, Math.min(12, Math.round(a.frames ?? 6)));
      if (n === 6 && !entry.copiedTo) {
        const s = await contactSheet(c.dir, entry.id, {signal});
        return png(path.join(c.dir, s.file), `${entry.name}: frames at ${s.times.join(', ')} s (3×2, left to right, top to bottom)`);
      }
      const dur = entry.probe?.duration ?? (await probe(file)).duration ?? 0;
      const times = evenTimes(Math.min(0.2, dur / 10), Math.max(0, dur - 0.3), n);
      return png(await framesSheet(c.dir, file, times, {signal}), `${entry.name}: frames at ${times.join(', ')} s`);
    },
  },
  {
    name: 'media_frames',
    description: 'Frames from a time range of a video (to compare similar shots, check shake, or find the exact moment), returned as one image.',
    inputSchema: obj({file: FILE, from: {type: 'number'}, to: {type: 'number'}, count: {type: 'number', description: 'Frames, 1–9 (default 6)'}}, ['file', 'from', 'to']),
    async execute(a: {file: string; from: number; to: number; count?: number}, signal) {
      const {entry, file} = c.guard.source(a.file);
      if (entry.kind !== 'video') throw new Error(`${entry.name} is not a video`);
      const dur = entry.probe?.duration ?? (await probe(file)).duration ?? 0;
      const to = Math.min(a.to, Math.max(0, dur - 0.1)), from = Math.max(0, Math.min(a.from, to));
      const times = evenTimes(from, to, Math.max(1, Math.min(9, Math.round(a.count ?? 6))));
      return png(await framesSheet(c.dir, file, times, {signal}), `${entry.name}: frames at ${times.join(', ')} s`);
    },
  },
  {
    name: 'media_transcribe',
    description: 'Speech-to-text of a clip or audio file (optionally a range), through CustomerPro (uses credits). Returns timed segments.',
    inputSchema: obj({file: FILE, from: {type: 'number'}, to: {type: 'number'}, language: {type: 'string', description: 'e.g. hi-IN, en-IN (optional)'}}, ['file']),
    async execute(a: {file: string; from?: number; to?: number; language?: string}, signal) {
      const {entry, file} = c.guard.source(a.file);
      const key = `${a.from ?? 0}-${a.to ?? 'end'}`;
      const cached = (projectAi(c.dir, entry.hash) as {transcripts?: Record<string, string>} | undefined)?.transcripts?.[key];
      if (cached) return text(cached);
      const pr = entry.probe ?? (await probe(file));
      if (!pr.audio) return text(`${entry.name} has no audio track.`);
      const wav = await extractRange(c.dir, file, a.from, a.to, signal);
      try {
        const r = await c.host.transcribe({file: wav, language: a.language});
        const off = a.from ?? 0;
        const out = r.segments?.length ? r.segments.map((s) => `[${r2(s.start + off)}–${r2(s.end + off)} s] ${s.text}`).join('\n') : r.text || '(no speech)';
        const prev = (projectAi(c.dir, entry.hash) as {transcripts?: Record<string, string>} | undefined)?.transcripts ?? {};
        setProjectAi(c.dir, entry.hash, {transcripts: {...prev, [key]: out}} as never);
        return text(out);
      } finally { fs.rmSync(wav, {force: true}); }
    },
  },
  {
    name: 'doc_pages',
    description: 'Pages of a PDF the owner added (brochure, price list, floor plan) as images, at most 4 per call.',
    inputSchema: obj({file: FILE, pages: {type: 'array', items: {type: 'number'}, description: '1-based page numbers'}}, ['file', 'pages']),
    async execute(a: {file: string; pages: number[]}) {
      const {entry, file} = c.guard.source(a.file);
      if (entry.kind !== 'pdf') throw new Error(`${entry.name} is not a PDF`);
      const r = await renderPdfPages(file, [...new Set(a.pages)].slice(0, 4), 1024);
      return {content: [...r.pages.map((p) => ({type: 'image' as const, mimeType: 'image/png', data: p.png.toString('base64')})), {type: 'text', text: `${entry.name}: pages ${r.pages.map((p) => p.page).join(', ')} of ${r.total}`}]};
    },
  },
  {
    name: 'analysis_save',
    description: 'Save your notes about a file (what is in it, usable moments, facts it shows) so later steps and other projects can reuse them without looking again.',
    inputSchema: obj({file: FILE, notes: {description: 'Notes: text or a JSON object'}}, ['file', 'notes']),
    async execute(a: {file: string; notes: unknown}) {
      const {entry} = c.guard.source(a.file);
      const ai = setProjectAi(c.dir, entry.hash, {notes: a.notes});
      if (ai.caption) writeShared(c.cacheDir, entry.hash, ai);
      return text(`Saved notes for ${entry.name}`);
    },
  },
  {
    name: 'segment_prepare',
    description: 'Cut a shot from a raw clip for the timeline: [from, to] seconds plus 0.7 s handles, cropped to the video shape at 1.1× size (cx/cy = crop centre 0–1), rotated and graded, as H.264 in media/. Use the returned file as a video layer src with trimIn = handleIn.',
    inputSchema: obj({
      file: FILE, from: {type: 'number'}, to: {type: 'number'},
      aspect: {type: 'string', enum: ['9:16', '1:1', '4:5', '16:9']}, cx: {type: 'number'}, cy: {type: 'number'},
      rotate: {type: 'number', enum: [0, 90, 180, 270]}, grade: {type: 'string', enum: ['none', 'drone', 'phone']},
      name: {type: 'string', description: 'Output name (media/<name>.mp4), e.g. the shot id'},
    }, ['file', 'from', 'to']),
    async execute(a: {file: string; from: number; to: number; name?: string} & SegmentOptions, signal) {
      const {entry} = c.guard.source(a.file);
      const r = await segmentPrepare(c.dir, entry.id, a.from, a.to, {aspect: a.aspect, cx: a.cx, cy: a.cy, rotate: a.rotate, grade: a.grade, name: a.name ? slug(a.name) : undefined, signal});
      return text(JSON.stringify({src: r.file, width: r.width, height: r.height, duration: r2(r.duration), trimIn: r2(r.handleIn), handleOut: r2(r.handleOut), shotLength: r2(a.to - a.from)}));
    },
  },
  {
    name: 'vo_generate',
    description: 'Generate one voiceover line with CustomerPro text-to-speech (uses credits). Silence at both ends is trimmed. Returns vo/<name>.wav and its duration.',
    inputSchema: obj({text: {type: 'string'}, speaker: {type: 'string'}, language: {type: 'string', description: 'e.g. hi-IN, en-IN'}, pace: {type: 'number'}, name: {type: 'string'}}, ['text', 'speaker', 'language']),
    async execute(a: {text: string; speaker: string; language: string; pace?: number; name?: string}, signal) {
      const r = await c.host.synthesize({text: a.text, speaker: a.speaker, language: a.language, pace: a.pace});
      const rel = uniqueRel(c.dir, 'vo', slug(a.name ?? a.text.split(/\s+/).slice(0, 4).join('-')), '.wav');
      const out = c.guard.checkWrite(rel);
      const raw = `${out}.raw.wav`;
      fs.mkdirSync(path.dirname(out), {recursive: true});
      fs.writeFileSync(raw, Buffer.from(r.wavBase64, 'base64'));
      try {
        const duration = await trimSilence(raw, out, {signal});
        return text(JSON.stringify({src: rel, duration: r2(duration), text: a.text}));
      } finally { fs.rmSync(raw, {force: true}); }
    },
  },
  {
    name: 'music_pick',
    description: 'Put a music track in the project with its beat grid: `id` from the CustomerPro library (listed in <music_library>), or `file` = an audio file the owner added (the owner confirms the rights; beats are detected). Returns music/… src and the beats.',
    inputSchema: obj({id: {type: 'string'}, file: FILE}),
    async execute(a: {id?: string; file?: string}, signal) {
      const f = c.fetch ?? fetch;
      let src: string, beatsRel: string, grid: {tempo?: number; bpm?: number; beats: number[]};
      if (a.id) {
        const track = (await c.host.music()).find((t) => t.id === a.id);
        if (!track) throw new Error(`No library track "${a.id}"`);
        const ext = (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/i.exec(track.url)?.[1] ?? 'mp3').toLowerCase();
        src = `music/${slug(track.id)}.${ext}`;
        const abs = c.guard.checkWrite(src);
        if (!fs.existsSync(abs)) {
          const res = await f(track.url, {signal});
          if (!res.ok) throw new Error(`Downloading ${track.title} failed (${res.status})`);
          fs.mkdirSync(path.dirname(abs), {recursive: true});
          fs.writeFileSync(`${abs}.part`, Buffer.from(await res.arrayBuffer()));
          fs.renameSync(`${abs}.part`, abs);
        }
        beatsRel = `music/${slug(track.id)}.beats.json`;
        const bres = await f(track.beats_url, {signal}).catch(() => undefined);
        grid = bres?.ok ? await bres.json() : await (await dtlyNode()).detectBeats(abs);
      } else if (a.file) {
        const {entry, file} = c.guard.source(a.file);
        if (entry.kind !== 'audio') throw new Error(`${entry.name} is not an audio file`);
        if (!(await c.confirm(`Use “${entry.name}” as the music? Only say yes if you have the rights to use it in this video (Instagram, YouTube, WhatsApp).`, entry.name))) {
          throw new Error(`The owner did not confirm the rights to ${entry.name}. Pick a library track instead.`);
        }
        src = entry.copiedTo ?? `music/${slug(entry.name)}${path.extname(entry.name).toLowerCase()}`;
        if (!entry.copiedTo) fs.copyFileSync(file, c.guard.checkWrite(src));
        beatsRel = `music/${slug(entry.name)}.beats.json`;
        grid = await (await dtlyNode()).detectBeats(file);
      } else throw new Error('Give id (library) or file (owner track)');
      fs.writeFileSync(c.guard.checkWrite(beatsRel), JSON.stringify(grid, null, 1));
      const bpm = r2(grid.tempo ?? grid.bpm ?? 0);
      return text(JSON.stringify({src, beats: beatsRel, bpm, beatCount: grid.beats.length, firstBeats: grid.beats.slice(0, 16).map(r2)}));
    },
  },
];
