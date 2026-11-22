import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

let attachedMenu;
let tooltip;
class Tray extends EventEmitter {
  setIgnoreDoubleClickEvents() {}
  setImage() {}
  setTitle() {}
  setToolTip(value) { tooltip = value; }
  setContextMenu(menu) { attachedMenu = menu; }
  destroy() {}
}
mock.module('electron', () => ({
  Tray,
  Menu: { buildFromTemplate: (template) => Object.assign(new EventEmitter(), { template }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const { createTrayController, createTrayLocaleRouter } = await import('./tray.mjs');
const { COMMANDS_SAFE_FOR_REMOTE, parseTrayLocale } = await import('./remote-page-policy.mjs');

test('the native menu lifecycle reports each opening through the renderer action route', () => {
  const actions = [];
  const tray = createTrayController({ idleIconPath: '', unseenIconPath: '', breathIconPaths: [], onAction: action => actions.push(action) });
  try {
    tray.update({ sessions: [] });
    expect(actions).toEqual([]);
    attachedMenu.emit('menu-will-show');
    attachedMenu.emit('menu-will-close');
    attachedMenu.emit('menu-will-show');
    expect(actions).toEqual([{ type: 'menu-opened' }, { type: 'menu-opened' }]);
  } finally { tray.destroy(); }
});

test('changing locale rebuilds the current menu and tooltip without a new snapshot', () => {
  const tray = createTrayController({ idleIconPath: '', unseenIconPath: '', breathIconPaths: [], onAction: () => {}, locale: 'en' });
  try {
    expect(tooltip).toBe('OpenChamber — no active sessions');
    tray.setLocale('de');
    expect(tooltip).toBe('OpenChamber — keine aktiven Sitzungen');
    expect(attachedMenu.template.map((item) => item.label)).toContain('Keine aktiven Sitzungen');
    tray.setLocale('xx');
    expect(tooltip).toBe('OpenChamber — no active sessions');
    tray.destroy();
    tray.setLocale('de');
    expect(tooltip).toBe('OpenChamber — no active sessions');
  } finally { tray.destroy(); }
});

test('the tray starts in the preferred locale before the renderer sends a snapshot', () => {
  const tray = createTrayController({ idleIconPath: '', unseenIconPath: '', breathIconPaths: [], onAction: () => {}, locale: 'de' });
  try {
    expect(tooltip).toBe('OpenChamber — keine aktiven Sitzungen');
    expect(attachedMenu.template.map((item) => item.label)).toContain('Keine aktiven Sitzungen');
  } finally { tray.destroy(); }
});

test('only the window whose snapshot the tray shows relabels it, remote-served included', () => {
  const tray = createTrayController({ idleIconPath: '', unseenIconPath: '', breathIconPaths: [], onAction: () => {}, locale: 'en' });
  const router = createTrayLocaleRouter((locale) => tray.setLocale(locale));
  const remoteMain = {};
  const miniChat = {};
  const invoke = (sender, command, args) => {
    if (!COMMANDS_SAFE_FOR_REMOTE.has(command)) return 'rejected';
    if (command === 'desktop_tray_update') { router.publish(sender); tray.update(args); }
    if (command === 'desktop_set_tray_locale') router.setLocale(sender, parseTrayLocale(args.locale));
    return null;
  };
  try {
    expect(invoke(remoteMain, 'desktop_set_locale', { locale: 'de' })).toBe('rejected');
    invoke(remoteMain, 'desktop_set_tray_locale', { locale: 'de' });
    expect(tooltip).toBe('OpenChamber — no active sessions');
    invoke(remoteMain, 'desktop_tray_update', { sessions: [], approvals: [] });
    expect(tooltip).toBe('OpenChamber — keine aktiven Sitzungen');
    invoke(miniChat, 'desktop_set_tray_locale', { locale: 'en' });
    expect(tooltip).toBe('OpenChamber — keine aktiven Sitzungen');
    expect(attachedMenu.template.map((item) => item.label)).toContain('Keine aktiven Sitzungen');
    invoke(remoteMain, 'desktop_set_tray_locale', { locale: 'en' });
    expect(tooltip).toBe('OpenChamber — no active sessions');
    expect(attachedMenu.template.map((item) => item.label)).toContain('No active sessions');
  } finally { tray.destroy(); }
});
