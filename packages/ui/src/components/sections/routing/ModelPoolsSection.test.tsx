import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ScheduleList, ScheduleListValue, StoredSchedules } from '@/lib/routing/scheduleSchema';

// Hand-rolled recorders rather than bun's `mock()`: its installed types omit
// `.mock`/`mockClear`, while the runtime behaviour is all these tests need.
const routeFetches: string[] = [];
const routeSaves: unknown[] = [];
const tuningSaves: unknown[] = [];
const scheduleSaves: unknown[] = [];
let serverRoutes: Record<string, {
  targets: string[];
  selection?: 'ordered' | 'round-robin' | 'weighted';
  weights?: Record<string, number>;
  description?: string;
  details?: string;
}> = {};
let serverTuning: unknown = null;
let serverSchedules: ScheduleList | null = null;
let serverOtherSchedules: { path: string; schedules: StoredSchedules }[] = [];
let serverOtherRoutes: { path: string; routes: typeof serverRoutes }[] = [];
let saveError: Error | null = null;

let serverAvailable = true;
const fetchModelRoutes = async () => {
  routeFetches.push('fetch');
  return { routes: serverRoutes, tuning: serverTuning, schedules: serverSchedules, otherSchedules: serverOtherSchedules, otherRoutes: serverOtherRoutes, available: serverAvailable };
};
const saveModelRoutes = async (routes: unknown) => {
  routeSaves.push(routes);
  if (saveError) throw saveError;
  serverRoutes = routes as typeof serverRoutes;
  return { routes, tuning: serverTuning, otherRoutes: serverOtherRoutes, available: true };
};
const saveModelRouteTuning = async (tuning: unknown) => {
  tuningSaves.push(tuning);
  if (saveError) throw saveError;
  serverTuning = tuning;
  return { routes: serverRoutes, tuning, available: true };
};
// When set, the nth schedule save waits for the nth gate, so a test can hold saves open.
let scheduleSaveGates: Array<Promise<void>> = [];
const saveModelRouteSchedules = async (schedules: ScheduleListValue | null) => {
  const gate = scheduleSaveGates[scheduleSaves.length];
  scheduleSaves.push(schedules);
  if (gate) await gate;
  if (saveError) throw saveError;
  serverSchedules = schedules;
  return { routes: serverRoutes, tuning: serverTuning, schedules, otherSchedules: serverOtherSchedules, available: true };
};
const fetchRouteStats = async () => ({ available: false, reason: 'no-database' });

mock.module('@/lib/routing/modelRoutesApi', () => ({
  AUTONOMY_LEVELS: ['fixed', 'rules', 'adaptive', 'predictive', 'agent'],
  POOL_DETAILS_MAX_LENGTH: 2000,
  fetchModelRoutes,
  saveModelRoutes,
  saveModelRouteTuning,
  saveModelRouteSchedules,
  fetchRouteStats,
}));

const { useConfigStore } = await import('@/stores/useConfigStore');
const { useRoutingStore } = await import('@/stores/useRoutingStore');

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

const textModel = (id: string, cost: number, context: number) => ({
  id,
  modelID: id,
  providerID: 'p',
  name: id,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: cost, output: cost, cache: { read: 0, write: 0 } }],
  status: 'active',
  enabled: true,
  limit: { context, output: 1000 },
});

const renderSection = async () => {
  const dom = installDom();
  // Imported after the DOM exists: Base UI and react-dom read the window when their modules load.
  const { createRoot } = await import('react-dom/client');
  const { ModelPoolsSection } = await import('./ModelPoolsSection');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelPoolsSection />
      </I18nProvider>,
    );
  });
  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

