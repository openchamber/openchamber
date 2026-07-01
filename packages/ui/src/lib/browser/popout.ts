import { invokeDesktopCommand } from '@/lib/desktopNative';
import { browserPopoutKey, postBrowserPopoutMessage } from '@/stores/useBrowserPopoutStore';

/**
 * Open the embedded browser in a separate, resizable, movable OS window so it can
 * be placed on any monitor. On desktop this creates a native Electron window
 * (positionable across displays); on web it opens a same-origin popup window.
 * The popped-out window renders the same browser pane and registers as the agent
 * controller, so browser automation keeps working after popping out.
 */
const isElectronRuntime = (): boolean =>
  typeof window !== 'undefined' && Boolean((window as { __OPENCHAMBER_ELECTRON__?: unknown }).__OPENCHAMBER_ELECTRON__);

interface BrowserPopoutTarget {
  url: string;
  directory: string;
  tabID: string;
}

/** @returns true when the window was opened (or focused), false on failure/block. */
export const openBrowserPopout = async (target: BrowserPopoutTarget): Promise<boolean> => {
  if (isElectronRuntime()) {
    await invokeDesktopCommand('desktop_open_browser_popout_window', {
      initialUrl: target.url,
      directory: target.directory,
      tabID: target.tabID,
    });
    return true;
  }

  const params = new URLSearchParams();
  if (target.url) params.set('url', target.url);
  if (target.directory) params.set('directory', target.directory);
  if (target.tabID) params.set('tabID', target.tabID);
  const query = params.toString();
  const href = `browser-popout.html${query ? `?${query}` : ''}`;
  const name = `oc-browser-popout-${target.directory}-${target.tabID}`;
  const opened = window.open(href, name, 'width=1024,height=768,menubar=no,toolbar=no,location=no');
  return Boolean(opened);
};

/**
 * Close the pop-out browser window for a tab. Works whether called from the panel
 * (bring back) or from the pop-out itself (dock). On desktop the main process
 * closes the tracked window by directory/tabID; on web the pop-out's own listener
 * receives the `dock` broadcast and closes itself. The panel re-docks when it
 * hears the window close (main IPC event on desktop, `closed` broadcast on web).
 */
export const closeBrowserPopout = (target: { directory: string; tabID: string }): void => {
  if (isElectronRuntime()) {
    void invokeDesktopCommand('desktop_close_browser_popout_window', {
      directory: target.directory,
      tabID: target.tabID,
    }).catch(() => { /* window may already be gone */ });
    return;
  }
  postBrowserPopoutMessage({ type: 'dock', key: browserPopoutKey(target.directory, target.tabID) });
};
