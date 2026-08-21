import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { collectFileTreeWatchDirectories } from './useFileTreeAutoRefresh';
import { useFileTreeAutoRefresh } from './useFileTreeAutoRefresh';
import { getFileTreePathIdentity, normalizeFileTreePath } from '@/lib/fileTreePath';

const installedGlobals = new Map<string, PropertyDescriptor | undefined>();

type TestDocument = {
  nodeType: number;
  defaultView: typeof globalThis;
  hidden: boolean;
  visibilityState: string;
  addEventListener: (event: string, listener: () => void) => void;
  removeEventListener: (event: string, listener: () => void) => void;
  documentElement?: Element;
  body?: Element;
};

const installGlobal = <TValue,>(name: string, value: TValue) => {
  if (!installedGlobals.has(name)) {
    installedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const installMinimalDom = () => {
  const listeners = new Map<string, Set<() => void>>();
  class ElementStub {}
  const documentStub: TestDocument = {
    nodeType: 9,
    defaultView: globalThis,
    hidden: false,
    visibilityState: 'visible',
    addEventListener: (event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    removeEventListener: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const container: Element = Object.assign(Object.create(ElementStub.prototype), {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  documentStub.documentElement = container;
  documentStub.body = container;
  installGlobal('document', documentStub);
  installGlobal('window', globalThis);
  installGlobal('Element', ElementStub);
  installGlobal('HTMLElement', ElementStub);
  installGlobal('HTMLIFrameElement', ElementStub);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return container;
};

afterEach(() => {
  for (const [name, descriptor] of installedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  installedGlobals.clear();
});

describe('collectFileTreeWatchDirectories', () => {
  test('always includes the root and keeps only unique workspace descendants', () => {
    expect(collectFileTreeWatchDirectories('C:\\Repo', [
      'C:/Repo/src',
      'c:/repo/SRC',
      'C:/Repo/src/components',
      'D:/Other',
      '',
    ])).toEqual([
      'C:/Repo',
      'C:/Repo/src',
      'C:/Repo/src/components',
    ]);
  });

  test('returns no directories without a workspace root', () => {
    expect(collectFileTreeWatchDirectories('', ['/repo/src'])).toEqual([]);
  });

  test('preserves Unix, Windows drive, and UNC roots', () => {
    expect(collectFileTreeWatchDirectories('/', ['/tmp'])).toEqual(['/', '/tmp']);
    expect(collectFileTreeWatchDirectories('C:/', ['C:/Users'])).toEqual(['C:/', 'C:/Users']);
    expect(collectFileTreeWatchDirectories('\\\\Server\\Share', [
      '//server/share/project',
    ])).toEqual([
      '//Server/Share',
      '//server/share/project',
    ]);
  });

  test('preserves Windows drive-letter casing while comparing identities case-insensitively', () => {
    expect(normalizeFileTreePath('c:\\repo')).toBe('c:/repo');
    expect(getFileTreePathIdentity('c:/repo')).toBe(getFileTreePathIdentity('C:/REPO'));
  });
});

describe('useFileTreeAutoRefresh', () => {
  test('reconciles watched directories before treating the watcher as ready', async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const refreshed: string[] = [];
    let handlers: Parameters<NonNullable<Parameters<typeof useFileTreeAutoRefresh>[0]['watchDirectories']>>[2] | null = null;

    const Probe: React.FC = () => {
      useFileTreeAutoRefresh({
        enabled: true,
        root: '/repo',
        expandedPaths: ['/repo/src'],
        watchDirectories: (_workspace, _directories, nextHandlers) => {
          handlers = nextHandlers;
          return { close: () => undefined };
        },
        refreshDirectory: async (directory) => {
          refreshed.push(directory);
        },
      });
      return null;
    };

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    expect(handlers).not.toBeNull();

    await act(async () => {
      handlers?.onReady?.();
      await Promise.resolve();
    });

    expect(refreshed).toEqual(['/repo', '/repo/src']);
    act(() => root.unmount());
  });

  test('coalesces repeated events for one directory without overlapping refreshes', async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    let handlers: Parameters<NonNullable<Parameters<typeof useFileTreeAutoRefresh>[0]['watchDirectories']>>[2] | null = null;
    let releaseFirstRefresh: (() => void) | null = null;
    let refreshCount = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;

    const Probe: React.FC = () => {
      useFileTreeAutoRefresh({
        enabled: true,
        root: '/repo',
        expandedPaths: [],
        watchDirectories: (_workspace, _directories, nextHandlers) => {
          handlers = nextHandlers;
          return { close: () => undefined };
        },
        refreshDirectory: async () => {
          refreshCount += 1;
          activeRefreshes += 1;
          maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
          if (refreshCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstRefresh = resolve;
            });
          }
          activeRefreshes -= 1;
        },
      });
      return null;
    };

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      handlers?.onChange({ directory: '/repo' });
      handlers?.onChange({ directory: '/repo' });
      await Promise.resolve();
    });

    expect(refreshCount).toBe(1);
    expect(maxActiveRefreshes).toBe(1);

    await act(async () => {
      releaseFirstRefresh?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshCount).toBe(2);
    expect(maxActiveRefreshes).toBe(1);
    act(() => root.unmount());
  });

  test('keeps fallback polling until all watched directories reconcile', async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    let closeCount = 0;
    let clearIntervalCount = 0;
    let fallbackTick: (() => void) | null = null;
    const failingDirectories = new Set(['/repo']);
    let handlers: Parameters<NonNullable<Parameters<typeof useFileTreeAutoRefresh>[0]['watchDirectories']>>[2] | null = null;
    const setIntervalStub = (callback: () => void) => {
      fallbackTick = callback;
      return 1;
    };
    const clearIntervalStub = () => {
      clearIntervalCount += 1;
    };
    installGlobal('setInterval', setIntervalStub);
    installGlobal('clearInterval', clearIntervalStub);

    const Probe: React.FC = () => {
      useFileTreeAutoRefresh({
        enabled: true,
        root: '/repo',
        expandedPaths: ['/repo/src'],
        watchDirectories: (_workspace, _directories, nextHandlers) => {
          handlers = nextHandlers;
          return { close: () => { closeCount += 1; } };
        },
        refreshDirectory: async (directory) => {
          if (failingDirectories.has(directory)) throw new Error('list failed');
        },
      });
      return null;
    };

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      handlers?.onReady?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(closeCount).toBe(0);
    expect(clearIntervalCount).toBe(0);
    failingDirectories.clear();
    await act(async () => {
      handlers?.onChange({ directory: '/repo/src' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearIntervalCount).toBe(0);
    await act(async () => {
      fallbackTick?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearIntervalCount).toBe(1);
    act(() => handlers?.onError?.());
    await act(async () => {
      fallbackTick?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearIntervalCount).toBe(1);
    act(() => root.unmount());
    expect(closeCount).toBe(1);
    expect(clearIntervalCount).toBe(2);
  });

  test('does no background work while disabled and reconciles after enabling', async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const refreshed: string[] = [];
    let handlers: Parameters<NonNullable<Parameters<typeof useFileTreeAutoRefresh>[0]['watchDirectories']>>[2] | null = null;
    let watchCount = 0;
    let closeCount = 0;
    let setIntervalCount = 0;
    let clearIntervalCount = 0;
    installGlobal('setInterval', () => {
      setIntervalCount += 1;
      return 1;
    });
    installGlobal('clearInterval', () => {
      clearIntervalCount += 1;
    });

    const Probe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
      useFileTreeAutoRefresh({
        enabled,
        root: '/repo',
        expandedPaths: [],
        watchDirectories: (_workspace, _directories, nextHandlers) => {
          watchCount += 1;
          handlers = nextHandlers;
          return { close: () => { closeCount += 1; } };
        },
        refreshDirectory: async (directory) => {
          refreshed.push(directory);
        },
      });
      return null;
    };

    await act(async () => {
      root.render(React.createElement(Probe, { enabled: false }));
    });
    expect(watchCount).toBe(0);
    expect(setIntervalCount).toBe(0);

    await act(async () => {
      root.render(React.createElement(Probe, { enabled: true }));
    });
    expect(watchCount).toBe(1);
    expect(setIntervalCount).toBe(1);

    await act(async () => {
      handlers?.onReady?.();
      await Promise.resolve();
    });
    expect(refreshed).toEqual(['/repo']);
    expect(clearIntervalCount).toBe(1);

    await act(async () => {
      root.render(React.createElement(Probe, { enabled: false }));
    });
    expect(closeCount).toBe(1);
    expect(clearIntervalCount).toBe(1);

    act(() => root.unmount());
  });
});
