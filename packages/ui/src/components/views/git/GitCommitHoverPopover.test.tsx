import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type {
  GitCommitHoverDetailsCache,
  GitCommitHoverDetailsKey,
  GitCommitHoverDetailsSnapshot,
  GitHubCommitDetails,
} from '@/lib/api/types';
import { createGitCommitHoverDetailsCache } from './gitCommitHoverCache';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type PopoverReason = 'triggerHover' | 'triggerFocus' | 'triggerPress' | 'escapeKey' | 'imperativeAction';
type TimerId = number;
type TimerCallback = () => void;
type TriggerPressEvent = { defaultPrevented?: boolean };
type TriggerKeyDownEvent = { key: string };
type TriggerRecord = {
  hash: string;
  pointerEnter: () => void;
  pointerLeave: () => void;
  focus: () => void;
  click: () => void;
  keyDown: (key: string) => void;
  element: ElementStub;
};
type PopupRecord = {
  hash: string;
  pointerEnter: () => void;
  pointerLeave: () => void;
  keyDown: (key: string) => void;
};

const triggerRegistry = new Map<string, TriggerRecord>();
const popupRegistry = new Map<string, PopupRecord>();
const portalEvents: string[] = [];

class FakeTimers {
  #nextId = 1;
  #now = 0;
  #timers = new Map<TimerId, { runAt: number; callback: TimerCallback }>();

  install() {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalDateNow = Date.now;
    const mockSetTimeout = (callback: TimerCallback, delay = 0): TimerId => {
      this.#nextId += 1;
      const id = this.#nextId;
      this.#timers.set(id, {
        runAt: this.#now + delay,
        callback,
      });
      return id;
    };
    const mockClearTimeout = (id: TimerId) => {
      this.#timers.delete(id);
    };
    // SAFETY: This focused harness only schedules function callbacks through the
    // mocked React/Base UI path, so a function-only fake timer contract is exact here.
    globalThis.setTimeout = mockSetTimeout as typeof globalThis.setTimeout;
    // SAFETY: FakeTimers returns numeric ids from the paired mock setTimeout above.
    globalThis.clearTimeout = mockClearTimeout as typeof globalThis.clearTimeout;
    Date.now = () => this.#now;
    return () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalDateNow;
      this.#timers.clear();
    };
  }

  async advance(ms: number) {
    const target = this.#now + ms;
    while (true) {
      let nextId: number | null = null;
      let nextTime = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.runAt < nextTime) {
          nextId = id;
          nextTime = timer.runAt;
        }
      }
      if (nextId === null || nextTime > target) {
        break;
      }
      this.#now = nextTime;
      const timer = this.#timers.get(nextId);
      this.#timers.delete(nextId);
      timer?.callback();
      await Promise.resolve();
    }
    this.#now = target;
    await Promise.resolve();
  }
}

interface ElementStub {
  nodeType: number;
  nodeName: string;
  tagName: string;
  id: string;
  attributes: Record<string, string>;
  namespaceURI: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
  childNodes: NodeStub[];
  style: Record<string, string>;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: NodeStub): NodeStub;
  insertBefore(child: NodeStub, ref: NodeStub | null): NodeStub;
  removeChild(child: NodeStub): NodeStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  scrollTo(): void;
}

interface TextNodeStub {
  nodeType: number;
  nodeValue: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
}

type NodeStub = ElementStub | TextNodeStub;
type CreateRootContainer = ElementStub & Parameters<typeof createRoot>[0];

interface DocumentStub {
  nodeType: number;
  defaultView: typeof globalThis;
  activeElement: ElementStub | null;
  body: ElementStub;
  head: ElementStub;
  documentElement: ElementStub;
  createElement(tag: string): ElementStub;
  createElementNS(_: string, tag: string): ElementStub;
  createTextNode(text: string): TextNodeStub;
  getElementsByTagName(tag: string): ElementStub[];
  addEventListener(): void;
  removeEventListener(): void;
}

class MinimalDocumentStub implements DocumentStub {
  nodeType = 9;
  defaultView = globalThis;
  activeElement: ElementStub | null = null;
  body!: ElementStub;
  head!: ElementStub;
  documentElement!: ElementStub;

