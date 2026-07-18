import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePermissionStore } from '@/stores/permissionStore';

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: FakeClassList;
  textContent?: string;
  [key: string]: unknown;
};

type FakeDocument = FakeNode & {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement: (tag: string) => FakeNode;
  createElementNS: (_ns: string, tag: string) => FakeNode;
  createTextNode: (text: string) => FakeNode;
  getElementById: (_id: string) => FakeNode | null;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
};

type FakeWindow = {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  addEventListener: () => void;
  dispatchEvent: (event: Event) => boolean;
  removeEventListener: () => void;
  matchMedia: () => { matches: boolean; addEventListener(): void; removeEventListener(): void };
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
};

class FakeClassList {
  private readonly classes = new Set<string>();
  add(...classes: string[]) { classes.forEach((value) => this.classes.add(value)); }
  remove(...classes: string[]) { classes.forEach((value) => this.classes.delete(value)); }
}

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style: { setProperty() { /* noop */ }, getPropertyValue() { return ''; } },
    classList: new FakeClassList(),
    appendChild(child: FakeNode) { this.childNodes.push(child); child.parentNode = this; return child; },
    insertBefore(child: FakeNode, before: FakeNode | null) {
      const append = node.appendChild as (child: FakeNode) => FakeNode;
      if (!before) return append(child);
      const index = node.childNodes.indexOf(before);
      if (index < 0) return append(child);
      node.childNodes.splice(index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: FakeNode) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute() { /* noop */ },
    removeAttribute() { /* noop */ },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    focus() { /* noop */ },
    blur() { /* noop */ },
    textContent: '',
  };
  return node;
}

function installDomStub(): { container: FakeNode; restore: () => void } {
  const document = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
    parentNode: null,
    childNodes: [],
    style: {},
    classList: new FakeClassList(),
    appendChild() { return undefined; },
    insertBefore() { return undefined; },
    removeChild() { return undefined; },
    setAttribute() { /* noop */ },
    removeAttribute() { /* noop */ },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    getElementById() { return null; },
    createTextNode(text: string) { return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode; },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_ns: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
  } as unknown as FakeDocument;

  document.defaultView = {
    document,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    addEventListener() { /* noop */ },
    dispatchEvent(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === 'string') {
        saveStateCalls.push(detail);
      }
      return true;
    },
    removeEventListener() { /* noop */ },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
  };
  document.body = makeNode('body', document);
  document.documentElement = makeNode('html', document);

  const globalLike = globalThis as Record<string, unknown>;
  const previous = {
    document: globalLike.document,
    window: globalLike.window,
    navigator: globalLike.navigator,
    IS_REACT_ACT_ENVIRONMENT: globalLike.IS_REACT_ACT_ENVIRONMENT,
  };

  globalLike.document = document as unknown as Document;
  globalLike.window = document.defaultView as unknown as Window;
  globalLike.navigator = document.defaultView.navigator as unknown as Navigator;
  globalLike.IS_REACT_ACT_ENVIRONMENT = true;

  const container = makeNode('div', document);
  (document.body.appendChild as (child: FakeNode) => FakeNode)(container);

  return {
    container,
    restore() {
      globalLike.document = previous.document;
      globalLike.window = previous.window;
      globalLike.navigator = previous.navigator;
      globalLike.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

let saveStateCalls: string[] = [];
let latestCheckboxProps: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void } | null = null;
let latestDialogProps: { open: boolean; onOpenChange?: (open: boolean) => void } | null = null;
let renderedButtons: Array<{ label: string; disabled?: boolean; onClick?: () => void }> = [];
let originalConsoleWarn: typeof console.warn;

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children),
  SettingsCheckboxRow: (props: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) => {
    latestCheckboxProps = props;
    return React.createElement('button', {
      type: 'button',
      onClick: () => {
        if (!props.disabled) props.onChange(!props.checked);
      },
      disabled: props.disabled,
    }, 'permission-toggle');
  },
}));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) => {
    latestDialogProps = { open, onOpenChange };
    return open ? React.createElement('div', null, children) : null;
  },
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement('h1', null, children),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => {
    const label = typeof children === 'string' ? children : String(children);
    renderedButtons.push({ label, disabled, onClick });
    return React.createElement('button', { type: 'button', disabled, onClick }, children);
  },
}));

const { PermissionAutoAcceptSettings } = await import('./PermissionAutoAcceptSettings');
const ORIGINAL_PERMISSION_STORE_STATE = usePermissionStore.getState();

