// The tray submenu drops "Allow always" for a permission that carries no save
// patterns (#4698). The tray rebuilds its menu only when `trayMenuKey` changes,
// so the flag has to be part of that signature too, or a snapshot whose only
// delta is `canSave` leaves the previous submenu on screen.
import { describe, expect, test } from 'bun:test';

import { buildTrayMenuTemplate, trayMenuKey } from './tray-menu.mjs';

const permission = (id, canSave) => ({
  kind: 'permission', id, sessionId: 's1', sessionTitle: 'Session',
  label: `bash: ${id}`, directory: '/repo', canSave,
});

const snapshotWith = (...approvals) => ({ instanceName: 'OpenChamber', sessions: [], approvals });

const submenuLabels = (snapshot, id) => buildTrayMenuTemplate(snapshot, { onAction: () => {}, statusIcons: {} })
  .filter((row) => Array.isArray(row.submenu) && String(row.label).includes(id))
  .flatMap((row) => row.submenu.filter((item) => item.label).map((item) => item.label));

describe('tray approval submenu', () => {
  test('offers "Allow always" only when the request can be remembered', () => {
    const snapshot = snapshotWith(permission('savable', true), permission('one-off', false));

    expect(submenuLabels(snapshot, 'savable')).toEqual(['Allow once', 'Allow always', 'Deny', 'Open in app']);
    expect(submenuLabels(snapshot, 'one-off')).toEqual(['Allow once', 'Deny', 'Open in app']);
  });

  test('the menu key changes when canSave is the only change, so the submenu never goes stale', () => {
    const savable = trayMenuKey(snapshotWith(permission('p1', true)));
    const oneOff = trayMenuKey(snapshotWith(permission('p1', false)));

    expect(oneOff).not.toBe(savable);
    expect(trayMenuKey(snapshotWith(permission('p1', false)))).toBe(oneOff);
  });
});
