import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

/**
 * What Cmd/Ctrl+W closes in the desktop app.
 *
 * The window menu owns the shortcut, so the page cannot catch the key itself.
 * A surface with a tab of its own (a file open in Files) registers here; the
 * desktop shell is told whether one is registered, and while one is, the
 * shortcut arrives as an `openchamber:close-tab` event instead of closing the
 * window. The last registered surface wins.
 */
const handlers: Array<() => void> = [];
let listening = false;

const report = (): void => {
  if (!hasDesktopInvoke()) return;
  void invokeDesktop('desktop_set_close_tab_target', { active: handlers.length > 0 });
};

const handleCloseTab = (): void => {
  handlers[handlers.length - 1]?.();
};

export const registerCloseTabTarget = (close: () => void): (() => void) => {
  if (!listening) {
    window.addEventListener('openchamber:close-tab', handleCloseTab);
    listening = true;
  }
  handlers.push(close);
  report();
  return () => {
    const index = handlers.lastIndexOf(close);
    if (index >= 0) handlers.splice(index, 1);
    report();
  };
};
