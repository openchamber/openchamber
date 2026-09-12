/**
 * Electron webview backend for agent browser control.
 *
 * Implements the backend-neutral contract over the control client's keyed
 * registry: read models come from each controller's `getInfo()` plus the
 * panel's explicit active target, and `execute` resolves exactly the way the
 * dispatch layer always has — an open naming a tab and every rich action run
 * through that tab's controller, while only a tab-less open with no
 * controller in scope falls to the directory's opener. The opener path is
 * what iframe-only runtimes serve too, so it stays first-class here.
 *
 * The registry itself stays owned by controlClient; this module receives the
 * narrow slice it reads, so the backend is testable without the event stream.
 */
import type {
  BrowserBackend,
  BrowserBackendKind,
  BrowserTabInfo,
  BrowserTarget,
} from '@/lib/browser/contract';
import type {
  BrowserControllerKey,
  BrowserOpener,
  Registration,
} from '@/lib/browser/controlClient';

export type ElectronWebviewBackendDeps = {
  readonly resolveRegistration: (target: BrowserTarget) => Registration | null;
  readonly getOpener: (directoryKey: string) => BrowserOpener | null;
  readonly listRegistrations: () => ReadonlyArray<Registration>;
  readonly getActiveTarget: () => BrowserControllerKey | null;
  readonly canonicalizeDirectory: (value: string) => string;
};

const BACKEND_KIND: BrowserBackendKind = 'electron-webview';

export const createElectronWebviewBackend = (deps: ElectronWebviewBackendDeps): BrowserBackend => {
  const readTabs = (directoryKey: string): BrowserTabInfo[] => {
    const active = deps.getActiveTarget();
    const activeTabId = active && deps.canonicalizeDirectory(active.directory) === directoryKey
      ? active.tabId
      : null;
    const tabs: BrowserTabInfo[] = [];
    for (const registration of deps.listRegistrations()) {
      if (registration.directoryKey !== directoryKey) continue;
      const info = registration.controller.getInfo?.();
      tabs.push({
        tabId: registration.key.tabId,
        url: info?.url ?? '',
        title: info?.title ?? '',
        active: registration.key.tabId === activeTabId,
      });
    }
    return tabs;
  };

  const noControllerError = (directory: string, tabId: string | null): Error => new Error(
    `no controller for target: ${directory || '(unscoped)'}${tabId ? ` tab ${tabId}` : ''}`,
  );

  return {
    getSession(scope) {
      const directory = deps.canonicalizeDirectory(scope.directory);
      const tabs = readTabs(directory);
      // A directory with no controllers has no session — an empty one would
      // read as "project open with zero tabs", which is a lie.
      if (tabs.length === 0) return null;
      return {
        backend: BACKEND_KIND,
        directory,
        tabs,
        activeTabId: tabs.find((tab) => tab.active)?.tabId ?? null,
      };
    },

    listTabs(scope) {
      return readTabs(deps.canonicalizeDirectory(scope.directory));
    },

    async execute(target, action, parameters) {
      const directory = deps.canonicalizeDirectory(target.directory);
      const tabId = typeof target.tabId === 'string' && target.tabId ? target.tabId : null;
      const registration = deps.resolveRegistration(target);

      // A tab-less open with no controller in scope is the one action that
      // creates a tab, so it goes through the directory's opener. Every other
      // action — including an open naming a tab — drives an existing tab and
      // never falls through to another one.
      if (action === 'browser.open' && !tabId && !registration) {
        const opener = directory ? deps.getOpener(directory) : null;
        if (!opener) throw noControllerError(directory, tabId);
        const url = typeof parameters.url === 'string' ? parameters.url : '';
        if (!url) throw new Error('url is required');
        return opener(url);
      }

      if (!registration) throw noControllerError(directory, tabId);
      return registration.controller.run(action, parameters);
    },
  };
};