  createElement(tag: string) {
    return createElementStub(tag, this);
  }

  createElementNS(_: string, tag: string) {
    return createElementStub(tag, this);
  }

  createTextNode(text: string) {
    return createTextNodeStub(text, this);
  }

  getElementsByTagName(tag: string) {
    return tag === 'head' ? [this.head] : [];
  }

  addEventListener() {}

  removeEventListener() {}
}

const createElementStub = (tag: string, ownerDocument: DocumentStub): ElementStub => ({
  nodeType: 1,
  nodeName: tag.toUpperCase(),
  tagName: tag.toUpperCase(),
  id: '',
  attributes: {},
  namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument,
  parentNode: null,
  childNodes: [],
  style: {},
  addEventListener() {},
  removeEventListener() {},
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
  insertBefore(child, ref) {
    if (ref === null) {
      return this.appendChild(child);
    }
    const index = this.childNodes.indexOf(ref);
    if (index === -1) {
      return this.appendChild(child);
    }
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  },
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    child.parentNode = null;
    return child;
  },
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'id') {
      this.id = value;
    }
  },
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'id') {
      this.id = '';
    }
  },
  getAttribute(name) {
    return this.attributes[name] ?? null;
  },
  scrollTo() {},
});

const createTextNodeStub = (text: string, ownerDocument: DocumentStub): TextNodeStub => ({
  nodeType: 3,
  nodeValue: text,
  ownerDocument,
  parentNode: null,
});

const isElementStub = (node: NodeStub | null): node is ElementStub => node?.nodeType === 1;

const isCreateRootContainer = (node: NodeStub): node is CreateRootContainer => {
  if (!isElementStub(node)) {
    return false;
  }

  const { ownerDocument } = node;

  return ownerDocument.body.ownerDocument === ownerDocument
    && ownerDocument.head.ownerDocument === ownerDocument
    && ownerDocument.documentElement.ownerDocument === ownerDocument;
};

const resolveCreateRootContainer = (node: NodeStub): CreateRootContainer => {
  if (!isCreateRootContainer(node)) {
    throw new Error('Expected an element-backed container from installMinimalDom');
  }

  return node;
};

let activeDocumentStub: DocumentStub | null = null;

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = <T,>(name: string, value: T) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const documentStub = new MinimalDocumentStub();
  const body = createElementStub('body', documentStub);
  const html = createElementStub('html', documentStub);
  const head = createElementStub('head', documentStub);
  documentStub.body = body;
  documentStub.head = head;
  documentStub.documentElement = html;
  activeDocumentStub = documentStub;

  class GlobalElement {}

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'bun', platform: 'test', maxTouchPoints: 0 });
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', GlobalElement);
  setGlobal('HTMLElement', GlobalElement);
  setGlobal('HTMLButtonElement', GlobalElement);
  setGlobal('HTMLIFrameElement', GlobalElement);
  setGlobal('Node', GlobalElement);
  setGlobal('MutationObserver', class {
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
  });
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const restore = () => {
    activeDocumentStub = null;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };

  const container = createElementStub('div', documentStub);
  return { container, documentStub, restore };
};

const findByAttribute = (node: NodeStub | null, attribute: string, value?: string): ElementStub | null => {
  if (!isElementStub(node)) {
    return null;
  }
  const attr = node.attributes[attribute];
  if (attr !== undefined && (value === undefined || attr === value)) {
    return node;
  }
  for (const child of node.childNodes) {
    const match = findByAttribute(child, attribute, value);
    if (match) {
      return match;
    }
  }
  return null;
};

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => React.createElement('button', props, children),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DropdownMenuItem: ({ children }: React.PropsWithChildren) => React.createElement('button', { type: 'button' }, children),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: () => React.createElement('div', { 'data-diff-viewer': true }),
}));

mock.module('@/components/ui/toast', () => ({
  toast: {
    success() {},
    error() {},
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: { timeFormatPreference: 'auto' }) => T) => selector({ timeFormatPreference: 'auto' }),
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({}),
}));

mock.module('@/lib/url', () => ({
  openExternalUrl: mock(async () => true),
}));

