// Speech-to-text for captions via Sarvam AI (saaras): phrase-level timestamps, any Indian language
// or English. Audio is cut into ≤25 s chunks for the REST endpoint, then timestamps are re-offset.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Cue} from '../core/captions.js';
import {checkFfmpeg} from './ffmpeg.js';

const CHUNK = 25;

export const transcribe = async (file: string, opts: {language?: string; apiKey?: string; model?: string} = {}): Promise<Cue[]> => {
  checkFfmpeg();
  const key = opts.apiKey ?? process.env.SARVAM_API_KEY;
  if (!key) throw new Error('Set SARVAM_API_KEY (from dashboard.sarvam.ai) to transcribe audio, or pass an .srt/.vtt/.json file instead.');
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {encoding: 'utf8'}).trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-stt-'));
  const cues: Cue[] = [];
  try {
    for (let start = 0; start < dur; start += CHUNK) {
      const wav = path.join(tmp, `c${start}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-t', String(CHUNK), '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(wav)], {type: 'audio/wav'}), 'chunk.wav');
      form.append('model', opts.model ?? 'saaras:v4');
      form.append('language_code', opts.language ?? 'unknown');
      form.append('with_timestamps', 'true');
      const res = await fetch('https://api.sarvam.ai/speech-to-text', {method: 'POST', headers: {'api-subscription-key': key}, body: form});
      const json = (await res.json()) as {transcript?: string; timestamps?: {words: string[]; start_time_seconds: number[]; end_time_seconds: number[]}; error?: {message?: string}};
      if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
      const ts = json.timestamps;
      if (ts?.words?.length) ts.words.forEach((w, i) => cues.push({start: start + ts.start_time_seconds[i], end: start + ts.end_time_seconds[i], text: w.trim()}));
      else if (json.transcript) cues.push({start, end: Math.min(dur, start + CHUNK), text: json.transcript});
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  return cues.filter((c) => c.text);
};

// Reads captions from a subtitle/JSON file or transcribes an audio/video file.
export const loadCaptions = async (file: string, language?: string): Promise<{cues?: Cue[]; words?: {text: string; start: number; end: number}[]}> => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.srt' || ext === '.vtt') {
    const {parseSubtitles} = await import('../core/captions.js');
    return {cues: parseSubtitles(fs.readFileSync(file, 'utf8'))};
  }
  if (ext === '.json') {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? (j[0] && 'text' in j[0] && !('start' in j[0] && 'end' in j[0] && j[0].text.includes(' ')) ? {words: j} : {cues: j}) : {words: j.words, cues: j.cues};
  }
  return {cues: await transcribe(file, {language})};
};
