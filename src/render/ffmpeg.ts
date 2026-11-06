import {spawnSync} from 'node:child_process';

// Binaries DT.ly spawns. Hosts that bundle FFmpeg (the desktop app) point these at their own
// builds with DTLY_FFMPEG / DTLY_FFPROBE; read at call time so they can be set after import.
export const ffmpegPath = () => process.env.DTLY_FFMPEG || 'ffmpeg';
export const ffprobePath = () => process.env.DTLY_FFPROBE || 'ffprobe';

let checked = '';

// FFmpeg is required but not bundled (common static builds are GPL); fail early with a clear fix.
export const checkFfmpeg = () => {
  const bin = ffmpegPath();
  if (checked === bin) return;
  const r = spawnSync(bin, ['-version'], {encoding: 'utf8'});
  if (r.error || r.status !== 0) {
    throw new Error(
      (process.env.DTLY_FFMPEG ? `DT.ly could not run FFmpeg at DTLY_FFMPEG=${bin}.\n` : 'DT.ly needs FFmpeg on your PATH to read video and write MP4.\n') +
        '  macOS:   brew install ffmpeg\n' +
        '  Ubuntu:  sudo apt install ffmpeg\n' +
        '  Windows: winget install ffmpeg\n' +
        '  Or set DTLY_FFMPEG / DTLY_FFPROBE to the binaries.',
    );
  }
  checked = bin;
};
