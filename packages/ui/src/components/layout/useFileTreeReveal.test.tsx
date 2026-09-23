import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { FileTreeRevealParams } from './useFileTreeReveal';

type Scenario = {
  root: string | null;
  activeFilePath: string | null;
  enabled: boolean;
  searchActive: boolean;
  searchResultCount: number;
  /** Directory → the row paths currently rendered under it. */
  childrenByDir: Record<string, string[]>;
  expandedPaths: string[];
};

type Harness = {
  scrolls: string[];
  render: (next: Partial<Scenario>) => Promise<void>;
  teardown: () => void;
};

const baseScenario: Scenario = {
  root: '/repo',
  activeFilePath: null,
  enabled: true,
  searchActive: false,
  searchResultCount: 0,
  childrenByDir: {},
  expandedPaths: [],
};

const setupHarness = async (initial: Partial<Scenario> = {}): Promise<Harness> => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const scrolls: string[] = [];
  // Recording on the prototype captures whichever row the reveal picked,
  // instead of the test having to guess it in advance.
  dom.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolls.push(this.getAttribute('data-tree-path') ?? '');
  };

  let scenario: Scenario = { ...baseScenario, ...initial };

  const { createRoot } = await import('react-dom/client');
  const { useFileTreeReveal } = await import('./useFileTreeReveal');

  // The globals above are installed, so these are happy-dom nodes typed as
  // the standard DOM by TypeScript.
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  const listRef = React.createRef<HTMLUListElement>();

  const Harness: React.FC = () => {
    const rowsByDir = Object.fromEntries(
      Object.entries(scenario.childrenByDir).map(([dir, paths]) => [dir, paths.map((path) => ({ path }))]),
    );
    const params: FileTreeRevealParams = {
      root: scenario.root,
      activeFilePath: scenario.activeFilePath,
      enabled: scenario.enabled,
      searchActive: scenario.searchActive,
      searchResultCount: scenario.searchResultCount,
      listRef,
      childrenByDir: rowsByDir,
      expandedPaths: scenario.expandedPaths,
    };
    useFileTreeReveal(params);

    const rowPaths = Object.values(scenario.childrenByDir).flat();
    return (
      <ul ref={listRef}>
        {rowPaths.map((path) => (
          <li key={path}><button type="button" data-tree-path={path} /></li>
        ))}
      </ul>
    );
  };

  const render = async (next: Partial<Scenario>) => {
    scenario = { ...scenario, ...next };
    await act(async () => {
      reactRoot.render(<Harness />);
    });
  };

  await render({});

  return {
    scrolls,
    render,
    teardown: () => {
      act(() => { reactRoot.unmount(); });
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

test('scrolls to a row that is already rendered', async () => {
  // The common case, and the one a retry keyed only on listings/expansion
  // misses entirely: switching to a tab whose folders are already open
  // renders no new row, yet the row can be far off screen.
  const harness = await setupHarness({
    childrenByDir: { '/repo': ['/repo/src'], '/repo/src': ['/repo/src/a.ts', '/repo/src/b.ts'] },
    expandedPaths: ['/repo/src'],
  });
  try {
    await harness.render({ activeFilePath: '/repo/src/b.ts' });

    expect(harness.scrolls).toEqual(['/repo/src/b.ts']);
  } finally {
    harness.teardown();
  }
});

test('waits for the row and scrolls once the directories above it are listed', async () => {
  // Expanding and listing belong to the editor surface and the tree's own
  // expansion effect; the reveal only has to survive until the row exists.
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/src'] } });
  try {
    await harness.render({ activeFilePath: '/repo/src/deep/a.ts' });
    expect(harness.scrolls).toEqual([]);

    await harness.render({
      childrenByDir: { '/repo': ['/repo/src'], '/repo/src': ['/repo/src/deep'] },
      expandedPaths: ['/repo/src'],
    });
    expect(harness.scrolls).toEqual([]);

    await harness.render({
      childrenByDir: {
        '/repo': ['/repo/src'],
        '/repo/src': ['/repo/src/deep'],
        '/repo/src/deep': ['/repo/src/deep/a.ts'],
      },
      expandedPaths: ['/repo/src', '/repo/src/deep'],
    });

    expect(harness.scrolls).toEqual(['/repo/src/deep/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('leaves the tree alone once the user moves it under the same tab', async () => {
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/a.ts', '/repo/b.ts'] } });
  try {
    await harness.render({ activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual(['/repo/a.ts']);

    // A later render (a refresh, git status, another directory listed) must
    // not scroll back to the active file after the user scrolled away.
    await harness.render({ childrenByDir: { '/repo': ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'] } });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('drops a reveal whose row only appears after the editor moved on', async () => {
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/src'] } });
  try {
    await harness.render({ activeFilePath: '/repo/src/slow.ts' });
    expect(harness.scrolls).toEqual([]);

    // The user switches to a non-file tab (a diff, the plan) before the
    // listing lands; the row that appears now belongs to nothing on screen.
    await harness.render({ activeFilePath: null });
    await harness.render({
      childrenByDir: { '/repo': ['/repo/src'], '/repo/src': ['/repo/src/slow.ts'] },
      expandedPaths: ['/repo/src'],
    });

    expect(harness.scrolls).toEqual([]);
  } finally {
    harness.teardown();
  }
});

test('waits while the tree column is hidden and reveals when it is shown', async () => {
  const harness = await setupHarness({ enabled: false, childrenByDir: { '/repo': ['/repo/a.ts'] } });
  try {
    await harness.render({ activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual([]);

    await harness.render({ enabled: true });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('holds the reveal while search replaces the tree, then reveals when the results clear', async () => {
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/a.ts'] } });
  try {
    await harness.render({ searchActive: true, searchResultCount: 3, activeFilePath: '/repo/a.ts' });
    expect(harness.scrolls).toEqual([]);

    await harness.render({ searchActive: false, searchResultCount: 0 });

    expect(harness.scrolls).toEqual(['/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});

test('ignores a file that is not inside the root', async () => {
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/a.ts'] } });
  try {
    await harness.render({ activeFilePath: '/elsewhere/a.ts' });

    expect(harness.scrolls).toEqual([]);
  } finally {
    harness.teardown();
  }
});

test('reveals again when the editor comes back to a file the user scrolled away from', async () => {
  const harness = await setupHarness({ childrenByDir: { '/repo': ['/repo/a.ts', '/repo/b.ts'] } });
  try {
    await harness.render({ activeFilePath: '/repo/a.ts' });
    await harness.render({ activeFilePath: '/repo/b.ts' });
    await harness.render({ activeFilePath: '/repo/a.ts' });

    expect(harness.scrolls).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/a.ts']);
  } finally {
    harness.teardown();
  }
});
