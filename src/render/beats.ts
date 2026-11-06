// Beat detection in plain TypeScript (no Python, no native deps): FFmpeg decodes the track to mono
// float PCM; we compute a log-mel spectral-flux onset envelope, estimate the tempo by autocorrelation
// with a log-normal prior around 120 BPM, track beats with dynamic programming (Ellis 2007, as in
// librosa's beat_track), refine each beat to sub-frame precision and smooth it against its neighbours.
// Output matches the `.beats.json` files used by DT.ly projects (e.g. kkpark/music/techno.beats.json).
import {spawn} from 'node:child_process';
import {ffmpegPath} from './ffmpeg.js';

export interface BeatGrid {
  file?: string;
  duration: number; // s, one decimal
  tempo: number; // BPM, one decimal
  beat_regularity_ms: number; // standard deviation of beat intervals
  first_beat: number;
  beats: number[]; // s, 3 decimals
  bars: number[]; // estimated downbeats (every 4th beat)
  loudness_db_per_sec: number[]; // RMS level of each whole second, dBFS
}

export interface BeatOptions {
  sampleRate?: number; // analysis rate (22050)
  startBpm?: number; // tempo prior centre (120)
  minBpm?: number; // (60)
  maxBpm?: number; // (240)
  tightness?: number; // how strictly beats follow the tempo (100)
}

/** Decodes any audio/video file to mono 32-bit float PCM with FFmpeg. */
export const decodeMono = (file: string, sampleRate = 22050): Promise<Float32Array> =>
  new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], {stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (d: Buffer) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file} (${code}): ${err.slice(-500)}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });

// ---------- DSP ----------
// In-place iterative radix-2 FFT.
const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
};

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);
const melFilters = (nMels: number, nFft: number, sr: number, fmax = sr / 2) => {
  const bins = nFft / 2 + 1;
  const pts = Array.from({length: nMels + 2}, (_, i) => mel2hz((hz2mel(fmax) * i) / (nMels + 1)));
  return Array.from({length: nMels}, (_, m) => {
    const w = new Float64Array(bins);
    const [lo, mid, hi] = [pts[m], pts[m + 1], pts[m + 2]];
    for (let k = 0; k < bins; k++) {
      const f = (k * sr) / nFft;
      w[k] = f <= lo || f >= hi ? 0 : f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
    }
    return w;
  });
};

/** Onset strength per frame: mean positive change of the log-mel spectrum (librosa's onset_strength). */
export const onsetEnvelope = (pcm: Float32Array, sr: number, hop = 256, nFft = 2048, nMels = 96) => {
  const frames = Math.floor(pcm.length / hop) + 1;
  const win = Float64Array.from({length: nFft}, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft));
  const fb = melFilters(nMels, nFft, sr);
  const lo = fb.map((w) => w.findIndex((x) => x > 0));
  const hi = fb.map((w, m) => { let k = w.length - 1; while (k > lo[m] && w[k] === 0) k--; return k; });
  const re = new Float64Array(nFft), im = new Float64Array(nFft), pow = new Float64Array(nFft / 2 + 1);
  const mel = Array.from({length: frames}, () => new Float64Array(nMels));
  let peak = -Infinity;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - nFft / 2; // centred frames
    for (let i = 0; i < nFft; i++) { const s = start + i; re[i] = s >= 0 && s < pcm.length ? pcm[s] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= nFft / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < nMels; m++) {
      let e = 0;
      const w = fb[m];
      for (let k = lo[m]; k <= hi[m]; k++) e += w[k] * pow[k];
      const db = 10 * Math.log10(Math.max(e, 1e-10));
      mel[f][m] = db;
      if (db > peak) peak = db;
    }
  }
  const floor = peak - 80;
  const env = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let m = 0; m < nMels; m++) { const d = Math.max(mel[f][m], floor) - Math.max(mel[f - 1][m], floor); if (d > 0) s += d; }
    env[f] = s / nMels;
  }
  return env;
};

const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / Math.max(1, a.length); };
const std = (a: ArrayLike<number>) => { const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / Math.max(1, a.length)); };

/** Beat period in frames (fractional) from the autocorrelation of the onset envelope, weighted by a tempo prior. */
const estimatePeriod = (env: Float64Array, fps: number, o: Required<BeatOptions>) => {
  const n = env.length, m = mean(env);
  const x = Float64Array.from(env, (v) => v - m);
  const minLag = Math.floor((60 * fps) / o.maxBpm), maxLag = Math.min(n - 1, Math.ceil((60 * fps) / o.minBpm));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / o.startBpm) ** 2);
    // Reward lags whose double also correlates (metrical support), as a tempogram does.
    const score = (ac[lag] + 0.5 * (2 * lag <= maxLag ? ac[2 * lag] : 0)) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  const [a, b, c] = [ac[best - 1], ac[best], ac[best + 1]];
  const den = a - 2 * b + c;
  return den < 0 ? best + (0.5 * (a - c)) / den : best;
};

