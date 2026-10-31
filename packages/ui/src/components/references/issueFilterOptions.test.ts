import { beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { DEFAULT_ISSUE_FILTER, type IssueFilter } from './referencePickerItems';

import { createChoiceOptions, useChoiceOptions, type ChoiceOptionsState } from './issueFilterOptions';

type Choice = { name: string };

// A fetch that fails the first `failures` calls then succeeds.
const flaky = (failures: number, value: Choice[]) => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failures) throw new Error('network down');
    return value;
  };
};

// A fetch that succeeds the first `successes` calls then fails.
const succeedsThenFails = (successes: number, value: Choice[]) => {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls > successes) throw new Error('network down');
    return value;
  };
};

const settle = async <T,>(fn: () => Promise<T>): Promise<T> => {
  // Let the async ensure() chain run to completion.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return fn();
};

describe('choice options (labels/milestones dropdown data)', () => {
  test('the default issue filter is open/any with no label or milestone', () => {
    const filter: IssueFilter = DEFAULT_ISSUE_FILTER;
    expect(filter).toEqual({ state: 'open', people: 'any', labelNames: [], milestoneNames: [] });
  });

  test('loads the options and reports ready with no stale hint', async () => {
    const options = createChoiceOptions<{ name: string }>(async () => [{ name: 'bug' }]);
    await settle(() => options.ensure());
    const state = options.read();
    expect(state).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
  });

  test('keeps the last good list with a stale hint when a refresh fails', async () => {
    const options = createChoiceOptions<{ name: string }>(succeedsThenFails(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
    // Force a refresh; the fetch fails this time.
    await settle(() => options.ensure({ force: true }));
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: true, error: null });
  });

  test('disables the dropdown with an error note on a first failure, never an empty list', async () => {
    const options = createChoiceOptions<{ name: string }>(flaky(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    const state = options.read();
    expect(state.status).toBe('error');
    expect(state.error).toBe('network down');
    expect(state.items).toEqual([]);
  });

  test('recovers to ready when a later read succeeds', async () => {
    const options = createChoiceOptions<{ name: string }>(flaky(1, [{ name: 'bug' }]));
    await settle(() => options.ensure());
    expect(options.read().status).toBe('error');
    await settle(() => options.ensure({ force: true }));
    expect(options.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
  });
});

describe('useChoiceOptions', () => {
  let createRoot: typeof import('react-dom/client').createRoot;

  beforeAll(async () => {
    const dom = new Window({ url: 'http://localhost' });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    ({ createRoot } = await import('react-dom/client'));
  });

  const render = async (fetch: () => Promise<Choice[]>, key: string | null) => {
    let latest: ChoiceOptionsState<Choice> | undefined;
    const Probe = () => { latest = useChoiceOptions(fetch, key); return null; };
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Probe)); });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      read: (): ChoiceOptionsState<Choice> => {
        if (latest === undefined) throw new Error('not rendered');
        return latest;
      },
      unmount: async () => { await act(async () => { root.unmount(); }); },
    };
  };

  test('a first failure is an error state, never an empty ready list', async () => {
    const view = await render(async () => { throw new Error('network down'); }, 'labels');
    expect(view.read()).toEqual({ status: 'error', items: [], stale: false, error: 'network down' });
    await view.unmount();
  });

  test('a successful read reports ready with the host items', async () => {
    const view = await render(async () => [{ name: 'bug' }], 'labels');
    expect(view.read()).toEqual({ status: 'ready', items: [{ name: 'bug' }], stale: false, error: null });
    await view.unmount();
  });

  test('a null key stays loading and fetches nothing', async () => {
    let calls = 0;
    const view = await render(async () => { calls += 1; return [{ name: 'bug' }]; }, null);
    expect(view.read()).toEqual({ status: 'loading', items: [], stale: false, error: null });
    expect(calls).toBe(0);
    await view.unmount();
  });
});
