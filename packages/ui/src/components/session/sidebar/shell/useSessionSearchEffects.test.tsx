import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useSessionSearchEffects } from './useSessionSearchEffects';
import { installHookTestDom } from '../test-utils/testDom';

/**
 * The hook registers DOM listeners and a requestAnimationFrame focus pass, so
 * these tests drive the real hook behind a small listener/rAF sandbox on top
 * of the shared hook test DOM. Query text is held by the harness only to prove
 * closing search never rewrites it.
 */

type ListenerRegistry = {
  add: (type: string, listener: EventListener) => void;
  remove: (type: string, listener: EventListener) => void;
  all: (type: string) => EventListener[];
};

const createListenerRegistry = (): ListenerRegistry => {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    add: (type, listener) => {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    remove: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    all: (type) => [...(listeners.get(type) ?? [])],
  };
};

type SearchEffectsSandbox = {
  input: HTMLInputElement;
  container: HTMLDivElement;
  windowListeners: ListenerRegistry;
  documentListeners: ListenerRegistry;
  rAF: {
    flush: () => void;
    pendingCount: () => number;
    canceledHandles: () => number[];
  };
  calls: string[];
  setInside: (inside: boolean) => void;
  dispatchMousedown: () => void;
  dispatchOpenRequest: () => void;
  restore: () => void;
};

type OverrideValue =
  | ((type: string, listener: EventListener) => void)
  | ((callback: FrameRequestCallback) => number)
  | ((handle: number) => void);

type OverrideEntry = {
  target: typeof globalThis | Document;
  name: string;
  descriptor: PropertyDescriptor | undefined;
};

const createSearchEffectsSandbox = (): SearchEffectsSandbox => {
  const dom = installHookTestDom();
  const windowListeners = createListenerRegistry();
  const documentListeners = createListenerRegistry();
  const overrides: OverrideEntry[] = [];
  const addOverride = (target: typeof globalThis | Document, name: string, value: OverrideValue) => {
    overrides.push({ target, name, descriptor: Object.getOwnPropertyDescriptor(target, name) });
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  };

  const frames = new Map<number, FrameRequestCallback>();
  const canceledHandles: number[] = [];
  let nextFrameHandle = 0;

  addOverride(globalThis, 'addEventListener', windowListeners.add);
  addOverride(globalThis, 'removeEventListener', windowListeners.remove);
  addOverride(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameHandle += 1;
    frames.set(nextFrameHandle, callback);
    return nextFrameHandle;
  });
  addOverride(globalThis, 'cancelAnimationFrame', (handle: number) => {
    canceledHandles.push(handle);
    frames.delete(handle);
  });
  addOverride(document, 'addEventListener', documentListeners.add);
  addOverride(document, 'removeEventListener', documentListeners.remove);

  const input = document.createElement('input');
  const container = document.createElement('div');
  const calls: string[] = [];
  input.focus = () => {
    calls.push('focus');
  };
  input.select = () => {
    calls.push('select');
  };
  let inside = false;
  container.contains = () => inside;

  return {
    input,
    container,
    windowListeners,
    documentListeners,
    rAF: {
      flush: () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      },
      pendingCount: () => frames.size,
      canceledHandles: () => [...canceledHandles],
    },
    calls,
    setInside: (nextInside) => {
      inside = nextInside;
    },
    dispatchMousedown: () => {
      for (const listener of documentListeners.all('mousedown')) {
        listener(new Event('mousedown'));
      }
    },
    dispatchOpenRequest: () => {
      for (const listener of windowListeners.all('openchamber:sidebar-session-search')) {
        listener(new Event('openchamber:sidebar-session-search'));
      }
    },
    restore: () => {
      for (const { target, name, descriptor } of [...overrides].reverse()) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else Reflect.deleteProperty(target, name);
      }
      dom.restore();
    },
  };
};

type EffectsControls = {
  query: string;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>> | null;
};