/** Dynamic-programming beat tracker; returns beat frames. */
const trackBeats = (env: Float64Array, period: number, tightness: number) => {
  const n = env.length;
  const sd = std(env) || 1;
  const onset = Float64Array.from(env, (v) => v / sd);
  // Local score: onset smoothed with a Gaussian ~period/32 wide.
  const half = Math.round(period);
  const kern = Array.from({length: 2 * half + 1}, (_, i) => Math.exp(-0.5 * (((i - half) * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < n) s += onset[j] * kern[k + half]; }
    local[i] = s;
  }
  const lo = Math.round(-2 * period), hi = Math.round(-period / 2);
  const txwt = new Float64Array(hi - lo + 1);
  for (let w = lo; w <= hi; w++) txwt[w - lo] = -tightness * Math.log(-w / period) ** 2;
  const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let first = true;
  const thresh = 0.01 * Math.max(...local);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, arg = -1;
    for (let w = lo; w <= hi; w++) {
      const j = i + w;
      if (j < 0) continue;
      const s = cum[j] + txwt[w - lo];
      if (s > best) { best = s; arg = j; }
    }
    cum[i] = local[i] + (arg >= 0 ? best : 0);
    // Don't link the first beats back to silence.
    if (first && local[i] < thresh) back[i] = -1;
    else { back[i] = arg; first = false; }
  }
  // Last beat: the latest local maximum of the cumulative score above half its median.
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
  const med = maxima.length ? [...maxima].sort((a, b) => a - b)[Math.floor(maxima.length / 2)] : 0;
  let end = n - 1;
  for (let i = n - 2; i > 0; i--) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1] && cum[i] >= 0.5 * med) { end = i; break; }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) beats.unshift(i);
  // Trim weak beats at both ends (below half the RMS of the local score at beats).
  const rms = Math.sqrt(mean(beats.map((b) => local[b] ** 2)));
  while (beats.length && local[beats[0]] < 0.5 * rms) beats.shift();
  while (beats.length && local[beats[beats.length - 1]] < 0.5 * rms) beats.pop();
  return {beats, local};
};

/** Detects beats in decoded mono PCM. */
export const detectBeatsFromPcm = (pcm: Float32Array, sampleRate: number, opts: BeatOptions = {}): Omit<BeatGrid, 'file'> => {
  const o: Required<BeatOptions> = {sampleRate, startBpm: 120, minBpm: 60, maxBpm: 240, tightness: 100, ...opts};
  const hop = 256, nFft = 2048, fps = sampleRate / hop;
  const env = onsetEnvelope(pcm, sampleRate, hop, nFft);
  const period = estimatePeriod(env, fps, o);
  const {beats, local} = trackBeats(env, period, o.tightness);
  // Sub-frame peak of the local score around each beat.
  const fine = beats.map((b) => {
    const [a, c, d] = [local[b - 1] ?? local[b], local[b], local[b + 1] ?? local[b]];
    const den = a - 2 * c + d;
    return b + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0);
  });
  // Smooth against neighbours: each beat moves to a robust local line fit over ±4 beats (removes
  // frame jitter while following real tempo changes).
  const K = 4;
  const smooth = fine.map((_, i) => {
    const lo = Math.max(0, i - K), hi = Math.min(fine.length - 1, i + K);
    const xs: number[] = [], ys: number[] = [];
    for (let j = lo; j <= hi; j++) { xs.push(j); ys.push(fine[j]); }
    if (xs.length < 3) return fine[i];
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    xs.forEach((x, k) => { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) ** 2; });
    const slope = sxy / sxx, fit = my + slope * (i - mx);
    // Keep a genuinely shifted beat (fit far from the detected onset) where it was detected.
    return Math.abs(fit - fine[i]) < 0.25 * period ? fit : fine[i];
  });
  // A centred window starts to see an onset half a window before it happens; shift by n_fft/2 so beats
  // land on the attack (the same compensation librosa's onset_strength applies).
  const times = smooth.map((f) => Math.round((((f * hop) + nFft / 2) / sampleRate) * 1000) / 1000);
  const iv = times.slice(1).map((t, i) => t - times[i]);
  const duration = pcm.length / sampleRate;
  const tempo = iv.length ? 60 / [...iv].sort((a, b) => a - b)[Math.floor(iv.length / 2)] : (60 * fps) / period;
  // Downbeats: the phase (of 4) whose beats carry the most low-frequency onset energy.
  let phase = 0, bestE = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let e = 0, c = 0;
    for (let i = ph; i < beats.length; i += 4) { e += local[beats[i]]; c++; }
    if (c && e / c > bestE) { bestE = e / c; phase = ph; }
  }
  const loud: number[] = [];
  for (let s = 0; s + sampleRate <= pcm.length; s += sampleRate) {
    let e = 0;
    for (let i = s; i < s + sampleRate; i++) e += pcm[i] * pcm[i];
    loud.push(Math.round(10 * 10 * Math.log10(Math.max(e / sampleRate, 1e-12))) / 10);
  }
  return {
    duration: Math.round(duration * 10) / 10,
    tempo: Math.round(tempo * 10) / 10,
    beat_regularity_ms: Math.round(std(iv) * 10000) / 10,
    first_beat: times[0] ?? 0,
    beats: times,
    bars: times.filter((_, i) => i % 4 === phase),
    loudness_db_per_sec: loud,
  };
};

/** Detects tempo and beats of an audio (or video) file; the result is a `.beats.json` document. */
export const detectBeats = async (file: string, opts: BeatOptions = {}): Promise<BeatGrid> => {
  const sr = opts.sampleRate ?? 22050;
  const pcm = await decodeMono(file, sr);
  if (pcm.length < sr) throw new Error(`${file}: too short for beat detection`);
  return {file, ...detectBeatsFromPcm(pcm, sr, opts)};
};
