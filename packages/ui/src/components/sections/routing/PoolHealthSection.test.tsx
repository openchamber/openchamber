import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import type { PoolHealthState } from '@/lib/routing/poolHealthApi';
import type { PlanState } from '@/lib/routing/plansApi';

let healthState: PoolHealthState = { available: true, statsAvailable: true, pools: {} };
let planState: PlanState = { plans: [], models: {}, pools: {}, notes: [] };
let linkFailure: Error | null = null;
let linkGate: Promise<void> | null = null;
let rotationReads = 0;
const planLinkSaves: Array<{ target: string; planID: string | null }> = [];

mock.module('@/lib/routing/poolHealthApi', () => ({
  fetchPoolHealth: async () => healthState,
  fetchRotation: async () => {
    rotationReads += 1;
    return { settings: { enabled: false, intervalMinutes: 5 }, moves: [] };
  },
  saveRotation: async () => ({ settings: { enabled: false, intervalMinutes: 5 }, moves: [] }),
  savePoolPlanLink: async (target: string, planID: string | null) => {
    planLinkSaves.push({ target, planID });
    if (linkGate) await linkGate;
    if (linkFailure) throw linkFailure;
    return { version: 1, links: planID ? { [target]: planID } : {} };
  },
}));

mock.module('@/lib/routing/plansApi', () => ({
  fetchPlanState: async () => planState,
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

const renderSection = async (onLowerWeight: (poolID: string, targetRef: string) => void = () => undefined) => {
  const dom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { PoolHealthSection } = await import('./PoolHealthSection');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  const render = async (reloadKey: string) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <PoolHealthSection onLowerWeight={onLowerWeight} reloadKey={reloadKey} />
        </I18nProvider>,
      );
    });
    // Flush the microtask queue the data-loading effect's Promise.allSettled runs on.
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

const clickButton = (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  expect(button).toBeTruthy();
  return button!;
};

const fire = (target: Element, type: string) => {
  const init = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
};

// Matches `ModelPoolsSection.test.tsx`'s `pickOption`: the pick only commits once a hover
// highlighted it, so hover runs in its own `act` before the press that follows it.
const pickOption = async (container: HTMLElement, label: string, option: string) => {
  const trigger = [...container.querySelectorAll<HTMLElement>('[role="combobox"]')].find((el) => el.getAttribute('aria-label') === label);
  if (!trigger) throw new Error(`no combobox labelled "${label}"`);
  await act(async () => {
    fire(trigger, 'pointerdown');
    fire(trigger, 'mousedown');
  });
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

describe('PoolHealthSection', () => {
  beforeEach(() => {
    planLinkSaves.length = 0;
    linkFailure = null;
    linkGate = null;
    planState = { plans: [{
      id: 'openai-plus', providerID: 'openai', label: 'OpenAI Plus', coverage: 'subscription', status: 'active',
      quotas: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }], models: {}, pools: {}, notes: [] };
  });

  test('shows active session counts and a blast-radius warning for a shared target', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: {
        pool1: {
          selection: 'ordered',
          targets: [
            { ref: 'openai/a', activeSessions: 3, plan: null, blastRadius: true, suggestion: null },
            { ref: 'anthropic/b', activeSessions: 1, plan: null, blastRadius: false, suggestion: null },
          ],
        },
      },
    };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('Sessions in the last 15 min: 3');
      expect(dom.container.textContent).toContain('resets all of their caches at once');
      expect(dom.container.textContent).toContain('No plan linked');
      expect(dom.container.textContent).not.toContain('__none__');
    } finally {
      await cleanup();
    }
  });

  test('shows a projection and a lower-weight suggestion for a target nearing its plan limit', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: {
        pool1: {
          selection: 'weighted',
          targets: [
            {
              ref: 'openai/a',
              activeSessions: 2,
              blastRadius: true,
              suggestion: 'lower-weight',
              plan: {
                id: 'openai-plus',
                label: 'OpenAI Plus',
                providerID: 'openai',
                siblingRefs: ['openai/a-secondary'],
                projection: { quotaName: 'daily', unit: 'requests', limit: 10, windowHours: 24, projected: 24, source: 'traffic-estimate', ratio: 2.4, status: 'over' },
                unprojectedQuotas: [],
              },
            },
          ],
        },
      },
    };
    const lowered: Array<[string, string]> = [];
    const { dom, cleanup } = await renderSection((poolID, ref) => lowered.push([poolID, ref]));
    try {
      expect(dom.container.textContent).toContain('Over the projected limit');
      expect(dom.container.textContent).toContain('Also drawing on this plan: openai/a-secondary');
      const button = clickButton(dom.container, 'Lower weight');
      await act(async () => button.click());
      expect(lowered).toEqual([['pool1', 'openai/a']]);
    } finally {
      await cleanup();
    }
  });

  test('links a target to a plan', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      await pickOption(dom.container, 'Plan', 'OpenAI Plus');
      expect(planLinkSaves).toEqual([{ target: 'openai/a', planID: 'openai-plus' }]);
    } finally {
      await cleanup();
    }
  });

  test('says when the server cannot read plans or links and keeps the pools on screen', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      planError: 'plans.json is not valid JSON',
      linksError: 'pool-plan-links.json is not valid JSON',
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 2, plan: null, blastRadius: true, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('Plan information could not be read: plans.json is not valid JSON');
      expect(dom.container.textContent).toContain('Plan links could not be read: pool-plan-links.json is not valid JSON');
      expect(dom.container.textContent).toContain('Sessions in the last 15 min: 2');
    } finally {
      await cleanup();
    }
  });

  test('shows a link to a deleted plan and clears it', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, missingPlanID: 'old-plan', blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('Deleted plan: old-plan');
      await pickOption(dom.container, 'Plan', 'No plan linked');
      expect(planLinkSaves).toEqual([{ target: 'openai/a', planID: null }]);
    } finally {
      await cleanup();
    }
  });

  test('reads again when the pools change', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, rerender, cleanup } = await renderSection();
    try {
      healthState = {
        available: true,
        statsAvailable: true,
        pools: { pool1: { selection: 'ordered', targets: [{ ref: 'anthropic/b', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
      };
      await rerender('changed');
      expect(dom.container.textContent).toContain('anthropic/b');
      expect(dom.container.textContent).not.toContain('openai/a');
    } finally {
      await cleanup();
    }
  });

  test('keeps the pools on screen when saving a plan link fails', async () => {
    linkFailure = new Error('disk full');
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      await pickOption(dom.container, 'Plan', 'OpenAI Plus');
      await act(async () => { await Promise.resolve(); });
      expect(dom.container.textContent).toContain('disk full');
      expect(dom.container.textContent).toContain('openai/a');
    } finally {
      await cleanup();
    }
  });

  test('shows a token projection as a full sentence', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: {
        pool1: {
          selection: 'ordered',
          targets: [{
            ref: 'openai/a', activeSessions: 1, blastRadius: false, suggestion: null,
            plan: {
              id: 'openai-plus', label: 'OpenAI Plus', providerID: 'openai', siblingRefs: [],
              projection: { quotaName: 'daily tokens', unit: 'tokens', limit: 2000, windowHours: 24, projected: 2400, source: 'traffic-estimate', ratio: 1.2, status: 'over' },
              unprojectedQuotas: [],
            },
          }],
        },
      },
    };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('At this rate: 2400 of 2000 tokens in a 24h window');
      expect(dom.container.textContent).toContain('Estimate from recent traffic');
    } finally {
      await cleanup();
    }
  });

  test('explains why a usd window has no projection instead of showing nothing', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: {
        pool1: {
          selection: 'ordered',
          targets: [{
            ref: 'openai/a', activeSessions: 1, blastRadius: false, suggestion: null,
            plan: {
              id: 'openai-metered', label: 'OpenAI Metered', providerID: 'openai', siblingRefs: [],
              projection: null,
              unprojectedQuotas: [{ quotaName: 'monthly cost', unit: 'usd', reason: 'needs-pricing' }],
            },
          }],
        },
      },
    };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('No projection for the monthly cost window');
      expect(dom.container.textContent).toContain('cost quotas need pricing');
    } finally {
      await cleanup();
    }
  });

  test("locks a target's plan picker until its save finishes", async () => {
    let release: () => void = () => {};
    linkGate = new Promise<void>((resolve) => { release = resolve; });
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      await pickOption(dom.container, 'Plan', 'OpenAI Plus');
      const trigger = [...dom.container.querySelectorAll<HTMLElement>('[role="combobox"]')].find((el) => el.getAttribute('aria-label') === 'Plan');
      expect(trigger?.hasAttribute('data-disabled') || trigger?.getAttribute('aria-disabled') === 'true' || trigger?.hasAttribute('disabled')).toBe(true);
      await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
      expect(trigger?.hasAttribute('data-disabled') || trigger?.getAttribute('aria-disabled') === 'true' || trigger?.hasAttribute('disabled')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("lists the plans of the target's own provider first", async () => {
    planState = { plans: [
      { id: 'anthropic-max', providerID: 'anthropic', label: 'Anthropic Max', coverage: 'subscription', status: 'active', quotas: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'openai-plus', providerID: 'openai', label: 'OpenAI Plus', coverage: 'subscription', status: 'active', quotas: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ], models: {}, pools: {}, notes: [] };
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      const trigger = [...dom.container.querySelectorAll<HTMLElement>('[role="combobox"]')].find((el) => el.getAttribute('aria-label') === 'Plan')!;
      await act(async () => {
        fire(trigger, 'pointerdown');
        fire(trigger, 'mousedown');
      });
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => el.textContent?.trim());
      expect(options).toEqual(['No plan linked', 'OpenAI Plus', 'Anthropic Max']);
    } finally {
      await cleanup();
    }
  });

  test('Refresh also reads the rotation history again', async () => {
    healthState = {
      available: true,
      statsAvailable: true,
      pools: { pool1: { selection: 'ordered', targets: [{ ref: 'openai/a', activeSessions: 0, plan: null, blastRadius: false, suggestion: null }] } },
    };
    const { dom, cleanup } = await renderSection();
    try {
      const before = rotationReads;
      const button = clickButton(dom.container, 'Refresh');
      await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
      expect(rotationReads).toBe(before + 1);
    } finally {
      await cleanup();
    }
  });

  test('renders nothing when there are no pools', async () => {
    healthState = { available: true, statsAvailable: true, pools: {} };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toBe('');
    } finally {
      await cleanup();
    }
  });
});
