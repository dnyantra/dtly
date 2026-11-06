export interface FfmpegInfoLite { ffmpeg: string; ffprobe: string; version: string; lgpl: boolean; h264: string[]; hwaccels: string[] }

// semver-ish compare: '0.10.1' > '0.9.9'
export const compareVersions = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// Logs never carry tokens (D14).
export const redact = (s: string) =>
  s.replace(/(Bearer\s+)[\w.\-|~+/=]+/gi, '$1[redacted]')
    .replace(/("?(?:token|device_code|access_token|authorization)"?\s*[:=]\s*"?)(?!Bearer\b|\[redacted\])[^"\s,}]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|X-Amz-Signature|X-Amz-Credential|signature)=)[^&\s"]+/gi, '$1[redacted]');
