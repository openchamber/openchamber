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
let effectiveDirectory: string | undefined = '/repo';

mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({ contextPanelByDirectory: panelByDirectory, workStatusPanelEnabled: panelEnabled }),
  normalizeContextPanelDirectoryKey: (value: string) => value,
}));

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => effectiveDirectory,
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

type Args = { isMobile: boolean; isVSCode: boolean };

/**
 * Renders the hook with a stand-in row node, attached through the returned
 * callback ref exactly as the real tree does.
 */
const renderVisibility = (args: Args, rowWidth: number) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);
  // `closest` returns null here, so the hook falls back to the row itself —
  // the fallback path is what these cases exercise.
  const rowNode = {
    getBoundingClientRect: () => ({ width: rowWidth }),
    closest: () => null,
  } as unknown as HTMLDivElement;
  const result = { visible: false, fits: false };

  const Probe: React.FC = () => {
    const { rowRef, visible, fits } = useWorkStatusVisibility(args);
    result.visible = visible;
    result.fits = fits;
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
  effectiveDirectory = '/repo';
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
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    teardown();
  });

  test('hides the panel when the row cannot afford both columns', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED - 1,
    );
    expect(result.visible).toBe(false);
    teardown();
  });

  test('prefers the marked chat area over the row it was handed', () => {
    // The row is what the context panel squeezes, over an animation. Measuring
    // it made the panel reappear only once that number caught up, so the chat
    // widened first and narrowed again afterwards.
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const chatArea = { getBoundingClientRect: () => ({ width: REQUIRED }) };
    const rowNode = {
      getBoundingClientRect: () => ({ width: 0 }),
      closest: () => chatArea,
    } as unknown as HTMLDivElement;
    const result = { visible: false };

    const Probe: React.FC = () => {
      const { rowRef, visible } = useWorkStatusVisibility({
        isMobile: false,
        isVSCode: false,
      });
      result.visible = visible;
      React.useLayoutEffect(() => {
        rowRef(rowNode);
        return () => rowRef(null);
      }, [rowRef]);
      return null;
    };

    act(() => { root.render(React.createElement(Probe)); });
    expect(observed).toEqual([chatArea]);
    expect(result.visible).toBe(true);

    act(() => { root.unmount(); });
    dom.restore();
  });

  test('measures a container the panel cannot resize, never the chat column', () => {
    // The measured element must not depend on whether the panel is showing:
    // otherwise hiding the panel widens it and re-shows the panel, forever.
    // In the app this is the chat area (chat + context panel); here `closest`
    // finds nothing, so the hook falls back to the row it was given.
    const { rowNode, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(rowNode);
    teardown();
  });

  test('reacts to a live resize across the threshold', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(true);
    act(() => { notify?.([{ contentRect: { width: REQUIRED - 40 } }]); });
    expect(result.visible).toBe(false);
    act(() => { notify?.([{ contentRect: { width: REQUIRED + 200 } }]); });
    expect(result.visible).toBe(true);
    teardown();
  });

  test('yields to an open context panel while still measuring the row', () => {
    // Measurement continues so the panel can come back in the same commit that
    // reveals it. Stopping cost a frame: closing the context panel widened the
    // chat, and only then did the panel reappear and narrow it again.
    panelByDirectory = {
      '/repo': { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1' },
    };
    const { result, rowNode, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED,
    );
    expect(result.visible).toBe(false);
    expect(observed).toEqual([rowNode]);
    teardown();
  });

  test('yields to the open context panel even when the chat reports on no project', () => {
    // A Chat session carries no repository, so the panel describes no
    // directory. The context panel is still keyed by the directory the app is
    // on, and looking it up under the chat's empty one answered "closed".
    panelByDirectory = {
      '/repo': { isOpen: true, tabs: [{ id: 'tab-1', mode: 'git' }], activeTabId: 'tab-1' },
    };
    const { result, teardown } = renderVisibility({ isMobile: false, isVSCode: false }, REQUIRED);
    expect(result.visible).toBe(false);
    teardown();
  });

  test('ignores an open context panel that has no resolvable tab', () => {
    // ContextPanel renders nothing in that state, so it displaces nothing.
    panelByDirectory = { '/repo': { isOpen: true, tabs: [], activeTabId: null } };
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
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
    const rowNode = {
      getBoundingClientRect: () => ({ width: REQUIRED }),
      closest: () => null,
    } as unknown as HTMLDivElement;
    const result = { visible: false };
    let attach: (value: boolean) => void = () => undefined;

    const Probe: React.FC = () => {
      const [attached, setAttached] = React.useState(false);
      const { rowRef, visible } = useWorkStatusVisibility({
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

  test('stays hidden when the user switched the panel off, but still reports the fit', () => {
    // The header offers the panel as an overlay when layout refuses it, so it
    // needs the two answers apart: whether the user wants it, and whether
    // there is room for it.
    panelEnabled = false;
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED * 2,
    );
    expect(result.visible).toBe(false);
    expect(result.fits).toBe(true);
    teardown();
  });

  test('reports no fit when the row is too narrow, whatever the switch says', () => {
    const { result, teardown } = renderVisibility(
      { isMobile: false, isVSCode: false },
      REQUIRED - 1,
    );
    expect(result.fits).toBe(false);
    expect(result.visible).toBe(false);
    teardown();
  });

  test('stays hidden on mobile and in VS Code regardless of width', () => {
    const mobile = renderVisibility(
      { isMobile: true, isVSCode: false },
      REQUIRED * 2,
    );
    expect(mobile.result.visible).toBe(false);
    mobile.teardown();

    observed = [];
    const vscode = renderVisibility(
      { isMobile: false, isVSCode: true },
      REQUIRED * 2,
    );
    expect(vscode.result.visible).toBe(false);
    vscode.teardown();
  });
});
