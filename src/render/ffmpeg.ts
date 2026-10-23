import {spawnSync} from 'node:child_process';

let checked = false;

// FFmpeg is required but not bundled (common static builds are GPL); fail early with a clear fix.
export const checkFfmpeg = () => {
  if (checked) return;
  const r = spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'});
  if (r.error || r.status !== 0) {
    throw new Error(
      'DT.ly needs FFmpeg on your PATH to read video and write MP4.\n' +
        '  macOS:   brew install ffmpeg\n' +
        '  Ubuntu:  sudo apt install ffmpeg\n' +
        '  Windows: winget install ffmpeg',
    );
  }
  checked = true;
};