describe('PermissionAutoAcceptSettings', () => {
  let root: Root;
  let restoreDom: (() => void) | null = null;

  const restorePermissionStore = async () => {
    await act(async () => {
      usePermissionStore.setState(ORIGINAL_PERMISSION_STORE_STATE, true);
      await Promise.resolve();
    });
  };

  const updateStore = async (updater: Parameters<typeof usePermissionStore.setState>[0]) => {
    await act(async () => {
      usePermissionStore.setState(updater);
      await Promise.resolve();
    });
  };

  const render = async () => {
    renderedButtons = [];
    await act(async () => {
      root.render(React.createElement(PermissionAutoAcceptSettings));
      await Promise.resolve();
    });
  };

  const clickCheckbox = async () => {
    await act(async () => {
      if (!latestCheckboxProps?.disabled) {
        latestCheckboxProps?.onChange(!latestCheckboxProps.checked);
      }
      await Promise.resolve();
    });
  };

  const clickButton = async (label: string) => {
    await act(async () => {
      const button = renderedButtons.find((entry) => entry.label === label);
      if (!button?.disabled) button?.onClick?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(async () => {
    originalConsoleWarn = console.warn;
    console.warn = () => undefined;
    const stub = installDomStub();
    restoreDom = stub.restore;
    root = createRoot(stub.container as unknown as Element);
    latestCheckboxProps = null;
    latestDialogProps = null;
    renderedButtons = [];
    saveStateCalls = [];
    await restorePermissionStore();
    await updateStore((state) => ({
      ...state,
      defaultEnabled: false,
      autoAccept: {},
      loaded: true,
      saving: false,
      setDefaultAutoAccept: async () => undefined,
    }));
    await render();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    await restorePermissionStore();
    console.warn = originalConsoleWarn;
    restoreDom?.();
  });

  test('opens a confirmation dialog before enabling and does not write yet', async () => {
    await clickCheckbox();

    expect(latestDialogProps?.open).toBe(true);
    expect(saveStateCalls).toEqual([]);
  });

  test('cancel and dismiss leave state unchanged', async () => {
    await clickCheckbox();
    await clickButton('settings.common.actions.cancel');

    expect(latestDialogProps?.open).toBe(false);
    expect(saveStateCalls).toEqual([]);

    await clickCheckbox();
    await act(async () => {
      latestDialogProps?.onOpenChange?.(false);
      await Promise.resolve();
    });

    expect(latestDialogProps?.open).toBe(false);
    expect(saveStateCalls).toEqual([]);
  });

  test('confirm writes once and reports save success', async () => {
    const calls: boolean[] = [];
    await updateStore((state) => ({
      ...state,
      setDefaultAutoAccept: async (enabled) => { calls.push(enabled); },
    }));
    await render();

    await clickCheckbox();
    await clickButton('settings.openchamber.permissionAutoAccept.dialog.confirm');

    expect(calls).toEqual([true]);
    expect(saveStateCalls).toEqual(['saving', 'saved']);
  });

  test('disabling skips confirmation and writes immediately', async () => {
    const calls: boolean[] = [];
    await updateStore((state) => ({
      ...state,
      defaultEnabled: true,
      setDefaultAutoAccept: async (enabled) => { calls.push(enabled); },
    }));
    await render();

    await clickCheckbox();

    expect(latestDialogProps?.open ?? false).toBe(false);
    expect(calls).toEqual([false]);
    expect(saveStateCalls).toEqual(['saving', 'saved']);
  });

  test('blocks duplicate interaction while saving', async () => {
    const calls: boolean[] = [];
    await updateStore((state) => ({
      ...state,
      saving: true,
      setDefaultAutoAccept: async (enabled) => { calls.push(enabled); },
    }));
    await render();

    await clickCheckbox();

    expect(calls).toEqual([]);
    expect(latestDialogProps?.open ?? false).toBe(false);
  });

  test('disables interaction until the authoritative policy has loaded', async () => {
    const calls: boolean[] = [];
    await updateStore((state) => ({
      ...state,
      defaultEnabled: true,
      loaded: false,
      setDefaultAutoAccept: async (enabled) => { calls.push(enabled); },
    }));
    await render();

    expect(latestCheckboxProps?.checked).toBe(true);
    expect(latestCheckboxProps?.disabled).toBe(true);

    await clickCheckbox();

    expect(calls).toEqual([]);
    expect(latestDialogProps?.open ?? false).toBe(false);
  });

  test('closes the confirmation dialog after a runtime switch reset makes the policy unknown', async () => {
    await clickCheckbox();
    expect(latestDialogProps?.open).toBe(true);

    await updateStore((state) => ({
      ...state,
      defaultEnabled: false,
      loaded: false,
    }));
    await render();

    expect(latestDialogProps?.open ?? false).toBe(false);
    expect(latestCheckboxProps?.disabled).toBe(true);
  });

  test('reports save failures', async () => {
    const calls: boolean[] = [];
    await updateStore((state) => ({
      ...state,
      setDefaultAutoAccept: async (enabled) => {
        calls.push(enabled);
        throw new Error('offline');
      },
    }));
    await render();

    await clickCheckbox();
    await clickButton('settings.openchamber.permissionAutoAccept.dialog.confirm');

    expect(calls).toEqual([true]);
    expect(saveStateCalls).toEqual(['saving', 'error']);
  });
});
