import {useEffect, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import {call, errMsg} from './api.js';
import type {AppSettings} from '../shared/publish.js';

export const Logo = () => (
  <div class="logo">
    <svg viewBox="0 0 32 32" width="28" height="28"><rect width="32" height="32" rx="8" fill="#e8692a" /><path d="M12 9l12 7-12 7z" fill="#fff" /></svg>
    <span>CustomerPro <b>Video</b></span>
  </div>
);

export const SignIn = ({account}: {account: AccountState}) => {
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState('');
  const pending = account.signIn && 'user_code' in account.signIn ? account.signIn : undefined;
  const failed = account.signIn && 'error' in account.signIn ? account.signIn.error : '';
  const start = async () => {
    setErr('');
    setWaiting(true);
    try { await call('account:signIn'); } catch (e) { setErr(errMsg(e)); } finally { setWaiting(false); }
  };
  return (
    <div class="center">
      <div class="card signin">
        <Logo />
        <h1>Sign in with CustomerPro</h1>
        <p class="muted">Your CustomerPro workspace needs the Video app. Projects stay on this computer; you approve this device on customerpro.in.</p>
        {pending ? (
          <>
            <p>Enter or confirm this code on CustomerPro:</p>
            <div class="code">{pending.user_code}</div>
            <p class="muted small">We opened <a href="#" onClick={(e) => { e.preventDefault(); void call('app:openExternal', {url: pending.verification_url}); }}>{pending.verification_url}</a> in your browser. Waiting for approval…</p>
            <button onClick={() => void call('account:cancelSignIn')}>Cancel</button>
          </>
        ) : (
          <button class="primary big" disabled={waiting} onClick={start}>{waiting ? 'Starting…' : 'Sign in'}</button>
        )}
        {(err || failed) && <p class="error-text">{err || failed}</p>}
        <p class="muted small">Server: {account.baseUrl}</p>
      </div>
    </div>
  );
};

export const Upgrade = ({account}: {account: AccountState}) => (
  <div class="center">
    <div class="card signin">
      <Logo />
      <h1>CustomerPro Video isn't on your plan</h1>
      <p class="muted">{account.access.reason}.</p>
      <ul class="features">
        <li>Turn a folder of raw drone and phone footage into a vertical reel</li>
        <li>The same Studio editor as the web, with motion graphics and titles</li>
        <li>An AI director that plans, builds and edits with you (coming soon)</li>
        <li>Publish straight to your Media Library, posts and WhatsApp</li>
      </ul>
      <button class="primary big" onClick={() => void call('app:openExternal', {url: `${account.baseUrl}/billing/plans?app=video`})}>Upgrade on CustomerPro</button>
      <p><button class="link" onClick={() => void call('account:refresh')}>I've upgraded — check again</button> · <button class="link" onClick={() => void call('account:signOut')}>Use another account</button></p>
    </div>
  </div>
);

export const AccountPanel = ({account, onClose}: {account: AccountState; onClose: () => void}) => {
  const me = account.me;
  const [info, setInfo] = useState<{version: string; electron: string; engine: string; ffmpeg?: string; ffmpegLgpl?: boolean; projectsRoot: string} | null>(null);
  const [msg, setMsg] = useState('');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => { call('settings:get').then(setSettings).catch(() => undefined); }, []);
  const change = async (p: Partial<AppSettings>) => { try { setSettings(await call('settings:set', p)); } catch (e) { setMsg(errMsg(e)); } };
  useEffect(() => { call('app:info').then(setInfo); }, []);
  return (
    <div class="modal-bg" onClick={onClose}>
      <div class="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Account</h2>
        {me ? (
          <table class="kv">
            <tr><td>Signed in as</td><td>{me.user.name} · {me.user.email}</td></tr>
            <tr><td>Workspace</td><td>{me.workspace.name}</td></tr>
            <tr><td>Plan</td><td>{me.plan.name}</td></tr>
            <tr><td>Access</td><td>{account.access.mode === 'full' ? 'Edit' : account.access.mode}{account.access.canExport ? ' · Export' : ' · No publishing'}</td></tr>
            <tr><td>Credits</td><td>{me.credits.balance}</td></tr>
            <tr><td>Videos this month</td><td>{me.allowance.used} of {me.allowance.videos_per_month}</td></tr>
          </table>
        ) : <p class="muted">Not signed in.</p>}
        {info && <p class="muted small">Version {info.version} · Electron {info.electron} · engine: {info.engine} · {info.ffmpeg?.split(' Copyright')[0]}{info.ffmpegLgpl === false ? ' (GPL build: development only)' : ''}<br />Projects folder: {info.projectsRoot}</p>}
        {settings && (
          <div class="settings">
            <label class="check"><input type="checkbox" data-testid="crash-reports" checked={settings.crashReports} disabled={!settings.crashReportsAvailable} onChange={(e) => void change({crashReports: (e.target as HTMLInputElement).checked})} /> Send crash reports to CustomerPro
              <span class="muted small"> · {settings.crashReportsAvailable ? 'only the crash data and app version: never your videos, footage or project text' : 'not available in this build'}</span></label>
            <label class="check"><input type="checkbox" checked={settings.updateChannel === 'beta'} onChange={(e) => void change({updateChannel: (e.target as HTMLInputElement).checked ? 'beta' : 'stable'})} /> Get beta updates</label>
          </div>
        )}
        {msg && <p class="muted small">{msg}</p>}
        <div class="row">
          <button onClick={async () => { const r = await call('app:diagnostics'); if (r.file) setMsg(`Diagnostics saved to ${r.file}`); }}>Export diagnostics…</button>
          <span class="grow" />
          <button onClick={() => void call('account:signOut')}>Sign out</button>
          <button class="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};
