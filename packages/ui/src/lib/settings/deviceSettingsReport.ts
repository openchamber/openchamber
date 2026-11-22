import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { generateUuid } from '@/lib/uuid';
import { getSettingsSurface } from './surface';
import type { SettingsSurface } from './registry';

type UIState = ReturnType<typeof useUIStore.getState>;

/**
 * The device-scoped settings this window reports to its server, so the agent
 * tool can read them (`settings.devices`); the server keeps only registry
 * device keys. Left out: state that moves as the user works rather than a
 * preference (scroll position, open dialogs, the Settings page on screen,
 * per-folder panel state, "last viewed" stamps, terminal names that mean
 * nothing on another device).
 */
export const readDeviceSettings = (state: UIState) => ({
  isSidebarOpen: state.isSidebarOpen,
  sidebarWidth: state.sidebarWidth,
  contextRailOrder: state.contextRailOrder,
  contextRailHiddenSurfaces: state.contextRailHiddenSurfaces,
  mobileWorkspaceTabOrder: state.mobileWorkspaceTabOrder,
  mobileWorkspaceHiddenTabs: state.mobileWorkspaceHiddenTabs,
  contextSurfaceZones: state.contextSurfaceZones,
  contextEditorTreeVisible: state.contextEditorTreeVisible,
  contextEditorVisible: state.contextEditorVisible,
  contextEditorTreeWidth: state.contextEditorTreeWidth,
  workStatusExpandedSections: state.workStatusExpandedSections,
  messageQueueExpanded: state.messageQueueExpanded,
  messageLimit: state.messageLimit,
  walkthroughTocWidth: state.walkthroughTocWidth,
  diffFileListMode: state.diffFileListMode,
  diffFileTreeWidth: state.diffFileTreeWidth,
  showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
  dockBadgeEnabled: state.dockBadgeEnabled,
  alwaysShowScrollbars: state.alwaysShowScrollbars,
  mobileKeyboardMode: state.mobileKeyboardMode,
  desktopWindowControlsPosition: state.desktopWindowControlsPosition,
  desktopWindowControlsStyle: state.desktopWindowControlsStyle,
  inputBarOffset: state.inputBarOffset,
});

type DeviceSettings = ReturnType<typeof readDeviceSettings>;

/**
 * `revision` grows with every send of this page, so the server can ignore a
 * report that arrives after a newer one.
 */
type DeviceSettingsReport<T> = { deviceId: string; surface: SettingsSurface; values: T; revision: number };

type ReporterDeps<T> = {
  read: () => T;
  /** Resolves true when the server took the report. `closing`: the window is going away. */
  send: (report: DeviceSettingsReport<T>, closing: boolean) => Promise<boolean>;
  deviceId: string;
  surface: SettingsSurface;
  /** Returns the timer handle `cancel` takes. */
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  debounceMs?: number;
};

/**
 * Sends the device settings after they have been still for `debounceMs`, and
 * only when they differ from what the server last took. A report the server
 * refused (signed out, offline) counts as not delivered, so the next request
 * sends it again.
 */
