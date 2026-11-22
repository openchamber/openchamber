import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ModelRoute } from '@/lib/routing/modelRoutesApi';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'MutationObserver',
  'ResizeObserver',
  'cancelAnimationFrame',
  'getComputedStyle',
  'requestAnimationFrame',
  'localStorage',
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

let mounted: { root: Root; restore: () => void } | null = null;

const renderFields = async (route: ModelRoute, onChange: (next: ModelRoute) => void) => {
  const dom = installDom();
  // Imported after the DOM exists: Base UI and react-dom read the window when their modules load.
  const { createRoot } = await import('react-dom/client');
  const { PoolAdvancedFields } = await import('./PoolAdvancedFields');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <PoolAdvancedFields route={route} onChange={onChange} />
      </I18nProvider>,
    );
  });
  return dom.container;
};

const inputNamed = (container: HTMLElement, label: string): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no input labelled "${label}"`);
  return input;
};

const switchNamed = (container: HTMLElement, label: string): HTMLElement => {
  const control = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!control) throw new Error(`no switch labelled "${label}"`);
  return control;
};

// Fields commit when the user leaves them; happy-dom does not route synthetic input events to React.
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
};

const fire = (target: Element, type: string) => {
  const init = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
};

// A press on the trigger opens the popup. An option commits only once a hover has highlighted it, so the
// pick hovers first and presses in a later step; both steps run in their own act so React renders between them.
const pickOption = async (container: HTMLElement, label: string, option: string) => {
  const trigger = container.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!trigger) throw new Error(`no select labelled "${label}"`);
  await act(async () => {
    fire(trigger, 'pointerdown');
    fire(trigger, 'mousedown');
  });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.trim() === option);
  if (!item) throw new Error(`no option "${option}"`);
  await act(async () => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(item, type);
  });
  await act(async () => {
    fire(item, 'pointerdown');
    fire(item, 'mousedown');
    fire(item, 'pointerup');
    fire(item, 'mouseup');
    fire(item, 'click');
  });
};

describe('PoolAdvancedFields', () => {
  let changes: ModelRoute[] = [];
  const onChange = (next: ModelRoute) => {
    changes.push(next);
  };

  beforeEach(() => {
    changes = [];
  });

  afterEach(async () => {
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('asks for two requests in total by default, and saves the attempts as typed', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    const attempts = inputNamed(container, 'Total requests before failover');
    expect(attempts.placeholder).toBe('2');
    await typeInto(attempts, '3');
    expect(changes.at(-1)).toMatchObject({ attempts: 3 });
  });

  test('saves the health window and the slow-request threshold separately', async () => {
    const container = await renderFields({ targets: ['p/cheap'], health: { sampleWindow: 5 } }, onChange);
    await typeInto(inputNamed(container, 'Requests counted for health'), '4');
    expect(changes.at(-1)).toMatchObject({ health: { sampleWindow: 4 } });
    await typeInto(inputNamed(container, 'Slow requests that mark a target degraded'), '2');
    expect(changes.at(-1)).toMatchObject({ health: { sampleWindow: 5, slowThreshold: 2 } });
  });

  test('saves the time limits in milliseconds, and the switch that turns the first-token timeout off', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    await typeInto(inputNamed(container, 'First response timeout (seconds)'), '30');
    expect(changes.at(-1)).toMatchObject({ health: { firstTokenTimeoutMs: 30000 } });
    await typeInto(inputNamed(container, 'Slow above (seconds)'), '45');
    expect(changes.at(-1)).toMatchObject({ health: { maxResponseTimeMs: 45000 } });
    await act(async () => switchNamed(container, 'Never time out the first token').click());
    expect(changes.at(-1)).toMatchObject({ health: { firstTokenTimeoutMs: false } });
  });

  test('saves the failure and quota cooldowns in seconds, and the slow-rate floor as typed', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    await typeInto(inputNamed(container, 'Cooldown after failure (seconds)'), '90');
    expect(changes.at(-1)).toMatchObject({ health: { cooldownMs: 90000 } });
    await typeInto(inputNamed(container, 'Cooldown when quota runs out (seconds)'), '1200');
    expect(changes.at(-1)).toMatchObject({ health: { quotaCooldownMs: 1200000 } });
    await typeInto(inputNamed(container, 'Slow below (tokens per second)'), '12.5');
    expect(changes.at(-1)).toMatchObject({ health: { minOutputTokensPerSecond: 12.5 } });
  });

  test('saves a tokens-per-day allowance against the model it names', async () => {
    const container = await renderFields({ targets: ['p/cheap', 'opencode-route/other'] }, onChange);
    await typeInto(inputNamed(container, 'Tokens per day'), '500000');
    expect(changes.at(-1)).toMatchObject({ budgets: { 'p/cheap': { tokensPerDay: 500000 } } });
  });

  test('the selection popup saves the mode picked', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    await pickOption(container, 'Selection', 'Round-robin');
    expect(changes.at(-1)).toEqual({ targets: ['p/cheap'], selection: 'round-robin' });
  });

  test('the selection popup default removes the mode from the route', async () => {
    const container = await renderFields({ targets: ['p/cheap'], selection: 'weighted' }, onChange);
    await pickOption(container, 'Selection', 'Default (ordered)');
    expect(changes.at(-1)).not.toHaveProperty('selection');
    expect(changes.at(-1)).toEqual({ targets: ['p/cheap'] });
  });

  test('shows a weight per model target only when the selection draws by weight, and saves it by reference', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    expect(container.querySelector('input[aria-label="Weight: p/cheap"]')).toBeNull();

    await rerenderFields({ targets: ['p/cheap'], selection: 'ordered' }, onChange);
    expect(container.querySelector('input[aria-label="Weight: p/cheap"]')).toBeNull();

    await rerenderFields({ targets: ['p/cheap#high'], selection: 'weighted' }, onChange);
    await typeInto(inputNamed(container, 'Weight: p/cheap'), '3');
    expect(changes.at(-1)).toMatchObject({ weights: { 'p/cheap': 3 } });

    await rerenderFields({ targets: ['p/cheap#high'], selection: 'round-robin' }, onChange);
    expect(container.querySelector('input[aria-label="Weight: p/cheap"]')).not.toBeNull();
    await typeInto(inputNamed(container, 'Weight: p/cheap'), '2');
    expect(changes.at(-1)).toMatchObject({ weights: { 'p/cheap': 2 } });
  });
});

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
};

// Renders new props into the mounted root, as the parent does after a save.
const rerenderFields = async (route: ModelRoute, onChange: (next: ModelRoute) => void) => {
  const { PoolAdvancedFields } = await import('./PoolAdvancedFields');
  const { I18nProvider } = await import('@/lib/i18n');
  await act(async () => {
    mounted?.root.render(
      <I18nProvider>
        <PoolAdvancedFields route={route} onChange={onChange} />
      </I18nProvider>,
    );
  });
};

describe('PoolAdvancedFields schedules', () => {
  let changes: ModelRoute[] = [];
  const onChange = (next: ModelRoute) => {
    changes.push(next);
  };
  const scheduled: ModelRoute = { targets: ['p/cheap'], schedules: [{ when: {}, factor: 1 }] };

  beforeEach(() => {
    changes = [];
  });

  afterEach(async () => {
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('a new schedule changes nothing until edited, and removing the last one drops the key', async () => {
    const empty = await renderFields({ targets: ['p/cheap'] }, onChange);
    await act(async () => buttonNamed(empty, 'Add schedule').click());
    expect(changes.at(-1)).toEqual({ targets: ['p/cheap'], schedules: [{ when: {}, factor: 1 }] });
    await act(async () => mounted?.root.unmount());
    mounted?.restore();
    mounted = null;

    const container = await renderFields(scheduled, onChange);
    await act(async () => buttonNamed(container, 'Remove schedule').click());
    expect(changes.at(-1)).toEqual({ targets: ['p/cheap'] });
  });

  test('weekday chips save short day names in week order, and the last one off means every day', async () => {
    const container = await renderFields(
      { targets: ['p/cheap'], schedules: [{ when: { daysOfWeek: ['friday'] }, factor: 0.5 }] },
      onChange,
    );
    expect(buttonNamed(container, 'Fri').getAttribute('aria-pressed')).toBe('true');
    await act(async () => buttonNamed(container, 'Mon').click());
    expect(changes.at(-1)?.schedules).toEqual([{ when: { daysOfWeek: ['mon', 'fri'] }, factor: 0.5 }]);
    await act(async () => buttonNamed(container, 'Fri').click());
    expect(changes.at(-1)?.schedules).toEqual([{ when: {}, factor: 0.5 }]);
  });

  test('saves the targets, hours and days of the month as typed', async () => {
    const container = await renderFields(scheduled, onChange);
    await typeInto(inputNamed(container, 'Targets'), 'deepseek/*, , openai/gpt-6-luna');
    expect(changes.at(-1)?.schedules).toEqual([{ when: {}, factor: 1, targets: ['deepseek/*', 'openai/gpt-6-luna'] }]);
    await typeInto(inputNamed(container, 'Start'), '09:00');
    expect(changes.at(-1)?.schedules).toEqual([{ when: { start: '09:00' }, factor: 1 }]);
    await typeInto(inputNamed(container, 'Days of the month'), '1, 15, -1');
    expect(changes.at(-1)?.schedules).toEqual([{ when: { daysOfMonth: [1, 15, -1] }, factor: 1 }]);
  });

  // A time input holds only HH:mm[:ss]. Given "9:30" raw, a browser shows an
  // empty field and the next blur used to save the window without its start.
  test('shows a stored 9:30 as 09:30 with seconds kept, and a blur that changed nothing saves nothing', async () => {
    const container = await renderFields(
      { targets: ['p/cheap'], schedules: [{ when: { start: '9:30', end: '17:5:15' }, factor: 1 }] },
      onChange,
    );
    const start = inputNamed(container, 'Start');
    expect(start.type).toBe('time');
    expect(start.value).toBe('09:30');
    expect(inputNamed(container, 'End').value).toBe('17:05:15');
    await typeInto(start, '09:30');
    expect(changes).toEqual([]);
    await typeInto(start, '10:00:30');
    expect(changes.at(-1)?.schedules).toEqual([{ when: { start: '10:00:30', end: '17:5:15' }, factor: 1 }]);
  });

  test('a stored time no time input can hold shows as text with the error, and is kept on blur', async () => {
    const container = await renderFields({ targets: ['p/cheap'], schedules: [{ when: { start: '25:00' }, factor: 1 }] }, onChange);
    const start = inputNamed(container, 'Start');
    expect(start.type).toBe('text');
    expect(start.value).toBe('25:00');
    expect(container.textContent).toContain('Enter a time such as 09:00.');
    await typeInto(start, '25:00');
    expect(changes).toEqual([]);
  });

  test('refuses a day of the month or a timezone OpenCode cannot read, and saves nothing', async () => {
    const container = await renderFields(scheduled, onChange);
    await typeInto(inputNamed(container, 'Days of the month'), '0, 32');
    await typeInto(inputNamed(container, 'Timezone'), 'Mars/Olympus');
    expect(changes).toEqual([]);
    expect(container.textContent).toContain('Enter days from 1 to 31, or -1 for the last day of the month.');
    expect(container.textContent).toContain('Enter an IANA timezone such as America/Chicago.');
    await typeInto(inputNamed(container, 'Timezone'), 'America/Chicago');
    expect(changes.at(-1)?.schedules).toEqual([{ when: { timezone: 'America/Chicago' }, factor: 1 }]);
  });

  test('switching to an outright weight replaces the factor, and the amount then saves as the weight', async () => {
    const container = await renderFields({ targets: ['p/cheap'], schedules: [{ when: {}, factor: 0.5 }] }, onChange);
    await pickOption(container, 'Change', 'Set weight');
    const switched = changes.at(-1);
    expect(switched?.schedules).toEqual([{ when: {}, weight: 0.5 }]);
    if (!switched) throw new Error('no change after switching');
    await rerenderFields(switched, onChange);
    await typeInto(inputNamed(container, 'Weight while active'), '2');
    expect(changes.at(-1)?.schedules).toEqual([{ when: {}, weight: 2 }]);
  });

  test('shows an entry it cannot read as stored, keeps it through edits to the others, and can remove it', async () => {
    const unreadable = { when: { start: 900 }, factor: 2 };
    const container = await renderFields({ targets: ['p/cheap'], schedules: [unreadable, { when: {}, factor: 1 }] }, onChange);
    expect(container.textContent).toContain("OpenChamber can't read this schedule");
    expect(container.textContent).toContain('"start": 900');
    // The only editable entry is the second one, so its fields are the only ones rendered.
    await typeInto(inputNamed(container, 'Note'), 'peak');
    expect(changes.at(-1)?.schedules).toEqual([unreadable, { when: {}, factor: 1, note: 'peak' }]);
    await act(async () => buttonNamed(container, 'Remove schedule').click());
    expect(changes.at(-1)?.schedules).toEqual([{ when: {}, factor: 1 }]);
  });

  test('a stored value that is not a list shows read-only, without editing controls', async () => {
    const container = await renderFields({ targets: ['p/cheap'], schedules: { start: '09:00' } }, onChange);
    expect(container.textContent).toContain("OpenChamber can't read these schedules because they are not a list.");
    expect([...container.querySelectorAll('button')].some((el) => el.textContent?.trim() === 'Add schedule')).toBe(false);
  });
});