mock.module('@base-ui/react/popover', () => {
  type RootContextValue = {
    open: boolean;
    setOpen: (open: boolean, reason: PopoverReason) => void;
    actionsRef?: React.RefObject<{ close: () => void; unmount: () => void } | null>;
    setTriggerHash: (hash: string) => void;
    getTriggerHash: () => string;
    openTimer: { current: ReturnType<typeof setTimeout> | null };
    closeTimer: { current: ReturnType<typeof setTimeout> | null };
  };

  const RootContext = React.createContext<RootContextValue | null>(null);

  const clearTimer = (timerRef: { current: ReturnType<typeof setTimeout> | null }) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  type MockRootProps = React.PropsWithChildren<{
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean, eventDetails: { reason: PopoverReason; preventUnmountOnClose(): void }) => void;
    actionsRef?: React.RefObject<{ close: () => void; unmount: () => void } | null>;
  }>;

  const Root = ({ open: controlledOpen, defaultOpen = false, onOpenChange, actionsRef, children }: MockRootProps) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
    const triggerHashRef = React.useRef('');
    const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const open = controlledOpen ?? uncontrolledOpen;
    const setOpen = React.useCallback((nextOpen: boolean, reason: PopoverReason) => {
      onOpenChange?.(nextOpen, { reason, preventUnmountOnClose() {} });
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
    }, [controlledOpen, onOpenChange]);
    React.useEffect(() => {
      if (!actionsRef) {
        return;
      }
      actionsRef.current = {
        close: () => setOpen(false, 'imperativeAction'),
        unmount: () => setOpen(false, 'imperativeAction'),
      };
      return () => {
        actionsRef.current = null;
      };
    }, [actionsRef, setOpen]);
    return React.createElement(RootContext.Provider, {
      value: {
        open,
        setOpen,
        actionsRef,
        setTriggerHash: (hash: string) => { triggerHashRef.current = hash; },
        getTriggerHash: () => triggerHashRef.current,
        openTimer,
        closeTimer,
      },
    }, children);
  };

  type TriggerRenderElement = React.ReactElement<{
    onClick?: (event: TriggerPressEvent) => void;
    onKeyDown?: (event: TriggerKeyDownEvent) => void;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    onFocus?: () => void;
    'data-row-hash'?: string;
  }>;
  type MockTriggerProps = {
    render: TriggerRenderElement;
    delay?: number;
    closeDelay?: number;
    openOnHover?: boolean;
    payload?: { hash?: string };
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
  };

  const Trigger = ({ render, delay = 300, closeDelay = 0, openOnHover = false, payload, onPointerEnter, onPointerLeave }: MockTriggerProps) => {
    const context = React.useContext(RootContext);
    if (!context) throw new Error('Popover.Trigger outside root');
    const element = render;
    const hash = payload?.hash ?? element.props['data-row-hash'] ?? 'unknown';
    const scheduleOpen = () => {
      clearTimer(context.closeTimer);
      clearTimer(context.openTimer);
      context.openTimer.current = setTimeout(() => context.setOpen(true, 'triggerHover'), delay);
    };
    const scheduleClose = () => {
      clearTimer(context.openTimer);
      clearTimer(context.closeTimer);
      context.closeTimer.current = setTimeout(() => context.setOpen(false, 'triggerHover'), closeDelay);
    };
    const clone = React.cloneElement(element, {
      onPointerEnter: () => {
        onPointerEnter?.();
        if (openOnHover) scheduleOpen();
      },
      onPointerLeave: () => {
        onPointerLeave?.();
        if (openOnHover) scheduleClose();
      },
      onFocus: () => {
        if (activeDocumentStub) {
          activeDocumentStub.activeElement = triggerRegistry.get(hash)?.element ?? null;
        }
        context.setOpen(true, 'triggerFocus');
      },
      onClick: (event: TriggerPressEvent) => {
        context.setOpen(!context.open, 'triggerPress');
        element.props.onClick?.(event);
      },
      onKeyDown: (event: TriggerKeyDownEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          context.setOpen(!context.open, 'triggerPress');
        }
        element.props.onKeyDown?.(event);
      },
    });
    React.useEffect(() => {
      context.setTriggerHash(hash);
      if (!activeDocumentStub) {
        throw new Error('installMinimalDom must run before Popover.Trigger mounts');
      }
      const elementRef = activeDocumentStub.createElement('button');
      elementRef.setAttribute('id', hash);
      triggerRegistry.set(hash, {
        hash,
        pointerEnter: () => clone.props.onPointerEnter?.(),
        pointerLeave: () => clone.props.onPointerLeave?.(),
        focus: () => clone.props.onFocus?.(),
        click: () => clone.props.onClick?.({}),
        keyDown: (key: string) => clone.props.onKeyDown?.({ key }),
        element: elementRef,
      });
      return () => {
        triggerRegistry.delete(hash);
      };
    }, [clone.props, context, hash]);
    return clone;
  };

  const Portal = ({ children }: React.PropsWithChildren) => {
    const context = React.useContext(RootContext);
    const triggerHash = context?.getTriggerHash();
    React.useEffect(() => {
      if (context?.open) {
        portalEvents.push(triggerHash ?? '');
      }
    }, [context?.open, triggerHash]);
    if (!context?.open) {
      return null;
    }
    return React.createElement(React.Fragment, null, children);
  };

  const Positioner = ({ children }: React.PropsWithChildren) => React.createElement('div', { 'data-positioner': 'true' }, children);

  type MockPopupProps = React.PropsWithChildren<{
    initialFocus?: boolean;
    ['data-git-commit-hover']?: string;
    className?: string;
  }>;

  const Popup = ({ children, ...props }: MockPopupProps) => {
    const context = React.useContext(RootContext);
    if (!context) {
      throw new Error('Popover.Popup outside root');
    }
    const hash = props['data-git-commit-hover'];
    const cancelClose = React.useCallback(() => clearTimer(context.closeTimer), [context.closeTimer]);
    const scheduleClose = React.useCallback(() => {
      clearTimer(context.closeTimer);
      context.closeTimer.current = setTimeout(() => context.setOpen(false, 'triggerHover'), 150);
    }, [context]);
    React.useEffect(() => {
      if (!context?.open || !hash) {
        return () => {};
      }
      popupRegistry.set(hash, {
        hash,
        pointerEnter: cancelClose,
        pointerLeave: scheduleClose,
        keyDown: (key: string) => {
          if (key === 'Escape') {
            context.setOpen(false, 'escapeKey');
          }
        },
      });
      return () => {
        popupRegistry.delete(hash);
      };
    }, [cancelClose, context, hash, scheduleClose]);
    if (!context?.open) {
      return null;
    }
    const domProps = { ...props };
    delete domProps.initialFocus;
    return React.createElement('div', {
      ...domProps,
      onPointerEnter: cancelClose,
      onPointerLeave: scheduleClose,
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Escape') {
          context.setOpen(false, 'escapeKey');
        }
      },
    }, children);
  };

  return { Popover: { Root, Trigger, Portal, Positioner, Popup } };
});