const findByAriaLabel = (container: HTMLElement, selector: string, label: string) => {
  const found = [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no ${selector} labelled "${label}"`);
  return found;
};
const findInput = (container: HTMLElement, label: string) => findByAriaLabel(container, 'input', label) as HTMLInputElement;
const findSwitch = (container: HTMLElement, label: string) => findByAriaLabel(container, '[role="switch"]', label);

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
  const trigger = findByAriaLabel(container, '[role="combobox"]', label);
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

const expandPool = async (container: HTMLElement, poolName = 'kept') => {
  const row = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')].find((el) => el.textContent?.includes(poolName));
  expect(row).toBeTruthy();
  await act(async () => row!.click());
};

const clickButton = async (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

const openAdvanced = async (container: HTMLElement, poolName = 'kept') => {
  await expandPool(container, poolName);
  await clickButton(container, 'Show advanced options');
};

describe('ModelPoolsSection', () => {
  let root: Root | null = null;

  beforeEach(() => {
    routeFetches.length = 0;
    routeSaves.length = 0;
    tuningSaves.length = 0;
    scheduleSaves.length = 0;
    scheduleSaveGates = [];
    serverRoutes = {};
    serverTuning = null;
    serverSchedules = null;
    serverOtherSchedules = [];
    serverOtherRoutes = [];
    saveError = null;
    serverAvailable = true;
    useConfigStore.setState({
      providers: [
        {
          id: 'p',
          name: 'p',
          models: [textModel('cheap', 1, 8000), textModel(' dear', 10, 200000)],
        },
      ],
    } as never);
    useRoutingStore.setState({ decisions: {} } as never);
  });

  afterEach(async () => {
    if (root) {
      const mounted = root;
      root = null;
      await act(async () => mounted.unmount());
    }
  });

  test('renders presets and an empty pool list from the server state', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('Model pools');
      expect(text).toContain('Cheapest first');
      expect(text).toContain('Fastest first');
      expect(text).toContain('Sturdiest first');
      expect(routeFetches.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('shows the unavailable message instead of Loading when the server has no model-routes endpoint', async () => {
    serverAvailable = false;
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('Routing is not available on this server.');
      expect(text).not.toContain('Loading pools');
      expect(routeFetches.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('a preset builds a pool from the catalog and saves it', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      const button = [...dom.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Cheapest first');
      expect(button).toBeTruthy();
      await act(async () => {
        button!.click();
      });
      expect(routeSaves.length).toBe(1);
      const saved = routeSaves[0] as Record<string, { targets: string[] }>;
      expect(Object.keys(saved)).toEqual(['cheap-pool']);
      expect(saved['cheap-pool'].targets).toEqual(['p/cheap', 'p/ dear']);
      expect(dom.container.textContent).toContain('cheap-pool');
    } finally {
      await cleanup();
    }
  });

  test('a failed save rolls back to the last server-confirmed state', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    saveError = new Error('nope');
    const { dom, cleanup } = await renderSection();
    try {
      const button = [...dom.container.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Cheapest first');
      await act(async () => {
        button!.click();
      });
      const text = dom.container.textContent ?? '';
      expect(text).toContain('kept');
      expect(text).not.toContain('cheap-pool');
      expect(text).toContain('nope');
    } finally {
      await cleanup();
    }
  });

  test('advanced editor saves a changed attempts count when the field is left', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Total requests before failover'), '3');
      expect(routeSaves.length).toBe(1);
      expect((routeSaves[0] as Record<string, { attempts?: number }>).kept.attempts).toBe(3);
    } finally {
      await cleanup();
    }
  });

  test('advanced editor refuses an out-of-range value and saves nothing', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Total requests before failover'), '99');
      expect(routeSaves.length).toBe(0);
      expect(dom.container.textContent).toContain('Enter a number from 1 to 50.');
    } finally {
      await cleanup();
    }
  });

  test('advanced editor converts hedge seconds to milliseconds', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Hedge after (seconds)'), '2');
      expect((routeSaves[0] as Record<string, { hedgeAfterMs?: number }>).kept.hedgeAfterMs).toBe(2000);
    } finally {
      await cleanup();
    }
  });

  test('advanced editor saves per-target budgets with the soft limit as a fraction', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Requests per minute'), '60');
      await typeInto(findInput(dom.container, 'Soft limit (% of allowance)'), '80');
      const saved = routeSaves.at(-1) as Record<string, { budgets?: Record<string, Record<string, number>> }>;
      expect(saved.kept.budgets).toEqual({ 'p/cheap': { requestsPerMinute: 60, softLimit: 0.8 } });
    } finally {
      await cleanup();
    }
  });

  test('display name saves when left and an empty name removes it', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await typeInto(findInput(dom.container, 'Display name'), 'Budget pool');
      expect((routeSaves.at(-1) as Record<string, { name?: string }>).kept.name).toBe('Budget pool');
      await typeInto(findInput(dom.container, 'Display name'), '');
      expect((routeSaves.at(-1) as Record<string, { name?: string }>).kept.name).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('description and details show on the pool, save when left, and empty text removes them', async () => {
    // beforeEach gave the server an empty map; the pool is added to it.
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap'], description: 'Quick fixes', details: 'Old notes' } });
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('Quick fixes');
      await expandPool(dom.container);
      expect(findInput(dom.container, 'Description').value).toBe('Quick fixes');
      const details = dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Details"]');
      if (!details) throw new Error('no details field');
      expect(details.value).toBe('Old notes');
      await typeInto(findInput(dom.container, 'Description'), '  Long refactors; slow  ');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], description: 'Long refactors; slow', details: 'Old notes' } });
      await act(async () => {
        details.value = ' Spans packages.\nAvoid for typos. ';
        details.dispatchEvent(new Event('focusout', { bubbles: true }));
      });
      expect(routeSaves.at(-1)).toEqual({
        kept: { targets: ['p/cheap'], description: 'Long refactors; slow', details: 'Spans packages.\nAvoid for typos.' },
      });
      await typeInto(findInput(dom.container, 'Description'), '');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], details: 'Spans packages.\nAvoid for typos.' } });
    } finally {
      await cleanup();
    }
  });

  test('a target remap saves as a variants map on the object form', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await clickButton(dom.container, 'Options');
      await typeInto(findInput(dom.container, 'Default variant'), 'max');
      expect((routeSaves.at(-1) as Record<string, { targets: unknown[] }>).kept.targets).toEqual([
        { model: 'p/cheap', defaultVariant: 'max' },
      ]);
      await typeInto(findInput(dom.container, 'Pool variant'), 'low');
      await typeInto(findInput(dom.container, 'Target variant'), 'high');
      await clickButton(dom.container, 'Add remap');
      expect((routeSaves.at(-1) as Record<string, { targets: unknown[] }>).kept.targets).toEqual([
        { model: 'p/cheap', defaultVariant: 'max', variants: { low: 'high' } },
      ]);
    } finally {
      await cleanup();
    }
  });

  test('removing a weighted target saves the pool without that target\'s weight', async () => {
    // beforeEach gave the server an empty map; the pool is added to it.
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap', 'p/dear'], selection: 'weighted', weights: { 'p/cheap': 2, 'p/dear': 1 } } });
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await clickButton(dom.container, 'Remove target');
      expect(routeSaves.at(-1)).toMatchObject({
        kept: { targets: ['p/dear'], selection: 'weighted', weights: { 'p/dear': 1 } },
      });
    } finally {
      await cleanup();
    }
  });

  test('disabling the first-token timeout saves false and re-enabling removes it', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await act(async () => findSwitch(dom.container, 'Never time out the first token').click());
      expect((routeSaves.at(-1) as Record<string, { health?: { firstTokenTimeoutMs?: unknown } }>).kept.health).toEqual({
        firstTokenTimeoutMs: false,
      });
      await act(async () => findSwitch(dom.container, 'Never time out the first token').click());
      expect((routeSaves.at(-1) as Record<string, { health?: unknown }>).kept.health).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('the autonomy popup saves the level picked, and its default clears the level', async () => {
    // beforeEach gave the server an empty map; the pool is added to it.
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap'], autonomy: 'rules' } });
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await pickOption(dom.container, 'Autonomy', 'Predictive');
      expect(routeSaves.at(-1)).toMatchObject({ kept: { targets: ['p/cheap'], autonomy: 'predictive' } });
      // toEqual ignores the undefined key the default leaves behind, which the JSON save drops anyway.
      await pickOption(dom.container, 'Autonomy', 'Unset (full behavior)');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'] } });
    } finally {
      await cleanup();
    }
  });

  test('automatic review switch saves enabled and then explicitly disabled', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      const toggle = findSwitch(dom.container, 'Review routing history automatically');
      await act(async () => toggle.click());
      expect(tuningSaves).toEqual([{ enabled: true }]);
      await act(async () => findSwitch(dom.container, 'Review routing history automatically').click());
      expect(tuningSaves.at(-1)).toEqual({ enabled: false });
    } finally {
      await cleanup();
    }
  });

  test('automatic review interval is range checked before saving', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      await typeInto(findInput(dom.container, 'Minutes between reviews'), '5000');
      expect(tuningSaves.length).toBe(0);
      expect(dom.container.textContent).toContain('Enter a number from 1 to 1440.');
      await typeInto(findInput(dom.container, 'Minutes between reviews'), '30');
      expect(tuningSaves.at(-1)).toEqual({ intervalMinutes: 30 });
    } finally {
      await cleanup();
    }
  });

  test('a pool schedule saves inside that pool', async () => {
    // beforeEach gave the server an empty map; the pool is added to it.
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap'] } });
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      // The pool's list renders before the one across pools, so its button comes first.
      await clickButton(dom.container, 'Add schedule');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], schedules: [{ when: {}, factor: 1 }] } });
      expect(scheduleSaves).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('schedules across pools load, save through their own request, and an empty list removes them', async () => {
    serverSchedules = [{ providers: ['deepseek'], when: { start: '09:00', end: '17:00' }, factor: 0.5 }];
    const { dom, cleanup } = await renderSection();
    try {
      expect(findInput(dom.container, 'Providers').value).toBe('deepseek');
      await typeInto(findInput(dom.container, 'Pools'), 'cheap-pool');
      expect(scheduleSaves.at(-1)).toEqual([
        { providers: ['deepseek'], when: { start: '09:00', end: '17:00' }, factor: 0.5, routes: ['cheap-pool'] },
      ]);
      await clickButton(dom.container, 'Remove schedule');
      expect(scheduleSaves.at(-1)).toBeNull();
      expect(routeSaves).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('schedule saves go one at a time, and an older answer never replaces a newer edit', async () => {
    serverSchedules = [{ providers: ['deepseek'], when: {}, factor: 0.5 }];
    const releases: Array<() => void> = [];
    scheduleSaveGates = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
    const { dom, cleanup } = await renderSection();
    try {
      await typeInto(findInput(dom.container, 'Pools'), 'first');
      await typeInto(findInput(dom.container, 'Pools'), 'second');
      // The second save waits for the first to answer.
      expect(scheduleSaves).toHaveLength(1);
      await act(async () => { releases[0](); await flush(); });
      // The first answer has landed; the newer edit stays on screen.
      expect(scheduleSaves).toHaveLength(2);
      expect(findInput(dom.container, 'Pools').value).toBe('second');
      await act(async () => { releases[1](); await flush(); });
      expect(scheduleSaves).toMatchObject([[{ routes: ['first'] }], [{ routes: ['second'] }]]);
      expect(findInput(dom.container, 'Pools').value).toBe('second');
    } finally {
      await cleanup();
    }
  });

  // OpenCode adds up the lists from every config file; only the user file's is editable here.
  test('lists from other config files show read-only with their file, and saves never include them', async () => {
    serverSchedules = [{ providers: ['deepseek'], when: {}, factor: 0.5 }];
    serverOtherSchedules = [{ path: '/repo/opencode.json', schedules: [{ models: ['*flash*'], when: {}, weight: 2 }] }];
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('These schedules from /repo/opencode.json also apply. Edit them in that file.');
      expect(text).toContain('*flash*');
      expect([...dom.container.querySelectorAll('input')].some((el) => el.value === '*flash*')).toBe(false);
      await typeInto(findInput(dom.container, 'Pools'), 'cheap-pool');
      expect(scheduleSaves.at(-1)).toEqual([{ providers: ['deepseek'], when: {}, factor: 0.5, routes: ['cheap-pool'] }]);
    } finally {
      await cleanup();
    }
  });

  // #324: pools from other config files show read-only; a save writes only the user file's pools.
  test('pools from other config files show read-only with their file, and saves never include them', async () => {
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap'] } });
    serverOtherRoutes = [{ path: '/repo/opencode.json', routes: { projectonly: { targets: ['p/projectmodel'] } } }];
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('These pools from /repo/opencode.json also apply. Edit them in that file.');
      expect(text).toContain('projectonly');
      expect(text).toContain('p/projectmodel');
      await openAdvanced(dom.container);
      await clickButton(dom.container, 'Add schedule');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], schedules: [{ when: {}, factor: 1 }] } });
    } finally {
      await cleanup();
    }
  });

  test('a malformed schedule list still lets the pools load', async () => {
    Object.assign(serverRoutes, { kept: { targets: ['p/cheap'], schedules: { start: 900 } } });
    serverSchedules = [{ when: { start: 900 }, factor: 2 }];
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('kept');
      expect(text).toContain("OpenChamber can't read this schedule");
    } finally {
      await cleanup();
    }
  });

  test('a refused schedule save rolls back to the saved list and shows why', async () => {
    saveError = new Error('schedule 1 when.timezone must be an IANA timezone');
    const { dom, cleanup } = await renderSection();
    try {
      await clickButton(dom.container, 'Add schedule');
      expect(scheduleSaves).toEqual([[{ when: {}, factor: 1 }]]);
      expect([...dom.container.querySelectorAll('button')].some((el) => el.textContent?.trim() === 'Remove schedule')).toBe(false);
      expect(dom.container.textContent).toContain('schedule 1 when.timezone must be an IANA timezone');
    } finally {
      await cleanup();
    }
  });

  test('recent Auto decisions render in the expert view', async () => {
    useRoutingStore.setState({
      decisions: {
        s1: { sessionId: 's1', at: 2, category: 'hard', confidence: 0.9, reason: 'routed', providerID: 'openai', modelID: 'x' },
      },
    } as never);
    const { dom, cleanup } = await renderSection();
    try {
      // Decisions render once the mocked fetch resolves.
      await act(async () => {});
      expect(dom.container.textContent).toContain('hard');
    } finally {
      await cleanup();
    }
  });
});
