// CustomerPro Video — main process (D1): windows, menus, customerpro-video:// links, single instance,
// the CustomerPro session, sync, and the engine (utility process).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions} from 'electron';
import {MediaUploader} from '../customerpro/upload.js';
import {SyncManager, type SyncStatus} from '../customerpro/sync.js';
import {findLinkedProject, readJson, readLink, safeFolderName} from '../engine/projects.js';
import type {Channel, Channels, EventName, Events} from '../shared/bridge.js';
import {directorIpc} from './director-ipc.js';
import {AccountManager} from './account.js';
import {parseDeepLink, PROTOCOL} from './deeplink.js';
import {EngineHost} from './engine-host.js';
import {initLog, log, logTail} from './logger.js';
import {downloadMissingMedia, openRemoteProject} from '../customerpro/media-sync.js';
import {applyCrashReporting, crashSubmitUrl, crashSummary} from './crash.js';
import {FinalExportFlow} from './export-flow.js';
import {SettingsStore} from './settings.js';
import {UpdateManager} from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/main
const DIST = path.resolve(here, '..');
const APP_VERSION = app.getVersion();
const SHELL_ORIGIN = 'app://shell';
const DEV = !app.isPackaged;
const SELFTEST = process.env.CPV_SELFTEST;
const SMOKE = process.env.CPV_SMOKE;

app.setName('CustomerPro Video');
if (process.env.CPV_USER_DATA) app.setPath('userData', process.env.CPV_USER_DATA);
// Opt-in crash reporting (5.6) starts before anything else can crash; off unless the owner turned it on.
const settings = new SettingsStore(app.getPath('userData'));
applyCrashReporting(settings.get().crashReports, {channel: settings.get().updateChannel});

protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true}},
  {scheme: 'cpv-media', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}},
]);

// Single instance: a second launch (or a customerpro-video:// link on Windows) goes to the running app.
if (!SELFTEST && !app.requestSingleInstanceLock()) app.exit(0);

const resourcesDir = () => (app.isPackaged ? process.resourcesPath : path.resolve(DIST, '..', 'resources'));
const userData = () => app.getPath('userData');

let win: BrowserWindow | undefined;
let engine: EngineHost;
let account: AccountManager;
let sync: SyncManager;
let exportFlow: FinalExportFlow;
let updater: UpdateManager;
let openDir: string | undefined;
let pendingLink: string | undefined;

const send = <E extends EventName>(event: E, data: Events[E]) => { if (win && !win.isDestroyed()) win.webContents.send(`evt:${event}`, data); };

// --- recents (projects opened outside the default root) --------------------------------------------------
const recentsFile = () => path.join(userData(), 'recents.json');
const recents = (): string[] => readJson<string[]>(recentsFile(), []).filter((d) => fs.existsSync(path.join(d, 'project.json')));
const addRecent = (dir: string) => {
  const list = [path.resolve(dir), ...recents().filter((d) => d !== path.resolve(dir))].slice(0, 30);
  fs.mkdirSync(userData(), {recursive: true});
  fs.writeFileSync(recentsFile(), JSON.stringify(list));
};
let projectsRoot = '';
const knownDir = (dir: string) => {
  const d = path.resolve(dir);
  return path.dirname(d) === path.resolve(projectsRoot) || recents().includes(d);
};
const requireKnown = (dir: string) => { if (!knownDir(dir)) throw new Error('Unknown project folder'); return path.resolve(dir); };

