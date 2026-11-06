// Update banner (task 5.4): "Restart to update" once an update is downloaded; when GET /me's min_version is
// above this version, the required-update notice (with download progress, or the download page as fallback).
// Also a slim "downloading media from CustomerPro" line for customerpro-video:// opens (3.8).
import {useEffect, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import type {UpdaterStatus} from '../shared/publish.js';
import {call, on} from './api.js';

export const UpdateBanner = ({account}: {account: AccountState}) => {
  const [u, setU] = useState<UpdaterStatus | null>(null);
  const [dl, setDl] = useState<{done: number; total: number; label?: string} | null>(null);
  useEffect(() => {
    call('updater:status').then(setU).catch(() => undefined);
    const offs = [
      on('updater', setU),
      on('progress', (p) => { if (p.task === 'download') setDl(p.done >= p.total ? null : p); }),
    ];
    return () => offs.forEach((f) => f());
  }, []);
  const required = account.access.mode === 'update-required';
  const restart = <button class="link" onClick={() => void call('updater:install')}>Restart to update</button>;
  return (
    <>
      {dl && <div class="banner">Downloading media from CustomerPro {dl.done + 1}/{dl.total}{dl.label ? ` · ${dl.label}` : ''}…</div>}
      {u?.state === 'ready' ? (
        <div class={`banner ${required ? 'warn' : ''}`} data-testid="update-ready">{required ? `${account.access.reason}. ` : ''}Version {u.version} is ready. {restart}</div>
      ) : required ? (
        <div class="banner warn">{account.access.reason}. Local editing still works.{' '}
          {u?.state === 'downloading' ? `Downloading the update… ${u.percent ?? 0}%`
            : <a href="#" onClick={(e) => { e.preventDefault(); void call('app:openExternal', {url: `${account.baseUrl}/video/desktop`}); }}>Get the update</a>}
        </div>
      ) : null}
    </>
  );
};
