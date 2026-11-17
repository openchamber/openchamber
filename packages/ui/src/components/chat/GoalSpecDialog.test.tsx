import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { GoalSpecResult, GoalSubmitChoice } from '@/lib/goalWriter';
import type { GoalSpecDialogRequest } from './GoalSpecDialog';
import { useConfigStore } from '@/stores/useConfigStore';

// React DOM and the Base UI dialog probe for a DOM when first imported; without
// one the dialog never mounts its popup. Give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
// The writer picker's model stores read localStorage when they load.
const importGlobals = ['window', 'document', 'localStorage'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: importWindow.localStorage, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { GoalSpecDialog } = await import('./GoalSpecDialog');
const { diffGoalSpecLines } = await import('@/lib/goalSpec');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const written: GoalSpecResult = { ok: true, spec: '## Objective\nDark mode', providerID: 'p', modelID: 'm', variant: null };
const base = { sessionModel: null, directory: null, inputLength: 12 } as const;

describe('GoalSpecDialog', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let choices: GoalSubmitChoice[];
  let cancels: number;

  const render = (request: Omit<GoalSpecDialogRequest, 'id'>) => act(async () => root.render(
    <I18nProvider>
      <GoalSpecDialog
        request={{ id: 1, ...request }}
        onCancel={() => { cancels += 1; }}
        onSubmit={(choice) => { choices.push(choice); }}
      />
    </I18nProvider>,
  ));
  const button = (label: string): HTMLButtonElement => {
    const match = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === label);
    if (!match) throw new Error(`No button "${label}" in: ${document.body.textContent}`);
    return match;
  };
  const click = (label: string) => act(async () => { button(label).click(); });

  beforeEach(() => {
    choices = [];
    cancels = 0;
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('shows the written spec for approval and sends it either way', async () => {
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: async () => written });

    expect(document.querySelector('textarea')?.value).toBe('## Objective\nDark mode');
    expect(document.body.textContent).toContain('Written by p/m');

    await click('Send message with goal');
    await click('Send goal as message');
    expect(choices).toEqual([
      { kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: false },
      { kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'goal-as-message', ignoreLimit: false },
    ]);
  });

  test('shows a labelled token estimate beside the character counter', async () => {
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: async () => written });

    // '## Objective\nDark mode' is 22 chars; the estimate is ceil(22/4) = 6.
    expect(document.body.textContent).toContain('22/');
    expect(document.body.textContent).toContain('~6 tokens (est.)');
  });

  test('a rewrite shows a diff of the previous spec, and an unchanged rewrite shows none', async () => {
    let run = 0;
    await render({
      ...base,
      trigger: 'armed',
      review: true,
      defaultSendMode: 'with-message',
      write: async () => {
        run += 1;
        return run === 1 ? written : { ...written, spec: '## Objective\nLight mode' };
      },
    });
    // The first write has nothing to diff against.
    expect(document.body.textContent).not.toContain('Changes in this rewrite');

    await click('Write again');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Changes in this rewrite');
    expect(text).toContain('Dark mode');
    expect(text).toContain('Light mode');
  });

  test('an unchanged rewrite shows no diff', async () => {
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: async () => written });

    await click('Write again');
    expect(document.body.textContent).not.toContain('Changes in this rewrite');
  });

  test('diffGoalSpecLines marks removed and added lines', () => {
    expect(diffGoalSpecLines('a\nb', 'a\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
    expect(diffGoalSpecLines('', 'a')).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffGoalSpecLines('a', 'a')).toEqual([{ kind: 'same', text: 'a' }]);
  });

  test('without review the spec goes out as soon as it is written, in the default mode', async () => {
    await render({ ...base, trigger: 'auto-create', review: false, defaultSendMode: 'goal-as-message', write: async () => written });

    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'goal-as-message', ignoreLimit: false }]);
  });

  test('a failure waits for the user even without review, and can be retried', async () => {
    let attempts = 0;
    await render({
      ...base,
      trigger: 'armed',
      review: false,
      defaultSendMode: 'with-message',
      write: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, message: 'No small model available' } : written;
      },
    });

    expect(choices).toEqual([]);
    expect(document.body.textContent).toContain('No small model available');

    await click('Try again');
    expect(attempts).toBe(2);
    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: false }]);
  });

  test('skipping keeps an armed goal as typed, and sends an automatic one without a goal', async () => {
    const pending = () => new Promise<GoalSpecResult>(() => undefined);
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: pending });
    await click('Use my message as the goal');
    await click('Cancel');

    await render({ ...base, trigger: 'auto-create', review: true, defaultSendMode: 'with-message', write: pending });
    await click('Send without a goal');

    expect(choices).toEqual([{ kind: 'unchanged' }, { kind: 'none' }]);
    expect(cancels).toBe(1);
  });

  test('the length limit switch applies to the next writing run and to the goal sent', async () => {
    const runs: boolean[] = [];
    await render({
      ...base,
      trigger: 'armed',
      review: true,
      defaultSendMode: 'with-message',
      write: async (_signal, options) => {
        runs.push(options.ignoreLimit);
        return written;
      },
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More goal options"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) => element.textContent?.includes('No length limit for this goal'));
    if (!item) throw new Error(`No limit switch in: ${document.body.textContent}`);
    await act(async () => { item.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await click('Write again');
    await click('Send message with goal');

    expect(runs).toEqual([false, true]);
    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: true }]);
  });

  test('an effort picked in the window is recorded once per pick, when it writes', async () => {
    const recorded: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/openchamber/model-choices')) recorded.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }, { preconnect: async () => {} });
    const previousProviders = useConfigStore.getState().providers;
    useConfigStore.setState({ providers: [{
      id: 'p', name: 'p', activation: 'enabled', package: 'p',
      models: [{
        id: 'm', modelID: 'm', providerID: 'p', name: 'm',
        capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }],
        time: { released: 0 }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active', enabled: true, limit: { context: 0, output: 0 },
      }],
    }] });
    // A Base UI select opens on a press and commits an option only after a hover
    // has highlighted it; each step runs in its own act (as in PoolAdvancedFields.test).
    const fire = (target: Element, type: string) => {
      const init = { bubbles: true, cancelable: true, button: 0 };
      target.dispatchEvent(type.startsWith('pointer') ? new window.PointerEvent(type, { ...init, pointerType: 'mouse' }) : new window.MouseEvent(type, init));
    };
    const pickEffort = async (label: string) => {
      const trigger = document.querySelector<HTMLElement>('[aria-label="Goal writer effort"]');
      if (!trigger) throw new Error(`No effort select in: ${document.body.textContent}`);
      await act(async () => {
        fire(trigger, 'pointerdown');
        fire(trigger, 'mousedown');
      });
      const option = Array.from(document.querySelectorAll('[role="option"]')).find((element) => element.textContent?.trim() === label);
      if (!option) throw new Error(`No effort "${label}" in: ${document.body.textContent}`);
      await act(async () => {
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(option, type);
      });
      await act(async () => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(option, type);
      });
      expect(trigger.textContent).toBe(label);
    };
    try {
      await render({ ...base, sessionModel: { providerID: 'p', modelID: 'm' }, inputLength: 3_000, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: async () => written });
      await pickEffort('Low');
      expect(recorded).toEqual([]);
      await click('Write again');
      await click('Write again');
      await pickEffort('High');
      await click('Write again');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    } finally {
      globalThis.fetch = originalFetch;
      useConfigStore.setState({ providers: previousProviders });
    }

    const choice = (variant: string) => ({
      surface: 'goal-writer',
      kind: 'effort',
      chosen: { model: 'p/m', variant },
      replaced: { model: 'p/m', variant: null },
      sessionModel: 'p/m',
      inputSize: 'long',
    });
    expect(recorded).toEqual([choice('low'), choice('high')]);
  });
});