export const createDeviceSettingsReporter = <T>({ read, send, deviceId, surface, schedule, cancel, debounceMs = 2_000 }: ReporterDeps<T>) => {
  let delivered: string | null = null;
  // The revision of the report `delivered` came from. A send that finishes
  // after a newer one must not replace it with its older snapshot.
  let deliveredRevision = 0;
  let timer: number | null = null;
  // Bumped when another server takes over: a reply to a report sent to the
  // previous one must not mark the new one as told.
  let generation = 0;
  // Starts from the clock and only grows within this page, whose id is new.
  let revision = 0;

  // Sends go one at a time, except a closing send (see flush): a slow earlier
  // report must not take effect after a newer one. The revisions carry that
  // rule where the sends themselves overlap: the server ignores a report
  // older than the one it holds, and `deliveredRevision` keeps this page's
  // own record on the newest report.
  let inFlight: Promise<void> = Promise.resolve();

  const sendLatest = async (closing: boolean): Promise<void> => {
    const values = read();
    const snapshot = JSON.stringify(values);
    if (snapshot === delivered) return;
    const sentFor = generation;
    revision = Math.max(Date.now(), revision + 1);
    const sentRevision = revision;
    if (await send({ deviceId, surface, values, revision: sentRevision }, closing) && sentFor === generation && sentRevision > deliveredRevision) {
      delivered = snapshot;
      deliveredRevision = sentRevision;
    }
  };

  const flush = (closing = false): Promise<void> => {
    if (timer !== null) cancel(timer);
    timer = null;
    // A closing window cannot wait for an earlier send; it goes out at once,
    // alongside the one still in flight. The revisions keep the overlap from
    // leaving either side on the older report.
    inFlight = closing ? sendLatest(true) : inFlight.then(() => sendLatest(false));
    return inFlight;
  };

  const request = (): void => {
    if (timer !== null) cancel(timer);
    timer = schedule(() => { void flush(); }, debounceMs);
  };

  /**
   * The server may not hold this report any more: another server took over,
   * or the same one restarted (it keeps reports in memory). The next flush
   * sends even an unchanged snapshot.
   */
  const forget = (): void => {
    generation += 1;
    delivered = null;
    // The new server need not wait for a send to the old one that may never answer.
    inFlight = Promise.resolve();
  };

  return { request, flush, forget };
};

// A fresh id for every page load. Two tabs keep separate stores, and a
// duplicated tab copies session storage, so any stored id could end up shared
// by two windows that would then overwrite each other's report. A reload shows
// up as a new entry; the server keeps the 20 most recent.
const newWindowId = (): string => generateUuid().replace(/-/g, '');

/** True when `next` differs from the last value it was given (structurally). */
export const createChangeFilter = <T>(initial: T) => {
  let seen = JSON.stringify(initial);
  return (next: T): boolean => {
    const snapshot = JSON.stringify(next);
    if (snapshot === seen) return false;
    seen = snapshot;
    return true;
  };
};

let started = false;

/**
 * Starts reporting this window's device settings to its server. The VS Code
 * extension runs no OpenChamber server and has no agent tool, so it reports
 * nothing; a desktop Mini Chat window does not start it (its layout state
 * is not the main window's).
 */
export const startDeviceSettingsReport = (): void => {
  if (started || globalThis.window === undefined || isVSCodeRuntime()) return;
  started = true;

  const reporter = createDeviceSettingsReporter<DeviceSettings>({
    read: () => readDeviceSettings(useUIStore.getState()),
    send: async (report, closing) => {
      try {
        const response = await runtimeFetch('/api/config/device-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(report),
          // Lets a report sent as the window closes outlive the page.
          keepalive: closing,
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    deviceId: newWindowId(),
    surface: getSettingsSurface(),
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle),
  });

  // Only a change to what is reported restarts the debounce: the store also
  // carries state written every frame (scroll position), which would
  // otherwise hold the report back for as long as it keeps changing.
  const changed = createChangeFilter(readDeviceSettings(useUIStore.getState()));
  useUIStore.subscribe((state) => {
    if (changed(readDeviceSettings(state))) reporter.request();
  });
  // Visible again: report once more, unchanged or not. Covers a report a
  // signed-out window could not deliver and a server that restarted and
  // forgot it. Hidden or closing: a change still inside the debounce goes out now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reporter.forget();
      reporter.request();
    } else {
      void reporter.flush(true);
    }
  });
  window.addEventListener('pagehide', () => { void reporter.flush(true); });
  // Capacitor suspends the app without pagehide, and a WKWebView's visibility
  // events are not dependable; appStateChange is the signal the settings
  // lifecycle trusts too (persistence.ts).
  if (isCapacitorApp()) {
    void import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          reporter.forget();
          reporter.request();
        } else {
          void reporter.flush(true);
        }
      }))
      .catch(() => undefined);
  }
  subscribeRuntimeEndpointChanged(() => {
    reporter.forget();
    reporter.request();
  });
  reporter.request();
};
