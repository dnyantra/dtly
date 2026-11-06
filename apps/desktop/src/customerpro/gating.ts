// What the signed-in workspace may do (D5): no Video → upgrade screen; no video.edit → read-only;
// no video.export → no publish; below min_version → online actions blocked until update.
import {compareVersions} from '../shared/misc.js';
import type {Access, Me} from '../shared/types.js';

export const computeAccess = (me: Me | undefined, appVersion: string): Access => {
  if (!me) return {mode: 'signed-out', canEdit: false, canExport: false, canSync: false, reason: 'Sign in with your CustomerPro account'};
  if (!me.video?.installed) return {mode: 'upgrade', canEdit: false, canExport: false, canSync: false, reason: `Your plan (${me.plan?.name ?? 'current'}) does not include CustomerPro Video`};
  const perms = me.video.permissions ?? {view: false, edit: false, export: false, delete: false};
  const canEdit = !!perms.edit;
  const canExport = !!perms.export;
  if (me.min_version && compareVersions(me.min_version, appVersion) > 0) {
    // Local editing still works; sync, AI and publishing wait for the update.
    return {mode: 'update-required', canEdit, canExport: false, canSync: false, reason: `Update to version ${me.min_version} or later to sync and publish`};
  }
  if (!canEdit) return {mode: 'read-only', canEdit: false, canExport, canSync: !!perms.view, reason: 'You can view projects but not edit them (ask the workspace owner for Video edit access)'};
  return {mode: 'full', canEdit: true, canExport, canSync: true};
};
