import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

let attachedMenu;
class Tray extends EventEmitter {
  setIgnoreDoubleClickEvents() {}
  setImage() {}
  setTitle() {}
  setToolTip() {}
  setContextMenu(menu) { attachedMenu = menu; }
  destroy() {}
}
mock.module('electron', () => ({
  Tray,
  Menu: { buildFromTemplate: () => new EventEmitter() },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const { createTrayController } = await import('./tray.mjs');

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