const { GitCommitHoverPopover } = await import('./GitCommitHoverPopover');
const { HistoryCommitRow } = await import('./HistoryCommitRow');

const createDetailsCache = (details?: GitHubCommitDetails) => {
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, GitCommitHoverDetailsSnapshot>();
  const preloadCalls: GitCommitHoverDetailsKey[] = [];
  const keyOf = (key: GitCommitHoverDetailsKey) => JSON.stringify([key.directory, key.remoteName, key.hash]);

  const cache: GitCommitHoverDetailsCache = {
    preload(key) {
      preloadCalls.push(key);
      const cacheKey = keyOf(key);
      const nextSnapshot = details ? { status: 'ready', details } as const : { status: 'unavailable' } as const;
      snapshots.set(cacheKey, nextSnapshot);
      listeners.get(cacheKey)?.forEach((listener) => listener());
      return Promise.resolve();
    },
    getSnapshot(key) {
      return snapshots.get(keyOf(key)) ?? { status: 'idle' };
    },
    subscribe(key, listener) {
      const cacheKey = keyOf(key);
      const entry = listeners.get(cacheKey) ?? new Set<() => void>();
      entry.add(listener);
      listeners.set(cacheKey, entry);
      return () => {
        entry.delete(listener);
      };
    },
    dispose() {},
  };

  return { cache, preloadCalls };
};

