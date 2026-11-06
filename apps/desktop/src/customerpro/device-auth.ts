// Device-code sign-in (D5): show the code, open customerpro.in/desktop/link?code=…, poll until approved.
import {CustomerProClient, type DeviceStart, type TokenResult} from './client.js';

export class SignInError extends Error {
  constructor(public code: 'expired' | 'denied' | 'cancelled', message: string) { super(message); this.name = 'SignInError'; }
}

export interface SignInOptions {
  deviceName: string;
  platform: 'win' | 'mac';
  appVersion: string;
  onCode: (s: DeviceStart) => void; // UI shows user_code and opens verification_url
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // tests shorten the wait
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new SignInError('cancelled', 'Sign-in cancelled')); }, {once: true});
});

export const signInWithDeviceCode = async (client: CustomerProClient, o: SignInOptions): Promise<TokenResult> => {
  const start = await client.deviceStart({device_name: o.deviceName, platform: o.platform, app_version: o.appVersion});
  o.onCode(start);
  const sleep = o.sleep ?? defaultSleep;
  let interval = Math.max(1, start.interval || 5) * 1000;
  const deadline = Date.now() + (start.expires_in || 600) * 1000;
  for (;;) {
    if (o.signal?.aborted) throw new SignInError('cancelled', 'Sign-in cancelled');
    await sleep(interval, o.signal);
    const r = await client.devicePoll(start.device_code);
    if (r.status === 'ok') { const {status: _s, ...token} = r; return token; }
    if (r.status === 'slow_down') interval += 5000;
    if (r.status === 'denied') throw new SignInError('denied', 'Sign-in was denied on CustomerPro');
    if (r.status === 'expired' || Date.now() > deadline) throw new SignInError('expired', 'The sign-in code expired. Try again.');
  }
};
