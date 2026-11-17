import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import type { RotationState } from '@/lib/routing/poolHealthApi';

let rotationState: RotationState = { settings: { enabled: false, intervalMinutes: 5 }, moves: [] };
let loadFailure: Error | null = null;
// When set, a read waits for it, so a test can answer a read after a save.
let readGate: Promise<void> | null = null;
const saves: Array<Partial<RotationState['settings']>> = [];
// When set, a save waits for it before the server answers.
let saveGate: Promise<void> | null = null;

mock.module('@/lib/routing/poolHealthApi', () => ({
  fetchRotation: async () => {
    const snapshot = rotationState;
    if (readGate) await readGate;
    if (loadFailure) throw loadFailure;
    return snapshot;
  },
  saveRotation: async (patch: Partial<RotationState['settings']>) => {
    saves.push(patch);
    if (saveGate) await saveGate;
    rotationState = { ...rotationState, settings: { ...rotationState.settings, ...patch } };
    return rotationState;
  },
}));

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver',
  'cancelAnimationFrame', 'getComputedStyle', 'requestAnimationFrame', 'localStorage',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    MouseEvent: happyWindow.MouseEvent,
    PointerEvent: happyWindow.PointerEvent,
    MutationObserver: happyWindow.MutationObserver,
    ResizeObserver: happyWindow.ResizeObserver,
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    localStorage: happyWindow.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const renderFields = async () => {
  const dom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { PoolRotationFields } = await import('./PoolRotationFields');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  const render = async (reloadKey: string) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PoolRotationFields reloadKey={reloadKey} />
        </I18nProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };
  await render('initial');
  return {
    dom,
    rerender: render,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('PoolRotationFields', () => {
  beforeEach(() => {
    rotationState = { settings: { enabled: false, intervalMinutes: 5 }, moves: [] };
    loadFailure = null;
    readGate = null;
    saveGate = null;
    saves.length = 0;
  });

  test('is off by default, says what turning it on does, and turns it on', async () => {
    const { dom, cleanup } = await renderFields();
    try {
      const toggle = dom.container.querySelector<HTMLElement>('[role="switch"][aria-label="Move sessions off a target before its plan runs out"]');
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(dom.container.textContent).toContain('A moved session leaves the pool and no longer fails over inside it.');
      expect(dom.container.textContent).not.toContain('Minutes between moves in one pool');
      await act(async () => toggle!.click());
      await act(async () => { await Promise.resolve(); });
      expect(saves).toEqual([{ enabled: true }]);
      expect(dom.container.textContent).toContain('Minutes between moves in one pool');
    } finally {
      await cleanup();
    }
  });

  test('a read that answers after a save does not put the old setting back', async () => {
    const { dom, rerender, cleanup } = await renderFields();
    try {
      let release: () => void = () => {};
      readGate = new Promise<void>((resolve) => { release = resolve; });
      // A refresh starts a read, which sees rotation off and holds that answer.
      await rerender('refresh');
      const toggle = dom.container.querySelector<HTMLElement>('[role="switch"]')!;
      await act(async () => toggle.click());
      await act(async () => { await Promise.resolve(); });
      expect(saves).toEqual([{ enabled: true }]);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    } finally {
      await cleanup();
    }
  });

  test('a read that starts while a save is pending does not undo the save', async () => {
    const { dom, rerender, cleanup } = await renderFields();
    try {
      let releaseSave: () => void = () => {};
      let releaseRead: () => void = () => {};
      saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
      const toggle = dom.container.querySelector<HTMLElement>('[role="switch"]')!;
      await act(async () => toggle.click());
      // While the save is pending, a refresh reads the old, off state.
      readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      await rerender('refresh-during-save');
      await act(async () => { releaseSave(); await Promise.resolve(); await Promise.resolve(); });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      await act(async () => { releaseRead(); await Promise.resolve(); await Promise.resolve(); });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    } finally {
      await cleanup();
    }
  });

  test('the interval field is locked while a save is pending', async () => {
    rotationState = { settings: { enabled: true, intervalMinutes: 5 }, moves: [] };
    const { dom, cleanup } = await renderFields();
    try {
      let release: () => void = () => {};
      saveGate = new Promise<void>((resolve) => { release = resolve; });
      const field = () => dom.container.querySelector<HTMLInputElement>('input[aria-label="Minutes between moves in one pool"]')!;
      expect(field().disabled).toBe(false);
      await act(async () => {
        field().value = '10';
        field().dispatchEvent(new Event('focusout', { bubbles: true }));
      });
      expect(saves).toEqual([{ intervalMinutes: 10 }]);
      // A second commit cannot start while the first save is pending.
      expect(field().disabled).toBe(true);
      await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
      expect(field().disabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('ids and model references in the history read left to right', async () => {
    rotationState = {
      settings: { enabled: true, intervalMinutes: 5 },
      moves: [{ at: Date.now(), poolID: 'busy', sessionID: 'ses_abc', subagent: false, from: 'openai/a', to: 'anthropic/b' }],
    };
    const { dom, cleanup } = await renderFields();
    try {
      const isolated = [...dom.container.querySelectorAll('span[dir="ltr"]')].map((el) => el.textContent);
      expect(isolated).toEqual(['ses_abc', 'openai/a', 'anthropic/b']);
    } finally {
      await cleanup();
    }
  });

  test('lists recent moves, naming subagents', async () => {
    rotationState = {
      settings: { enabled: true, intervalMinutes: 5 },
      moves: [
        { at: Date.now(), poolID: 'busy', sessionID: 'ses_sub', subagent: true, from: 'openai/a', to: 'anthropic/b' },
        { at: Date.now() - 1000, poolID: 'busy', sessionID: 'ses_main', subagent: false, from: 'openai/a', to: 'anthropic/b' },
      ],
    };
    const { dom, cleanup } = await renderFields();
    try {
      expect(dom.container.textContent).toContain('Subagent ses_sub: openai/a → anthropic/b');
      expect(dom.container.textContent).toContain('Session ses_main: openai/a → anthropic/b');
    } finally {
      await cleanup();
    }
  });

  test('says when the settings cannot be read', async () => {
    loadFailure = new Error('pool-rotation.json is not valid JSON');
    const { dom, cleanup } = await renderFields();
    try {
      expect(dom.container.textContent).toContain('Rotation settings could not be read: pool-rotation.json is not valid JSON');
    } finally {
      await cleanup();
    }
  });
});
