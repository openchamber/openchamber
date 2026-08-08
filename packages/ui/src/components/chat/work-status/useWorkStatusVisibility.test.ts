import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type PanelState = {
  isOpen: boolean;
  tabs: { id: string; mode: string }[];
  activeTabId: string | null;
};

let panelByDirectory: Record<string, PanelState> = {};
let panelEnabled = true;

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({ contextPanelByDirectory: panelByDirectory, workStatusPanelEnabled: panelEnabled }),
}));

mock.module('@/lib/pathNormalization', () => ({
  normalizePath: (value?: string | null) => value ?? null,
}));

const { useWorkStatusVisibility, WORK_STATUS_REQUIRED_ROW_WIDTH: REQUIRED } = await import(
  './useWorkStatusVisibility'
);

/** Elements the stubbed ResizeObserver was asked to observe, in order. */
let observed: unknown[] = [];
let notify: ((entries: { contentRect: { width: number } }[]) => void) | null = null;

class StubResizeObserver {
  constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
    notify = callback;
  }

  observe(element: unknown) {
    observed.push(element);
  }

  disconnect() {
    notify = null;
  }
}

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('ResizeObserver', StubResizeObserver);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

type Args = { directory: string | null; isMobile: boolean; isVSCode: boolean };

/**
 * Renders the hook with a stand-in row node, attached through the returned
 * callback ref exactly as the real tree does.
 */
const renderVisibility = (args: Args, rowWidth: number) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);
  const rowNode = { getBoundingClientRect: () => ({ width: rowWidth }) } as unknown as HTMLDivElement;
  const result = { visible: false };

  const Probe: React.FC = () => {
    const { rowRef, visible } = useWorkStatusVisibility(args);
    result.visible = visible;
    React.useLayoutEffect(() => {
      rowRef(rowNode);
      return () => rowRef(null);
    }, [rowRef]);
    return null;
  };

  act(() => { root.render(React.createElement(Probe)); });
  return {
    result,
    rowNode,
    teardown: () => {
      act(() => { root.unmount(); });
      dom.restore();
    },
  };
};

beforeEach(() => {
  panelByDirectory = {};
  panelEnabled = true;
  observed = [];
  notify = null;
});

afterEach(() => {
  observed = [];
  notify = null;
});

describe('useWorkStatusVisibility', () => {
  test('shows the panel when the row can afford both columns', () => {
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    teardown();
  });

  test('hides the panel when the row cannot afford both columns', () => {
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED - 1,
    );
    expect(result.visible).toBe(false);
    teardown();
  });

  test('measures the row element itself, never the chat column', () => {
    // The row holds both columns, so its width does not depend on whether the
    // panel is showing. Measuring anything narrower would let hiding the panel
    // widen the measured element and re-show it, oscillating forever.
    const { rowNode, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(rowNode);
    teardown();
  });

  test('reacts to a live resize across the threshold', () => {
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    act(() => { notify?.([{ contentRect: { width: REQUIRED - 40 } }]); });
    expect(result.visible).toBe(false);
    act(() => { notify?.([{ contentRect: { width: REQUIRED + 200 } }]); });
    expect(result.visible).toBe(true);
    teardown();
  });

  test('yields to an open context panel and stops measuring', () => {
    panelByDirectory = {
      '/repo': { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1' },
    };
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(false);
    expect(observed).toHaveLength(0);
    teardown();
  });

  test('ignores an open context panel that has no resolvable tab', () => {
    // ContextPanel renders nothing in that state, so it displaces nothing.
    panelByDirectory = { '/repo': { isOpen: true, tabs: [], activeTabId: null } };
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    teardown();
  });

  test('measures a row that attaches after the first render', () => {
    // Regression: with an object ref the measuring effect read `.current`
    // once, found nothing when the row mounted late, and only recovered when
    // some unrelated dependency changed — in practice, opening and closing the
    // context panel. The panel must appear as soon as the row exists.
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const rowNode = { getBoundingClientRect: () => ({ width: REQUIRED }) } as unknown as HTMLDivElement;
    const result = { visible: false };
    let attach: (value: boolean) => void = () => undefined;

    const Probe: React.FC = () => {
      const [attached, setAttached] = React.useState(false);
      const { rowRef, visible } = useWorkStatusVisibility({
        directory: '/repo',
        isMobile: false,
        isVSCode: false,
      });
      result.visible = visible;
      attach = setAttached;
      React.useLayoutEffect(() => {
        if (attached) rowRef(rowNode);
      }, [attached, rowRef]);
      return null;
    };

    act(() => { root.render(React.createElement(Probe)); });
    expect(result.visible).toBe(false);

    act(() => { attach(true); });
    expect(result.visible).toBe(true);

    act(() => { root.unmount(); });
    dom.restore();
  });

  test('stays hidden and stops measuring when the user switched the panel off', () => {
    panelEnabled = false;
    const { result, teardown } = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: false },
      REQUIRED * 2,
    );
    expect(result.visible).toBe(false);
    expect(observed).toHaveLength(0);
    teardown();
  });

  test('stays hidden on mobile and in VS Code regardless of width', () => {
    const mobile = renderVisibility(
      { directory: '/repo', isMobile: true, isVSCode: false },
      REQUIRED * 2,
    );
    expect(mobile.result.visible).toBe(false);
    mobile.teardown();

    observed = [];
    const vscode = renderVisibility(
      { directory: '/repo', isMobile: false, isVSCode: true },
      REQUIRED * 2,
    );
    expect(vscode.result.visible).toBe(false);
    vscode.teardown();
  });
});