// --- shell + media protocols --------------------------------------------------------------------------------
const within = (child: string, parent: string) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const registerProtocols = () => {
  const rendererDir = path.join(DIST, 'renderer');
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'shell') return new Response('Not found', {status: 404});
    const file = path.join(rendererDir, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '') || 'index.html');
    if (!within(file, rendererDir) && file !== path.join(rendererDir, 'index.html')) return new Response('Forbidden', {status: 403});
    return net.fetch(pathToFileURL(fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(rendererDir, 'index.html')).href);
  });
  // Thumbnails, contact sheets, prepared media and renders of known projects only.
  protocol.handle('cpv-media', (req) => {
    const u = new URL(req.url);
    const file = path.resolve(decodeURIComponent(u.pathname.slice(1)));
    // The project folder that holds the file: the open one, a recent one, or a folder directly under the root.
    let dir = [openDir, ...recents()].find((d) => d && within(file, d));
    if (!dir && within(file, projectsRoot)) dir = path.join(projectsRoot, path.relative(projectsRoot, file).split(path.sep)[0]);
    const ok = dir && fs.existsSync(path.join(dir, 'project.json')) && /^(\.cache|media|renders)$/.test(path.relative(dir, file).split(path.sep)[0]);
    if (!ok) return new Response('Forbidden', {status: 403});
    return net.fetch(pathToFileURL(file).href, {headers: req.headers});
  });
};

