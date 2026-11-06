import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import type {AccountState} from '../main/account.js';
import type {ProjectSummary} from '../shared/types.js';
import {call, errMsg, on} from './api.js';
import {Home} from './Home.js';
import {ProjectView} from './Project.js';
import {SignIn, Upgrade} from './Account.js';
import {UpdateBanner} from './UpdateBanner.js';
import './styles.css';

document.body.dataset.platform = window.cpv?.platform ?? '';

const App = () => {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [project, setProject] = useState<{summary: ProjectSummary; studioUrl: string} | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('account:get').then(setAccount);
    const offs = [
      on('account', setAccount),
      on('open', ({dir}) => void open(dir)),
      on('menu', ({action}) => { if (action === 'close' || action === 'home') void close(); }),
      on('engine', ({state}) => { if (state === 'crashed') { setProject(null); setError('The engine stopped and was restarted. Reopen your project.'); } }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  const open = async (dir: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await call('projects:open', {dir});
      setProject({summary: r.project, studioUrl: r.studioUrl});
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const close = async () => { await call('projects:close').catch(() => undefined); setProject(null); };

  const mode = account?.access.mode;
  const view = !account ? 'loading' : mode === 'signed-out' ? 'signin' : mode === 'upgrade' ? 'upgrade' : project ? 'project' : 'home';
  useEffect(() => { document.body.dataset.view = view; }, [view]);

  return (
    <div class="app">
      {error && <div class="toast error" onClick={() => setError('')}>{error}<span class="x">×</span></div>}
      {account && <UpdateBanner account={account} />}
      {account && !account.online && account.signedIn && <div class="banner">Offline. Editing, preview export and footage preparation work; sync waits for the connection.</div>}
      {view === 'loading' && <div class="center muted">Starting…</div>}
      {view === 'signin' && <SignIn account={account!} />}
      {view === 'upgrade' && <Upgrade account={account!} />}
      {view === 'home' && <Home account={account!} onOpen={open} busy={busy} />}
      {view === 'project' && project && <ProjectView account={account!} project={project.summary} studioUrl={project.studioUrl} onClose={close} />}
    </div>
  );
};

render(<App />, document.getElementById('root')!);
