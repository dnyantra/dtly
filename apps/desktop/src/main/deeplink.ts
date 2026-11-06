// customerpro-video:// links (D9 "Open in desktop app"): customerpro-video://open?project=ID&org=ID
export const PROTOCOL = 'customerpro-video';

export interface DeepLink { action: 'open'; project: string; org?: string }

export const parseDeepLink = (url: string): DeepLink | undefined => {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== `${PROTOCOL}:`) return undefined;
  // "customerpro-video://open?…" parses with host "open"; tolerate "customerpro-video:open?…" and a trailing slash.
  const action = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '');
  if (action !== 'open') return undefined;
  const project = u.searchParams.get('project') ?? '';
  const org = u.searchParams.get('org') ?? undefined;
  if (!/^[\w-]{1,64}$/.test(project) || (org !== undefined && !/^[\w-]{1,64}$/.test(org))) return undefined;
  return {action: 'open', project, org};
};
