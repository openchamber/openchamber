// The tray submenu drops "Allow always" for a permission that carries no save
// patterns (#4698). The tray rebuilds its menu only when `trayMenuKey` changes,
// so the flag has to be part of that signature too, or a snapshot whose only
// delta is `canSave` leaves the previous submenu on screen.
import { describe, expect, test } from 'bun:test';

import { buildTrayMenuTemplate, computeTrayTooltip, trayMenuKey } from './tray-menu.mjs';
import { MENU_LOCALE_DICTIONARIES } from './menu-locales.mjs';
import { TRAY_LOCALE_DICTIONARIES } from './tray-locales.mjs';

const permission = (id, canSave) => ({
  kind: 'permission', id, sessionId: 's1', sessionTitle: 'Session',
  label: `bash: ${id}`, directory: '/repo', canSave,
});

test('tray translations cover every native menu locale and key', () => {
  expect(Object.keys(TRAY_LOCALE_DICTIONARIES).sort()).toEqual(Object.keys(MENU_LOCALE_DICTIONARIES).sort());
  const keys = Object.keys(TRAY_LOCALE_DICTIONARIES.en);
  for (const dictionary of Object.values(TRAY_LOCALE_DICTIONARIES)) {
    expect(Object.keys(dictionary).sort()).toEqual(keys.slice().sort());
    for (const key of keys) expect(dictionary[key]).toBeTruthy();
  }
});

test('tooltip uses the correct Polish and Ukrainian plural forms', () => {
  const counts = { approvals: 0, error: 0, busy: 0, unseen: 0 };
  expect(computeTrayTooltip(counts, 2, 'pl')).toContain('2 sesje');
  expect(computeTrayTooltip(counts, 5, 'pl')).toContain('5 sesji');
  expect(computeTrayTooltip(counts, 2, 'uk')).toContain('2 сесії');
  expect(computeTrayTooltip(counts, 5, 'uk')).toContain('5 сесій');
  expect(computeTrayTooltip(counts, 21, 'uk')).toContain('21 сесія');
  expect(computeTrayTooltip(counts, 21, 'pl')).toContain('21 sesji');
  expect(computeTrayTooltip(counts, 1, 'unsupported')).toContain('1 session');
});

test('translated fallbacks preserve user titles and permission actions', () => {
  const actions = [];
  const template = buildTrayMenuTemplate({
    instanceName: 'My host',
    sessions: [{ id: 'untitled', title: '' }, { id: 'named', title: 'My session' }],
    approvals: [{ kind: 'permission', id: 'p1', sessionId: 'untitled', canSave: true }],
    usage: { mode: 'remaining', groups: [{ provider: 'OpenAI', rows: [] }] },
  }, { locale: 'de', statusIcons: {}, onAction: (action) => actions.push(action) });
  const labels = template.map((item) => item.label);
  for (const label of ['My host', 'My session', 'Unbenannte Sitzung', 'Nutzung (Verbleibend)']) {
    expect(labels).toContain(label);
  }
  const approval = template.find((item) => item.label === '⛔ Sitzung — Berechtigungsanfrage');
  expect(approval.submenu.filter((item) => item.label).map((item) => item.label))
    .toEqual(['Einmal erlauben', 'Immer erlauben', 'Ablehnen', 'In der App öffnen']);
  approval.submenu[0].click();
  expect(actions).toEqual([{ type: 'respond-permission', sessionId: 'untitled', id: 'p1', response: 'once' }]);
});

const snapshotWith = (...approvals) => ({ instanceName: 'OpenChamber', sessions: [], approvals });

const submenuLabels = (snapshot, id) => buildTrayMenuTemplate(snapshot, { onAction: () => {}, statusIcons: {} })
  .filter((row) => Array.isArray(row.submenu) && String(row.label).includes(id))
  .flatMap((row) => row.submenu.filter((item) => item.label).map((item) => item.label));

describe('tray approval submenu', () => {
  test('uses the current locale even when the snapshot is unchanged', () => {
    const snapshot = snapshotWith(permission('savable', true));
    const options = { onAction: () => {}, statusIcons: {} };
    const english = buildTrayMenuTemplate(snapshot, { ...options, locale: 'en' });
    const german = buildTrayMenuTemplate(snapshot, { ...options, locale: 'de' });
    expect(english.map((item) => item.label)).toContain('Needs your attention');
    expect(german.map((item) => item.label)).toContain('Erfordert deine Aufmerksamkeit');
    expect(trayMenuKey(snapshot, 'en')).not.toBe(trayMenuKey(snapshot, 'de'));
  });
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

describe('tray usage submenu', () => {
  const usageSnapshot = (account) => ({
    instanceName: 'OpenChamber', sessions: [], approvals: [],
    usage: { mode: 'usage', groups: [{ provider: 'OpenCode Go', account, status: null, rows: [{ label: '5h', value: '25%' }] }] },
  });
  const usageLabels = (snapshot) => buildTrayMenuTemplate(snapshot, { onAction: () => {}, statusIcons: {} })
    .filter((row) => Array.isArray(row.submenu))
    .flatMap((row) => row.submenu.map((item) => item.label));

  test('names the account next to the provider', () => {
    expect(usageLabels(usageSnapshot('outlook'))).toContain('OpenCode Go · outlook');
    expect(usageLabels(usageSnapshot(null))).toContain('OpenCode Go');
  });

  test('the menu key changes when only the account changes, so a switch between accounts with equal meters shows', () => {
    expect(trayMenuKey(usageSnapshot('outlook'))).not.toBe(trayMenuKey(usageSnapshot('solar tool')));
  });
});
