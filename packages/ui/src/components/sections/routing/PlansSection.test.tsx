import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Recorders rather than bun's `mock()`: the installed types omit `.mock`, and the behaviour these tests need is simple.
const commandStarts: string[] = [];
const pendingTexts: Array<{ text: string; mode: string }> = [];
const sentMessages: Array<{ content: string; providerID: string; modelID: string }> = [];
const savedPlans: Array<Record<string, unknown>> = [];

const serverPlans = [
  {
    id: 'anthropic-max-20x',
    providerID: 'anthropic',
    label: 'Personal',
    plan: 'Max 20x',
    coverage: 'subscription',
    status: 'active',
    quotas: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

mock.module('@/lib/routing/plansApi', () => ({
  PLAN_COVERAGE: ['subscription', 'credits', 'metered', 'free', 'trial'],
  PLAN_TIERS: ['cheap', 'standard', 'frontier'],
  PLAN_UNITS: ['requests', 'messages', 'tokens', 'usd', 'percent', 'other'],
  PLAN_STATUSES: ['active', 'expired', 'cancelled', 'unknown'],
  PLAN_PERIODS: ['monthly', 'yearly', 'once'],
  NOTE_KINDS: ['experience', 'expectation', 'plan-change', 'correction', 'other'],
  fetchPlanState: async () => ({ plans: serverPlans, models: {}, pools: {}, notes: [], skippedNotes: 0 }),
  savePlanRecord: async (plan: Record<string, unknown>) => {
    savedPlans.push(plan);
    return { ...serverPlans[0], ...plan };
  },
  saveModelTier: async () => ({ tier: 'standard', updatedAt: '2026-10-14T00:00:00.000Z' }),
  savePoolPurpose: async () => ({ updatedAt: '2026-10-14T00:00:00.000Z' }),
  addPlanNote: async () => ({ id: 'note_1', at: '2026-10-14T00:00:00.000Z', kind: 'other', text: '', source: 'ui' }),
}));

mock.module('@/lib/routing/modelRoutesApi', () => ({
  fetchModelRoutes: async () => ({ routes: {}, schedules: [], available: false }),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      createSession: async (title: string) => {
        commandStarts.push(title);
        return { id: 'ses_test' };
      },
      sendMessage: async (content: string, providerID: string, modelID: string) => {
        sentMessages.push({ content, providerID, modelID });
      },
    }),
  },
}));

mock.module('@/sync/input-store', () => ({
  useInputStore: {
    getState: () => ({
      setPendingInputText: (text: string, mode: string) => pendingTexts.push({ text, mode }),
    }),
  },
}));

const { PlansSection } = await import('./PlansSection');
const { I18nProvider } = await import('@/lib/i18n');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'Event',
  'KeyboardEvent',
  'PointerEvent',
  'localStorage',
  'IS_REACT_ACT_ENVIRONMENT',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values: Record<(typeof DOM_GLOBAL_NAMES)[number], unknown> = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    PointerEvent: happyWindow.PointerEvent,
    localStorage: happyWindow.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
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

let dom: ReturnType<typeof installDom> | null = null;
let root: Root | null = null;

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const renderSection = async () => {
  if (!dom) dom = installDom();
  root = createRoot(dom.container);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <PlansSection />
      </I18nProvider>,
    );
  });
  await flush();
  return dom.container;
};

const buttonNamed = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === name) ?? null;

/** Types into a controlled input the way a user does: set the value, then tell React it changed. */
const typeInto = async (input: HTMLInputElement, value: string) => {
  let prototype: object | null = Object.getPrototypeOf(input);
  let setter: ((this: HTMLInputElement, value: string) => void) | undefined;
  while (prototype && !setter) {
    setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    prototype = Object.getPrototypeOf(prototype);
  }
  // Without a native `input` event support flag, React reads changes on keyup from the focused field.
  await act(async () => {
    input.dispatchEvent(new Event('focusin', { bubbles: true }));
    setter?.call(input, value);
    input.dispatchEvent(new Event('keyup', { bubbles: true }));
  });
};

beforeEach(() => {
  commandStarts.length = 0;
  pendingTexts.length = 0;
  sentMessages.length = 0;
  savedPlans.length = 0;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  dom?.restore();
  dom?.container.remove();
  root = null;
  dom = null;
});

describe('PlansSection', () => {
  test('lists the saved plan and offers the two buttons that start a chat', async () => {
    const container = await renderSection();
    expect(container.textContent).toContain('anthropic · Max 20x');
    expect(buttonNamed(container, 'Review routing')).not.toBeNull();
    expect(buttonNamed(container, 'Update plans')).not.toBeNull();
  });

  test('Review routing opens a new chat with /routing-review ready in its composer', async () => {
    const container = await renderSection();
    const button = buttonNamed(container, 'Review routing');
    await act(async () => button?.click());
    await flush();
    expect(commandStarts).toEqual(['Routing review']);
    expect(pendingTexts).toEqual([{ text: '/routing-review', mode: 'replace' }]);
  });

  test('Update plans opens a new chat with /plan-update ready in its composer', async () => {
    const container = await renderSection();
    const button = buttonNamed(container, 'Update plans');
    await act(async () => button?.click());
    await flush();
    expect(commandStarts).toEqual(['Plan update']);
    expect(pendingTexts).toEqual([{ text: '/plan-update', mode: 'replace' }]);
  });

  test('saving an edited plan sends the new label for that plan only', async () => {
    const container = await renderSection();
    const label = container.querySelector<HTMLInputElement>('input[placeholder="Label"]');
    expect(label?.value).toBe('Personal');
    if (label) await typeInto(label, 'Work');
    expect(label?.value).toBe('Work');
    const save = buttonNamed(container, 'Save');
    await act(async () => save?.click());
    await flush();
    expect(savedPlans).toHaveLength(1);
    expect(savedPlans[0]).toMatchObject({ id: 'anthropic-max-20x', providerID: 'anthropic', label: 'Work' });
  });

  test('switching action send mode to autosend triggers sendMessage immediately', async () => {
    dom = installDom();
    dom.container.ownerDocument.defaultView?.localStorage.setItem('openchamber.routing.plans.actionSendMode', 'autosend');
    const container = await renderSection();
    const button = buttonNamed(container, 'Review routing');
    await act(async () => button?.click());
    await flush();
    expect(commandStarts).toEqual(['Routing review']);
    expect(sentMessages).toEqual([{ content: '/routing-review', providerID: '', modelID: '' }]);
    expect(pendingTexts).toHaveLength(0);
  });
});
