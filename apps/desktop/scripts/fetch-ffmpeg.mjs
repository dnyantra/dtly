// Places platform ffmpeg + ffprobe in resources/ffmpeg/<platform>-<arch>/ for packaging (D2: LGPL build,
// OS hardware codecs, run as a separate process). The engine finds them there (or via DTLY_FFMPEG/DTLY_FFPROBE).
//
//   node scripts/fetch-ffmpeg.mjs --win              Windows x64: BtbN LGPL static build (GitHub releases)
//   node scripts/fetch-ffmpeg.mjs --mac-build        macOS (this arch): compile FFmpeg from source, LGPL,
//                                                    --enable-videotoolbox --enable-audiotoolbox, no GPL libs
//   node scripts/fetch-ffmpeg.mjs --from <url|file>  any platform: a prebuilt zip/tar.xz you trust (e.g. an
//                                                    internal LGPL build on R2); --target <platform-arch>
//   node scripts/fetch-ffmpeg.mjs --system           dev only: copy the ffmpeg on PATH (often GPL + dylibs!)
//
// Options: --version 8.1 (FFmpeg release for --win/--mac-build), --sha256 <hex> to pin a download.
// Downloads go to a fresh temp folder; nothing downloaded is executed except the final `ffmpeg -version` check.
import {execFileSync, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const version = opt('--version', '8.1');
const exe = (n, plat) => (plat.startsWith('win32') ? `${n}.exe` : n);

const download = async (url, file) => {
  console.log(`downloading ${url}`);
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  console.log(`sha256 ${sum}`);
  const pin = opt('--sha256');
  if (pin && pin !== sum) throw new Error(`checksum mismatch (expected ${pin})`);
  return sum;
};

const extract = (archive, into) => {
  fs.mkdirSync(into, {recursive: true});
  // bsdtar (macOS, Windows 10+) reads zip and tar.xz.
  execFileSync('tar', ['-xf', archive, '-C', into]);
};

const findBin = (dir, name) => {
  for (const e of fs.readdirSync(dir, {withFileTypes: true, recursive: true})) {
    if (e.isFile() && e.name === name) return path.join(e.parentPath ?? e.path, e.name);
  }
  return undefined;
};

const place = (target, ffmpeg, ffprobe, info) => {
  const out = path.join(root, 'resources', 'ffmpeg', target);
  fs.rmSync(out, {recursive: true, force: true});
  fs.mkdirSync(out, {recursive: true});
  for (const [src, name] of [[ffmpeg, 'ffmpeg'], [ffprobe, 'ffprobe']]) {
    const dst = path.join(out, exe(name, target));
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
  fs.writeFileSync(path.join(out, 'BUILDINFO.json'), JSON.stringify({...info, placedAt: new Date().toISOString()}, null, 2));
  if (target === `${process.platform}-${process.arch}`) {
    const v = spawnSync(path.join(out, exe('ffmpeg', target)), ['-hide_banner', '-version'], {encoding: 'utf8'});
    const cfg = v.stdout ?? '';
    console.log(cfg.split('\n')[0]);
    console.log(/--enable-gpl/.test(cfg) ? 'WARNING: this is a GPL build (not for distribution without a licence review)' : 'licence: LGPL (no --enable-gpl)');
    const enc = spawnSync(path.join(out, exe('ffmpeg', target)), ['-hide_banner', '-encoders'], {encoding: 'utf8'}).stdout ?? '';
    console.log('H.264 encoders:', [...enc.matchAll(/^\s*V\S*\s+(\S*264\S*)/gm)].map((m) => m[1]).join(', ') || 'none');
  }
  console.log(`placed in ${path.relative(root, out)}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpv-ffmpeg-'));
try {
  if (has('--win')) {
    const name = `ffmpeg-n${version}-latest-win64-lgpl-${version}.zip`;
    const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${name}`;
    const zip = path.join(tmp, name);
    const sha = await download(url, zip);
    const x = path.join(tmp, 'x');
    extract(zip, x);
    place('win32-x64', findBin(x, 'ffmpeg.exe'), findBin(x, 'ffprobe.exe'), {source: url, sha256: sha, licence: 'LGPL-2.1+ (BtbN lgpl variant)'});
  } else if (has('--from')) {
    const src = opt('--from');
    const target = opt('--target', `${process.platform}-${process.arch}`);
    const file = path.join(tmp, path.basename(new URL(src, 'file:///').pathname) || 'ffmpeg-archive');
    const sha = /^https?:/.test(src) ? await download(src, file) : (fs.copyFileSync(src, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const x = path.join(tmp, 'x');
    extract(file, x);
    place(target, findBin(x, exe('ffmpeg', target)), findBin(x, exe('ffprobe', target)), {source: src, sha256: sha});
  } else if (has('--mac-build')) {
    if (process.platform !== 'darwin') throw new Error('--mac-build runs on macOS');
    // ffmpeg.org first; the GitHub mirror's release tag as a fallback.
    const sources = [[`https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`, `ffmpeg-${version}`], [`https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n${version}.tar.gz`, `FFmpeg-n${version}`]];
    let sha, src;
    for (const [url, dirName] of sources) {
      const tarball = path.join(tmp, path.basename(url));
      try { sha = await download(url, tarball); } catch (e) { console.log(`  ${e.cause?.code ?? e.message}; trying the next source`); continue; }
      extract(tarball, tmp);
      src = path.join(tmp, dirName);
      break;
    }
    if (!src) throw new Error('could not download the FFmpeg source');
    // LGPL: no --enable-gpl / --enable-nonfree; codecs from the OS (VideoToolbox, AudioToolbox); static libav*.
    const flags = ['--disable-gpl', '--disable-nonfree', '--enable-videotoolbox', '--enable-audiotoolbox', '--disable-doc', '--disable-ffplay',
      '--disable-debug', '--enable-static', '--disable-shared', '--disable-sdl2', '--disable-xlib', '--disable-libxcb', '--disable-iconv',
      '--disable-securetransport', '--disable-network', `--arch=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`, '--extra-cflags=-mmacosx-version-min=13.0', '--extra-ldflags=-mmacosx-version-min=13.0'];
    console.log(`configure ${flags.join(' ')}`);
    execFileSync('./configure', flags, {cwd: src, stdio: 'inherit'});
    execFileSync('make', [`-j${os.cpus().length}`], {cwd: src, stdio: 'inherit'});
    place(`darwin-${process.arch}`, path.join(src, 'ffmpeg'), path.join(src, 'ffprobe'), {source: `ffmpeg.org ${version} source`, sha256: sha, configure: flags, licence: 'LGPL-2.1+'});
  } else if (has('--system')) {
    const which = (n) => execFileSync(process.platform === 'win32' ? 'where' : 'which', [n]).toString().split('\n')[0].trim();
    place(`${process.platform}-${process.arch}`, fs.realpathSync(which('ffmpeg')), fs.realpathSync(which('ffprobe')), {source: 'system PATH (development only)'});
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n'));
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