const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof GitCommitHoverPopover>> = {}): React.ComponentProps<typeof GitCommitHoverPopover> => ({
  model: {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    subject: 'Commit subject',
    body: 'Commit body',
    authorName: 'Taylor Developer',
    authorEmail: 'taylor@example.com',
    timestamp: '2024-01-02T03:04:00.000Z',
    relativeTime: '2 days ago',
    statistics: { files: 3, insertions: 12, deletions: 4 },
  },
  directory: '/repo',
  remoteName: 'origin',
  remoteUrl: 'https://github.com/acme/repo.git',
  detailsCache: createDetailsCache().cache,
  coordinator: GitCommitHoverPopover.createCoordinator(),
  onCopyHash: () => {},
  absoluteTimestamp: 'Jan 2, 2024, 03:04',
  rowButton: React.createElement('button', { type: 'button', 'data-row-hash': 'abcdef1234567890' }, 'row'),
  openGitHubLabel: 'Open on GitHub',
  copyShaLabel: 'Copy SHA',
  changedFilesLabel: '3 files changed',
  ...overrides,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createTestRoot = (container: NodeStub): Root => {
  return createRoot(resolveCreateRootContainer(container));
};

const renderPopover = async (props: Partial<React.ComponentProps<typeof GitCommitHoverPopover>> = {}) => {
  const dom = installMinimalDom();
  const root = createTestRoot(dom.container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(GitCommitHoverPopover, createDefaultProps(props))));
    await flush();
  });
  return {
    container: dom.container,
    documentStub: dom.documentStub,
    restore: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

const renderTree = async (element: React.ReactElement) => {
  const dom = installMinimalDom();
  const root = createTestRoot(dom.container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, element));
    await flush();
  });
  return {
    container: dom.container,
    documentStub: dom.documentStub,
    restore: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

describe('GitCommitHoverPopover', () => {
  let restoreTimers: (() => void) | null = null;
  let fakeTimers: FakeTimers;

  beforeEach(() => {
    triggerRegistry.clear();
    popupRegistry.clear();
    portalEvents.length = 0;
    fakeTimers = new FakeTimers();
    restoreTimers = fakeTimers.install();
  });

  afterEach(() => {
    restoreTimers?.();
    restoreTimers = null;
  });

  test('accepts the minimal DOM container through a typed createRoot boundary', async () => {
    const dom = installMinimalDom();

    await act(async () => {
      const container = resolveCreateRootContainer(dom.container);
      const root = createRoot(container);
      root.unmount();
      await flush();
    });

    dom.restore();
  });

  test('mounts dormant, preloads on hover after 75ms, opens at 300ms, and keeps local content visible before enrichment', async () => {
    const { cache, preloadCalls } = createDetailsCache();
    const rendered = await renderPopover({ detailsCache: cache });

    expect(findByAttribute(rendered.container, 'data-git-commit-hover')).toBeNull();
    expect(preloadCalls).toHaveLength(0);
    expect(portalEvents).toHaveLength(0);

    triggerRegistry.get('abcdef1234567890')?.pointerEnter();
    await act(async () => {
      await fakeTimers.advance(74);
      await flush();
    });
    expect(preloadCalls).toHaveLength(0);

    await act(async () => {
      await fakeTimers.advance(1);
      await flush();
    });
    expect(preloadCalls).toHaveLength(1);

    await act(async () => {
      await fakeTimers.advance(224);
      await flush();
    });
    expect(findByAttribute(rendered.container, 'data-git-commit-hover')).toBeNull();

    await act(async () => {
      await fakeTimers.advance(1);
      await flush();
    });
    const popup = findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890');
    expect(popup).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-subject', 'abcdef1234567890')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-author', 'abcdef1234567890')).not.toBeNull();

    await rendered.restore();
  });

  test('opens on focus without moving focus into the popup and closes on Escape', async () => {
    const rendered = await renderPopover();

    await act(async () => {
      triggerRegistry.get('abcdef1234567890')?.focus();
      await flush();
    });

    expect(rendered.documentStub.activeElement?.id ?? null).toBe(triggerRegistry.get('abcdef1234567890')?.element.id ?? null);
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890')).not.toBeNull();

    await act(async () => {
      popupRegistry.get('abcdef1234567890')?.keyDown('Escape');
      await flush();
    });

    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890')).toBeNull();

    await rendered.restore();
  });

  test('ignores trigger press state changes while preserving row click and key activation', async () => {
    let toggleCount = 0;
    const rendered = await renderPopover({
      rowButton: React.createElement('button', {
        type: 'button',
        'data-row-hash': 'abcdef1234567890',
        onClick: () => { toggleCount += 1; },
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter' || event.key === ' ') {
            toggleCount += 1;
          }
        },
      }, 'row'),
    });

    await act(async () => {
      triggerRegistry.get('abcdef1234567890')?.click();
      triggerRegistry.get('abcdef1234567890')?.keyDown('Enter');
      triggerRegistry.get('abcdef1234567890')?.keyDown(' ');
      await flush();
    });

    expect(toggleCount).toBe(3);
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890')).toBeNull();

    await rendered.restore();
  });

  test('opens the real commit row popover with repository-scoped enrichment', async () => {
    const loadedKeys: GitCommitHoverDetailsKey[] = [];
    const cache = createGitCommitHoverDetailsCache({
      load: async (key) => {
        loadedKeys.push(key);
        return { connected: false };
      },
      preloadImage: async () => false,
    });
    const hash = '1234567890abcdef1234567890abcdef12345678';
    const rendered = await renderTree(React.createElement('ul', null,
      React.createElement(HistoryCommitRow, {
        entry: {
          id: hash,
          parentIds: [],
          subject: 'Graph subject',
          message: 'Graph subject\n\nGraph body',
          author: 'Taylor Developer',
          authorEmail: 'taylor@example.com',
          timestamp: '2024-01-02T03:04:00.000Z',
          statistics: { files: 2, insertions: 5, deletions: 1 },
          references: [],
        },
        mode: 'graph',
        compactGraph: true,
        viewModel: {
          historyItem: {
            id: hash,
            parentIds: [],
            subject: 'Graph subject',
            message: 'Graph subject\n\nGraph body',
            author: 'Taylor Developer',
            authorEmail: 'taylor@example.com',
            timestamp: '2024-01-02T03:04:00.000Z',
            statistics: { files: 2, insertions: 5, deletions: 1 },
            references: [],
          },
          inputSwimlanes: [],
          outputSwimlanes: [],
          kind: 'node',
        },
        totalColumns: 1,
        isExpanded: false,
        onToggle: () => {},
        files: [],
        isLoadingFiles: false,
        onCopyHash: () => {},
        directory: '/wired-repo',
        hoverCoordinator: GitCommitHoverPopover.createCoordinator(),
        hoverRemoteName: 'upstream',
        hoverRemoteUrl: 'https://github.com/acme/repo.git',
        hoverDetailsCache: cache,
      }),
    ));

    triggerRegistry.get(hash)?.pointerEnter();
    await act(async () => {
      await fakeTimers.advance(300);
      await flush();
    });

    expect(loadedKeys).toEqual([{
      directory: '/wired-repo',
      remoteName: 'upstream',
      hash,
    }]);
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', hash)).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-subject', hash)).not.toBeNull();

    await rendered.restore();
  });

  test('closes the first row when a second row claims the coordinator', async () => {
    const coordinator = GitCommitHoverPopover.createCoordinator();
    const rendered = await renderTree(
      React.createElement(React.Fragment, null,
        React.createElement(GitCommitHoverPopover, createDefaultProps({ coordinator })),
        React.createElement(GitCommitHoverPopover, createDefaultProps({
          coordinator,
          model: {
            hash: 'fedcba0987654321',
            shortHash: 'fedcba0',
            subject: 'Second subject',
            body: 'Second body',
            authorName: 'Morgan Developer',
            authorEmail: 'morgan@example.com',
            timestamp: '2024-01-03T03:04:00.000Z',
            relativeTime: '1 day ago',
            statistics: { files: 1, insertions: 1, deletions: 1 },
          },
          rowButton: React.createElement('button', { type: 'button', 'data-row-hash': 'fedcba0987654321' }, 'row 2'),
          changedFilesLabel: '1 file changed',
        })),
      ),
    );

    await act(async () => {
      triggerRegistry.get('abcdef1234567890')?.focus();
      await flush();
    });
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890')).not.toBeNull();

    await act(async () => {
      triggerRegistry.get('fedcba0987654321')?.focus();
      await flush();
    });

    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'abcdef1234567890')).toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'fedcba0987654321')).not.toBeNull();

    await rendered.restore();
  });

  test('keeps 1000 dormant rows free of preload work and portals until one row opens', async () => {
    let loadCount = 0;
    const renderCounts = new Map<string, number>();
    const coordinator = GitCommitHoverPopover.createCoordinator();
    const cache = createGitCommitHoverDetailsCache({
      load: async () => {
        loadCount += 1;
        return { connected: false };
      },
      preloadImage: async () => false,
    });

    const rows = Array.from({ length: 1000 }, (_, index) => {
      const hash = `hash-${index}`;
      const Row = () => {
        renderCounts.set(hash, (renderCounts.get(hash) ?? 0) + 1);
        return React.createElement(GitCommitHoverPopover, createDefaultProps({
          coordinator,
          detailsCache: cache,
          model: {
            hash,
            shortHash: hash.slice(0, 7),
            subject: `Subject ${index}`,
            body: '',
            authorName: `Author ${index}`,
            authorEmail: `author${index}@example.com`,
            timestamp: '2024-01-02T03:04:00.000Z',
            relativeTime: '2 days ago',
            statistics: { files: 1, insertions: 1, deletions: 1 },
          },
          rowButton: React.createElement('button', { type: 'button', 'data-row-hash': hash }, hash),
          changedFilesLabel: '1 file changed',
        }));
      };
      return React.createElement(Row, { key: hash });
    });

    const rendered = await renderTree(React.createElement(React.Fragment, null, ...rows));

    expect(loadCount).toBe(0);
    expect(portalEvents).toHaveLength(0);
    expect(triggerRegistry.size).toBe(1000);

    await act(async () => {
      triggerRegistry.get('hash-500')?.pointerEnter();
      await fakeTimers.advance(75);
      await flush();
    });
    await act(async () => {
      await fakeTimers.advance(225);
      await flush();
    });

    expect(loadCount).toBe(1);
    expect(portalEvents).toHaveLength(1);
    expect(findByAttribute(rendered.container, 'data-git-commit-hover', 'hash-500')).not.toBeNull();
    expect(renderCounts.get('hash-0')).toBe(1);
    expect(renderCounts.get('hash-999')).toBe(1);

    await rendered.restore();
  });

  test('renders structured 5-row layout with author time, subject, diff stats, ref pills, and action bar', async () => {
    const rendered = await renderPopover({
      model: {
        hash: 'fcf24621234567890abcdef1234567890abcdef1',
        shortHash: 'fcf2462',
        subject: 'fix: select canonical next work order step',
        body: '',
        authorName: 'mattv8',
        authorEmail: 'mattv8@example.com',
        timestamp: '2026-08-21T08:26:00.000Z',
        relativeTime: '5 hours ago',
        statistics: { files: 2, insertions: 134, deletions: 7 },
      },
      absoluteTimestamp: 'August 21, 2026 at 8:26 AM',
      changedFilesLabel: '2 files changed',
      references: [
        { id: 'ref-1', name: 'fix/no-valid-next-step', kind: 'local', revision: 'fcf2462', category: 'branches' },
        { id: 'ref-2', name: 'origin/fix/no-valid-next-step', kind: 'remote', revision: 'fcf2462', category: 'remote-branches' },
      ],
    });

    await act(async () => {
      triggerRegistry.get('fcf24621234567890abcdef1234567890abcdef1')?.focus();
      await flush();
    });

    const popup = findByAttribute(rendered.container, 'data-git-commit-hover', 'fcf24621234567890abcdef1234567890abcdef1');
    expect(popup).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-subject', 'fcf24621234567890abcdef1234567890abcdef1')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-author', 'fcf24621234567890abcdef1234567890abcdef1')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-ref', 'ref-1')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-hover-ref', 'ref-2')).not.toBeNull();

    await rendered.restore();
  });
});
