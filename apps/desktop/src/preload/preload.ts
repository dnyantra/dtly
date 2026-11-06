// Preload bridge: the only way the shell UI reaches the app. Channels are allow-listed; no Node objects leak.
import {contextBridge, ipcRenderer, webUtils} from 'electron';
import {CHANNELS, EVENTS, type CpvBridge} from '../shared/bridge.js';

const channels = new Set<string>(CHANNELS);
const events = new Set<string>(EVENTS);

const bridge: CpvBridge = {
  invoke: (channel, payload) => {
    if (!channels.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on: (event, fn) => {
    if (!events.has(event)) throw new Error(`Blocked event ${event}`);
    const h = (_e: unknown, d: unknown) => fn(d as never);
    ipcRenderer.on(`evt:${event}`, h);
    return () => { ipcRenderer.removeListener(`evt:${event}`, h); };
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
};
contextBridge.exposeInMainWorld('cpv', bridge);