const mountSearchEffects = (
  sandbox: SearchEffectsSandbox,
  { enabled, initialOpen }: { enabled: boolean; initialOpen: boolean },
) => {
  const controls: EffectsControls = { query: '', open: initialOpen, setOpen: null };
  const inputRef = React.createRef<HTMLInputElement | null>();
  inputRef.current = sandbox.input;
  const containerRef = React.createRef<HTMLDivElement | null>();
  containerRef.current = sandbox.container;
  const Harness = () => {
    const [query] = React.useState('release');
    const [open, setOpen] = React.useState(initialOpen);
    controls.query = query;
    controls.open = open;
    controls.setOpen = setOpen;
    useSessionSearchEffects({
      enabled,
      isSessionSearchOpen: open,
      setIsSessionSearchOpen: setOpen,
      sessionSearchInputRef: inputRef,
      sessionSearchContainerRef: containerRef,
    });
    return null;
  };
  const root: Root = createRoot(document.createElement('div'));
  return {
    controls,
    render: async () => {
      await act(async () => {
        root.render(React.createElement(Harness));
      });
    },
    setOpen: async (open: boolean) => {
      await act(async () => {
        controls.setOpen?.(open);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
};

describe('useSessionSearchEffects', () => {
  let sandbox: SearchEffectsSandbox | null = null;
  let unmount: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (unmount) await unmount();
    unmount = null;
    sandbox?.restore();
    sandbox = null;
  });

  test('focuses and selects the input when search opens', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: true, initialOpen: false });
    unmount = harness.unmount;

    await harness.render();
    expect(sandbox.calls).toEqual([]);

    await harness.setOpen(true);
    expect(sandbox.rAF.pendingCount()).toBe(1);
    sandbox.rAF.flush();
    expect(sandbox.calls).toEqual(['focus', 'select']);
  });

  test('the sidebar search shortcut opens and focuses the input', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: true, initialOpen: false });
    unmount = harness.unmount;

    await harness.render();
    await act(async () => {
      sandbox?.dispatchOpenRequest();
    });
    expect(harness.controls.open).toBe(true);
    // The shortcut handler focuses immediately; the open transition then
    // schedules the same focus/select pass for the render it triggered.
    expect(sandbox.calls).toEqual(['focus', 'select']);
    sandbox.rAF.flush();
    expect(sandbox.calls).toEqual(['focus', 'select', 'focus', 'select']);
  });

  test('mousedown outside closes search and leaves the query untouched', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: true, initialOpen: true });
    unmount = harness.unmount;

    await harness.render();
    sandbox.setInside(false);
    await act(async () => {
      sandbox?.dispatchMousedown();
    });
    expect(harness.controls.open).toBe(false);
    expect(harness.controls.query).toBe('release');
  });

  test('mousedown inside keeps search open', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: true, initialOpen: true });
    unmount = harness.unmount;

    await harness.render();
    sandbox.setInside(true);
    await act(async () => {
      sandbox?.dispatchMousedown();
    });
    expect(harness.controls.open).toBe(true);
  });

  test('disabled installs no listeners and performs no focus pass', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: false, initialOpen: true });
    unmount = harness.unmount;

    await harness.render();
    expect(sandbox.documentListeners.all('mousedown')).toHaveLength(0);
    expect(sandbox.windowListeners.all('openchamber:sidebar-session-search')).toHaveLength(0);
    expect(sandbox.rAF.pendingCount()).toBe(0);
    sandbox.rAF.flush();
    expect(sandbox.calls).toEqual([]);
  });

  test('removes listeners and cancels the focus frame on unmount', async () => {
    sandbox = createSearchEffectsSandbox();
    const harness = mountSearchEffects(sandbox, { enabled: true, initialOpen: true });
    unmount = harness.unmount;

    await harness.render();
    expect(sandbox.documentListeners.all('mousedown')).toHaveLength(1);
    expect(sandbox.windowListeners.all('openchamber:sidebar-session-search')).toHaveLength(1);
    expect(sandbox.rAF.pendingCount()).toBe(1);

    await harness.unmount();
    unmount = null;

    expect(sandbox.documentListeners.all('mousedown')).toHaveLength(0);
    expect(sandbox.windowListeners.all('openchamber:sidebar-session-search')).toHaveLength(0);
    expect(sandbox.rAF.pendingCount()).toBe(0);
    expect(sandbox.rAF.canceledHandles()).toHaveLength(1);
    sandbox.rAF.flush();
    expect(sandbox.calls).toEqual([]);
  });
});