// --- window ---------------------------------------------------------------------------------------------
const createWindow = () => {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, title: 'CustomerPro Video', backgroundColor: '#14110f',
    show: !SMOKE || !!process.env.CPV_SMOKE_SHOW,
    webPreferences: {
      preload: path.join(DIST, 'preload', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // Studio runs in an iframe from 127.0.0.1; it never gets the preload (frames don't).
    },
  });
  win.webContents.setWindowOpenHandler(({url}) => {
    if (/^https:\/\//.test(url) || url.startsWith(account.client.baseUrl)) void shell.openExternal(url);
    return {action: 'deny'};
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${SHELL_ORIGIN}/`)) e.preventDefault(); });
  void win.loadURL(`${SHELL_ORIGIN}/index.html`);
  win.on('closed', () => { win = undefined; });
};

// --- menus ----------------------------------------------------------------------------------------------
const buildMenu = () => {
  const mac = process.platform === 'darwin';
  const t: MenuItemConstructorOptions[] = [
    ...(mac ? [{label: 'CustomerPro Video', submenu: [{role: 'about'}, {type: 'separator'}, {role: 'services'}, {type: 'separator'}, {role: 'hide'}, {role: 'hideOthers'}, {role: 'unhide'}, {type: 'separator'}, {role: 'quit'}]} as MenuItemConstructorOptions] : []),
    {label: 'File', submenu: [
      {label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => send('menu', {action: 'new'})},
      {label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', {action: 'open'})},
      {label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: () => send('menu', {action: 'import'})},
      {type: 'separator'},
      {label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('menu', {action: 'close'})},
      ...(mac ? [] : [{type: 'separator'} as MenuItemConstructorOptions, {role: 'quit'} as MenuItemConstructorOptions]),
    ]},
    {role: 'editMenu'},
    {label: 'View', submenu: [{role: 'reload'}, ...(DEV ? [{role: 'toggleDevTools'} as MenuItemConstructorOptions] : []), {type: 'separator'}, {role: 'resetZoom'}, {role: 'zoomIn'}, {role: 'zoomOut'}, {type: 'separator'}, {role: 'togglefullscreen'}]},
    {role: 'windowMenu'},
    {role: 'help', submenu: [
      {label: 'Export Diagnostics…', click: () => void exportDiagnostics()},
      {label: 'Show Logs', click: () => void shell.openPath(path.join(userData(), 'logs'))},
      {label: 'CustomerPro Help', click: () => void shell.openExternal(`${account.client.baseUrl}/help`)},
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
};

// --- diagnostics (no media, no project text, no tokens) --------------------------------------------------
const collectDiagnostics = async () => {
  let engineDiag: unknown;
  try { engineDiag = await engine.call('diagnostics', undefined as never, 10000); } catch (e) { engineDiag = {error: (e as Error).message}; }
  let gpu: unknown;
  try { gpu = await app.getGPUInfo('basic'); } catch { gpu = undefined; }
  const acc = account.state();
  return {
    createdAt: new Date().toISOString(),
    app: {name: 'CustomerPro Video', version: APP_VERSION, packaged: app.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, engineMode: engine.mode},
    os: {platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1e9)},
    gpu, gpuFeatures: app.getGPUFeatureStatus(),
    account: {signedIn: acc.signedIn, mode: acc.access.mode, online: acc.online, workspaceId: acc.me?.workspace.id, plan: acc.me?.plan.name, baseUrl: acc.baseUrl},
    engine: engineDiag,
    updates: updater?.get(), crashReports: crashSummary(),
    mainLog: logTail(500),
  };
};
const exportDiagnostics = async (target?: string) => {
  const data = await collectDiagnostics();
  let file = target;
  if (!file) {
    const r = await dialog.showSaveDialog({defaultPath: path.join(app.getPath('desktop'), `CustomerPro-Video-diagnostics-${new Date().toISOString().slice(0, 10)}.json`), filters: [{name: 'JSON', extensions: ['json']}]});
    if (r.canceled || !r.filePath) return {};
    file = r.filePath;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return {file};
};

// --- deep links: customerpro-video://open?project=ID&org=ID ----------------------------------------------
const handleDeepLink = async (url: string) => {
  const link = parseDeepLink(url);
  if (!link) { log('warn', `ignored link ${url.slice(0, 80)}`); return; }
  if (!win) { pendingLink = url; return; }
  win.show();
  const acc = account.state();
  if (!acc.access.canSync) { pendingLink = url; send('account', acc); return; }
  try {
    // Not on this computer → new folder, project.json from the web, then the media it has (D9, 3.8).
    const r = await openRemoteProject({client: account.client, sync, projectId: link.project, orgId: link.org ?? acc.me?.workspace.id ?? '', root: projectsRoot, extra: recents(),
      onProgress: (p) => send('progress', {task: 'download', done: p.fileIndex, total: p.files, label: p.path})});
    send('progress', {task: 'download', done: 1, total: 1});
    const dir = r.dir;
    if (r.mediaError || r.media?.failed.length) log('warn', `media download: ${r.mediaError ?? r.media!.failed.map((f) => `${f.path}: ${f.error}`).join('; ')}`);
    addRecent(dir);
    send('open', {dir});
  } catch (e) {
    log('error', 'deep link failed', e);
    void dialog.showMessageBox({type: 'error', message: 'Could not open the project from CustomerPro', detail: (e as Error).message});
  }
};

// --- IPC ------------------------------------------------------------------------------------------------
// AI director (tasks 4.2–4.5): director:* channels, director events, engine host calls (src/main/director-ipc.ts).
const director = directorIpc({engine: () => engine, account: () => account, sync: () => sync, requireKnown, send,
  knownDirs: () => [openDir, ...recents(), projectsRoot].filter((x): x is string => !!x)});
type Handler<C extends Channel> = (p: Channels[C]['in']) => Promise<Channels[C]['out']> | Channels[C]['out'];
const handlers: {[C in Channel]: Handler<C>} = {
  'app:info': async () => {
    const i = await engine.call('info', undefined as never).catch(() => undefined);
    return {version: APP_VERSION, electron: process.versions.electron, engine: engine.mode, ffmpeg: i?.ffmpeg.version, ffmpegLgpl: i?.ffmpeg.lgpl, projectsRoot, dev: DEV};
  },
  'app:openExternal': ({url}) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only web links');
    if (!url.startsWith(account.client.baseUrl) && !/^https:\/\/([\w-]+\.)*customerpro\.in\//.test(url)) throw new Error('Only CustomerPro links');
    void shell.openExternal(url);
  },
  'app:reveal': ({path: p}) => { if (!openDir || !within(path.resolve(p), openDir)) throw new Error('Outside the project'); shell.showItemInFolder(p); },
  'app:diagnostics': () => exportDiagnostics(),
  'projects:list': () => engine.call('listProjects', {extra: recents()}),
  'projects:create': async (p) => { const s = await engine.call('createProject', p); addRecent(s.dir); return s; },
  'projects:openDialog': async () => {
    const r = await dialog.showOpenDialog(win!, {title: 'Open a CustomerPro Video project folder', properties: ['openDirectory']});
    if (r.canceled || !r.filePaths[0]) return null;
    if (!fs.existsSync(path.join(r.filePaths[0], 'project.json'))) throw new Error('That folder is not a CustomerPro Video project (no project.json)');
    addRecent(r.filePaths[0]);
    return (await engine.call('listProjects', {extra: [r.filePaths[0]]})).find((s) => s.dir === path.resolve(r.filePaths[0])) ?? null;
  },
  'projects:open': async ({dir}) => {
    const d = requireKnown(dir);
    const acc = account.access();
    if (acc.mode === 'signed-out' || acc.mode === 'upgrade') throw new Error(acc.reason ?? 'Sign in first');
    let s: SyncStatus = sync.getStatus(d);
    if (readLink(d) && acc.canSync) s = await sync.pull(d).catch((e) => ({state: 'error', message: (e as Error).message}) as SyncStatus); // pull on open (D9)
    const r = await engine.call('openProject', {dir: d, readOnly: !acc.canEdit, parentOrigin: SHELL_ORIGIN});
    openDir = d;
    addRecent(d);
    return {...r, sync: s};
  },
  'projects:close': async () => { await engine.call('closeProject', undefined as never); openDir = undefined; },
  'projects:rename': async ({dir, name}) => {
    const d = requireKnown(dir);
    const s = await engine.call('renameProject', {dir: d, name});
    const list = recents().map((x) => (x === d ? s.dir : x));
    fs.writeFileSync(recentsFile(), JSON.stringify(list));
    if (openDir === d) openDir = undefined;
    return s;
  },
  'projects:trash': async ({dir}) => {
    const d = requireKnown(dir);
    if (openDir === d) { await engine.call('closeProject', undefined as never); openDir = undefined; }
    await shell.trashItem(d); // to the Trash / Recycle Bin, never a hard delete
    fs.writeFileSync(recentsFile(), JSON.stringify(recents().filter((x) => x !== d)));
  },
  'media:list': ({dir}) => engine.call('listSources', {dir: requireKnown(dir)}),
  'media:importDialog': async ({dir, folders}) => {
    const r = await dialog.showOpenDialog(win!, {title: folders ? 'Add a folder of footage' : 'Add footage, photos, music or a logo', properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: folders ? undefined : [{name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'mts', 'avi', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'svg', 'mp3', 'wav', 'm4a', 'aac', 'pdf']}, {name: 'All files', extensions: ['*']}]});
    if (r.canceled || !r.filePaths.length) return null;
    const res = await engine.call('importMedia', {dir: requireKnown(dir), paths: r.filePaths});
    send('media', {dir});
    return {added: res.added.length, skipped: res.skipped};
  },
  'media:importPaths': async ({dir, paths}) => {
    const res = await engine.call('importMedia', {dir: requireKnown(dir), paths: paths.filter((p) => path.isAbsolute(p) && fs.existsSync(p))});
    send('media', {dir});
    return {added: res.added.length, skipped: res.skipped};
  },
  'media:locate': async ({dir, id}) => {
    const r = await dialog.showOpenDialog(win!, {title: 'Locate the missing file', properties: ['openFile']});
    if (r.canceled || !r.filePaths[0]) return null;
    const res = await engine.call('locateSource', {dir: requireKnown(dir), id, path: r.filePaths[0]});
    send('media', {dir});
    return res;
  },
  'media:remove': async ({dir, id}) => { await engine.call('removeSource', {dir: requireKnown(dir), id}); send('media', {dir}); },
  'media:analyse': async ({dir, ids}) => { const r = await engine.call('analyse', {dir: requireKnown(dir), ids}); send('media', {dir}); return r; },
  'media:analysis': ({dir}) => engine.call('analysis', {dir: requireKnown(dir)}),
  'media:cancel': async ({task}) => { await engine.call('cancelTask', {task}); },
  'footage:addToTimeline': (p) => {
    if (!account.access().canEdit) throw new Error('Read-only: you cannot edit this project');
    return engine.call('addToTimeline', {...p, dir: requireKnown(p.dir)});
  },
  'export:preview': ({dir}) => engine.call('startPreviewExport', {dir: requireKnown(dir)}),
  'export:cancel': async ({id}) => { await engine.call('cancelExport', {id}); },
  'account:get': () => account.state(),
  'account:signIn': () => account.startSignIn((url) => void shell.openExternal(url)),
  'account:cancelSignIn': () => account.cancelSignIn(),
  'account:signOut': () => account.signOut(),
  'account:refresh': () => account.refresh(),
  'sync:status': ({dir}) => sync.getStatus(requireKnown(dir)),
  'sync:remoteProjects': async () => (await account.client.listProjects()).data,
  'sync:link': ({dir, projectId}) => sync.link(requireKnown(dir), {projectId, orgId: account.state().me?.workspace.id ?? ''}),
  'sync:unlink': ({dir}) => sync.unlink(requireKnown(dir)),
  'sync:pull': ({dir}) => sync.pull(requireKnown(dir)),
  'sync:push': ({dir}) => sync.push(requireKnown(dir)),
  'sync:resolve': async ({dir, choice}) => { const r = await sync.resolveConflict(requireKnown(dir), choice); return {copy: r.copy}; },
  'sync:uploadMedia': async ({dir}) => {
    const d = requireKnown(dir);
    if (!account.access().canEdit) throw new Error('Uploading media needs Video edit access');
    return new MediaUploader(account.client, d).uploadAll({onProgress: (p) => send('upload', {dir: d, ...p})});
  },
  ...director.handlers,
  'export:quote': ({dir}) => exportFlow.quote(requireKnown(dir)),
  'export:final': (p) => exportFlow.start(requireKnown(p.dir), {preset: p.preset, whatsapp: !!p.whatsapp, autoPublish: p.autoPublish !== false}),
  'publish:start': ({dir, exportId}) => exportFlow.publish(requireKnown(dir), exportId),
  'publish:cancel': ({exportId}) => exportFlow.cancelPublish(exportId),
  'media:downloadRemote': async ({dir}) => {
    const d = requireKnown(dir);
    if (!account.access().canSync) throw new Error(account.access().reason ?? 'Sign in to download media');
    const r = await downloadMissingMedia(account.client, d, {onProgress: (p) => send('progress', {task: 'download', done: p.fileIndex, total: p.files, label: p.path})});
    send('progress', {task: 'download', done: 1, total: 1});
    send('media', {dir: d});
    return r;
  },
  'updater:status': () => updater.get(),
  'updater:check': () => updater.check(),
  'updater:install': () => updater.install(),
  'settings:get': () => ({...settings.get(), crashReportsAvailable: !!crashSubmitUrl()}),
  'settings:set': (p) => {
    const s = settings.set({...(p.updateChannel ? {updateChannel: p.updateChannel === 'beta' ? 'beta' : 'stable'} : {}), ...(p.crashReports !== undefined ? {crashReports: !!p.crashReports} : {})});
    if (p.crashReports !== undefined) applyCrashReporting(s.crashReports, {channel: s.updateChannel});
    if (p.updateChannel) updater.setChannel(s.updateChannel);
    return {...s, crashReportsAvailable: !!crashSubmitUrl()};
  },
};

const registerIpc = () => {
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (e, payload) => {
      // Only the shell page may call in (not Studio's frame, not anything else).
      if (!e.senderFrame || !e.senderFrame.url.startsWith(`${SHELL_ORIGIN}/`)) throw new Error('Forbidden');
      try { return await (fn as (p: unknown) => unknown)(payload); } catch (err) { log('warn', `${ch} failed: ${(err as Error).message}`); throw err; }
    });
  }
};

// --- start ----------------------------------------------------------------------------------------------
const startServices = async () => {
  initLog(path.join(userData(), 'logs'));
  log('info', `CustomerPro Video ${APP_VERSION} (electron ${process.versions.electron}, ${process.platform}-${process.arch})`);
  account = new AccountManager(userData(), APP_VERSION, process.env.CUSTOMERPRO_URL);
  await account.init();
  sync = new SyncManager({client: account.client, canSync: () => account.access().canSync && account.state().online !== false, blockedReason: () => account.access().reason ?? 'Offline', onStatus: (dir, status) => send('sync', {dir, status})});
  engine = new EngineHost(path.join(DIST, 'engine', 'index.js'), {CPV_RESOURCES: resourcesDir(), ...(process.env.CPV_PROJECTS_ROOT ? {CPV_PROJECTS_ROOT: process.env.CPV_PROJECTS_ROOT} : {})});
  engine.start();
  director.attach();
  engine.onEvent('progress', (d) => send('progress', d));
  engine.onEvent('export', (d) => send('export', d));
  engine.onEvent('projectChanged', (d) => { if (account.access().canSync) sync.schedulePush(d.dir); });
  engine.on('crashed', () => { openDir = undefined; send('engine', {state: 'crashed'}); });
  exportFlow = new FinalExportFlow({engine, account, sync, settings, send});
  updater = new UpdateManager(settings.get().updateChannel);
  updater.on('status', (st) => send('updater', st));
  account.on('changed', (s) => {
    send('account', s);
    void engine.call('setStudioOptions', {readOnly: !s.access.canEdit}).catch(() => undefined);
    if (pendingLink && s.access.canSync) { const l = pendingLink; pendingLink = undefined; void handleDeepLink(l); }
    if (s.access.mode === 'update-required') void updater.check(); // min_version from /me: fetch the update now
  });
  projectsRoot = (await engine.call('info', undefined as never, 30000)).projectsRoot;
};

if (process.platform === 'darwin') app.on('open-url', (e, url) => { e.preventDefault(); void (app.isReady() ? handleDeepLink(url) : (pendingLink = url)); });
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (url) void handleDeepLink(url);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
const argvLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
if (argvLink) pendingLink = argvLink;

app.whenReady().then(async () => {
  if (!SELFTEST && !SMOKE) {
    if (DEV && process.argv[1]) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient(PROTOCOL);
  }
  await startServices();
  if (SELFTEST) {
    const {runSelfTest} = await import('./selftest.js');
    const code = await runSelfTest({engine, out: SELFTEST, diagnostics: collectDiagnostics});
    engine.stop();
    setTimeout(() => app.exit(code), 300);
    return;
  }
  registerProtocols();
  registerIpc();
  buildMenu();
  account.start();
  void updater.start().catch((e) => log("warn", "updater failed to start", e));
  createWindow();
  if (SMOKE) {
    const {runSmoke} = await import('./smoke.js');
    void runSmoke({win: win!, out: SMOKE, engine, send, addRecent, account}).then((code) => { engine.stop(); setTimeout(() => app.exit(code), 300); });
  }
  if (pendingLink) win!.webContents.once('did-finish-load', () => { const l = pendingLink!; pendingLink = undefined; void handleDeepLink(l); });
}).catch((e) => { log('error', 'startup failed', e); console.error(e); app.exit(1); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SMOKE) app.quit(); });
app.on('activate', () => { if (!win && app.isReady() && !SELFTEST) createWindow(); });
app.on('before-quit', () => { account?.stop(); sync?.dispose(); updater?.stop(); engine?.stop(); });
