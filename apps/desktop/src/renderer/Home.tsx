import {useEffect, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import type {RemoteProjectRow} from '../customerpro/client.js';
import type {ProjectPreset, ProjectSummary} from '../shared/types.js';
import {AccountPanel, Logo} from './Account.js';
import {call, errMsg, fmtDur, mediaUrl, on} from './api.js';

const PRESETS: {id: ProjectPreset; label: string}[] = [
  {id: 'reel', label: 'Reel 9:16'}, {id: 'square', label: 'Square 1:1'}, {id: 'portrait', label: 'Portrait 4:5'}, {id: 'landscape', label: 'Landscape 16:9'},
];

export const Home = ({account, onOpen, busy}: {account: AccountState; onOpen: (dir: string) => void; busy: boolean}) => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [remote, setRemote] = useState<RemoteProjectRow[] | null>(null);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<ProjectPreset>('reel');
  const [err, setErr] = useState('');
  const [showAccount, setShowAccount] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = () => call('projects:list').then(setProjects).catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    void refresh();
    if (account.access.canSync) call('sync:remoteProjects').then(setRemote).catch(() => setRemote(null));
    return on('menu', ({action}) => {
      if (action === 'new') document.querySelector<HTMLInputElement>('#new-name')?.focus();
      if (action === 'open') void openFolder();
    });
  }, [account.access.canSync]);

  const create = async (e: Event) => {
    e.preventDefault();
    setErr('');
    try {
      const s = await call('projects:create', {name: name.trim() || 'Untitled reel', preset});
      setName('');
      onOpen(s.dir);
    } catch (x) { setErr(errMsg(x)); }
  };
  const openFolder = async () => { try { const s = await call('projects:openDialog'); if (s) onOpen(s.dir); } catch (x) { setErr(errMsg(x)); } };
  const rename = async (dir: string, newName: string) => { try { await call('projects:rename', {dir, name: newName}); setRenaming(null); void refresh(); } catch (x) { setErr(errMsg(x)); } };
  const trash = async (p: ProjectSummary) => {
    if (!confirm(`Move "${p.name}" to the Trash? Raw footage it references is not touched.`)) return;
    try { await call('projects:trash', {dir: p.dir}); void refresh(); } catch (x) { setErr(errMsg(x)); }
  };
  const openRemote = async (r: RemoteProjectRow) => {
    const local = projects.find((p) => p.linked && p.name === r.name);
    try {
      const s = local ?? (await call('projects:create', {name: r.name, preset: 'reel'}));
      if (!local) await call('sync:link', {dir: s.dir, projectId: r.id});
      onOpen(s.dir);
    } catch (x) { setErr(errMsg(x)); }
  };

  return (
    <div class="home">
      <header class="topbar">
        <Logo />
        <span class="grow" />
        {account.me && <button class="account-chip" onClick={() => setShowAccount(true)}>{account.me.workspace.name} · {account.me.user.name.split(' ')[0]}</button>}
      </header>
      <main class="home-main">
        <section class="card new-project">
          <h2>New project</h2>
          <form onSubmit={create} class="row">
            <input id="new-name" placeholder="Project name, e.g. KK Park launch reel" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <select value={preset} onChange={(e) => setPreset((e.target as HTMLSelectElement).value as ProjectPreset)}>
              {PRESETS.map((p) => <option value={p.id}>{p.label}</option>)}
            </select>
            <button class="primary" type="submit" disabled={busy || !account.access.canEdit}>Create</button>
            <button type="button" onClick={openFolder}>Open folder…</button>
          </form>
          {!account.access.canEdit && <p class="muted small">Read-only access: you can open projects but not create or edit them.</p>}
          {err && <p class="error-text">{err}</p>}
        </section>

        <h3>Recent projects</h3>
        {projects.length === 0 && <p class="muted">No projects yet. Create one above; it is a folder in your CustomerPro Video folder.</p>}
        <div class="grid">
          {projects.map((p) => (
            <div class="tile" key={p.dir}>
              <div class="poster" onClick={() => onOpen(p.dir)} style={p.width && p.height ? {aspectRatio: `${Math.min(p.width / p.height, 1.6)}`} : undefined}>
                {p.poster ? <img src={mediaUrl(p.poster)} /> : <span class="muted">{p.width}×{p.height}</span>}
              </div>
              {renaming === p.dir ? (
                <form onSubmit={(e) => { e.preventDefault(); void rename(p.dir, (e.currentTarget.elements.namedItem('n') as HTMLInputElement).value); }}>
                  <input name="n" value={p.name} autoFocus onBlur={() => setRenaming(null)} />
                </form>
              ) : <div class="tile-name" title={p.dir}>{p.name}</div>}
              <div class="muted small">{new Date(p.updatedAt).toLocaleString()} · {fmtDur(p.duration)}{p.linked ? ' · linked to CustomerPro' : ''}</div>
              <div class="row small-buttons">
                <button onClick={() => onOpen(p.dir)}>Open</button>
                <button onClick={() => setRenaming(p.dir)}>Rename</button>
                <button onClick={() => trash(p)}>Move to Trash</button>
              </div>
            </div>
          ))}
        </div>

        {remote && remote.length > 0 && (
          <>
            <h3>On CustomerPro</h3>
            <div class="list">
              {remote.map((r) => (
                <div class="list-row" key={String(r.id)}>
                  <span class="grow">{r.name}</span>
                  <span class="muted small">rev {r.rev}{r.last_edited_on ? ` · last edited on ${r.last_edited_on}` : ''}</span>
                  <button onClick={() => openRemote(r)}>Open on this computer</button>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
      {showAccount && <AccountPanel account={account} onClose={() => setShowAccount(false)} />}
    </div>
  );
};
