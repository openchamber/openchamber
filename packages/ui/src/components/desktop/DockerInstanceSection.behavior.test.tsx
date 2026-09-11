import { afterEach, describe, expect, mock, test } from 'bun:test';

declare global {
  // eslint-disable-next-line no-var
  var __ocWindowListeners: Map<string, Set<() => void>> | undefined;
}

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
// Mock JSX tree contracts produced by the local jsx() shim below: every
// element is a `{ type, props }` pair and every child is one of these nodes.
type MockElement = { type: unknown; props: JSXProps };
type MockJsxNode = MockElement | string | number | MockJsxNode[] | null | undefined;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void | (() => void)> = [];

afterEach(() => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeFetchResponses = [];
  runtimeFetchCalls = [];
  desktopShell = false;
  identityOverrideCalls.length = 0;
});

const resetGlobals = () => {
  const windowListeners = new Map<string, Set<() => void>>();
  globalThis.__ocWindowListeners = windowListeners;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval: () => 0,
      clearInterval: () => undefined,
      addEventListener: (type: string, listener: () => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)?.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        windowListeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: { type: string }) => {
        windowListeners.get(event.type)?.forEach((listener) => listener());
        return true;
      },
      CustomEvent: class {
        readonly type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    },
  });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): MockJsxNode => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;
  try {
    // SAFETY: the component returns our mocked JSX tree, whose contract is MockJsxNode.
    return component(props) as MockJsxNode;
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

const runEffects = () => {
  while (pendingEffects.length) {
    const effect = pendingEffects.shift();
    effect?.();
  }
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function useCallback<T>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  if (!shallowEqualDeps(record.deps[index], deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: () => void | (() => void), deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  if (!shallowEqualDeps(record.deps[index], deps)) {
    record.deps[index] = deps;
    pendingEffects.push(effect);
  }
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
  }
  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function' ? (next as (prev: T) => T)(record.values[index] as T) : next;
  };
  return [record.values[index] as T, setState] as const;
}

const jsx = (type: unknown, props: JSXProps): MockJsxNode => {
  if (typeof type === 'function') {
    // SAFETY: element types reaching our shim are exactly the mock components
    // imported by the tested file, whose call signatures match ComponentFn.
    return renderComponent(type as ComponentFn, props);
  }
  return { type, props };
};

const ReactMock = { useCallback, useEffect, useState };

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

const jsxRuntime = { Fragment: Symbol('Fragment'), jsx, jsxs: jsx, jsxDEV: jsx };
mock.module('react/jsx-runtime', () => jsxRuntime);
mock.module('react/jsx-dev-runtime', () => jsxRuntime);

mock.module('@/components/ui/button', () => ({
  Button: (props: JSXProps) => ({ type: 'Button', props }),
}));

mock.module('@/components/ui/dialog', () => ({
  Dialog: (props: JSXProps) => ({ type: 'Dialog', props }),
  DialogContent: (props: JSXProps) => ({ type: 'DialogContent', props }),
  DialogHeader: (props: JSXProps) => ({ type: 'DialogHeader', props }),
  DialogTitle: (props: JSXProps) => ({ type: 'DialogTitle', props }),
  DialogDescription: (props: JSXProps) => ({ type: 'DialogDescription', props }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

const toastCalls: Array<{ kind: string; message: string }> = [];
mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => toastCalls.push({ kind: 'success', message }),
    error: (message: string) => toastCalls.push({ kind: 'error', message }),
  },
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

let desktopShell = false;
mock.module('@/lib/desktop', () => ({
  isDesktopShell: mock(() => desktopShell),
}));

const identityOverrideCalls: Array<string | null> = [];
mock.module('@/lib/runtime-switch', () => ({
  setRuntimeIdentityOverride: (key: string | null) => {
    identityOverrideCalls.push(key);
  },
}));

let runtimeFetchResponses: Array<{ ok: boolean; payload: unknown }> = [];
let runtimeFetchCalls: string[] = [];
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (input: string | URL | Request) => {
    runtimeFetchCalls.push(String(input));
    const next = runtimeFetchResponses.shift();
    if (!next) throw new Error('offline');
    return {
      ok: next.ok,
      json: async () => next.payload,
    };
  }),
}));

mock.module('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

mock.module('@/components/desktop/DockerInstanceCreateDialog', () => ({
  DOCKER_INSTANCE_DEFAULT_IMAGE: 'opencode-instance:local',
  DockerInstanceCreateDialog: () => null,
}));

let registerDockerSection: ComponentFn | null = null;
let registerWebEntry: ComponentFn | null = null;

const requireSection = (): ComponentFn => {
  if (!registerDockerSection) throw new Error('DockerInstanceSection was not registered');
  return registerDockerSection;
};

const requireWebEntry = (): ComponentFn => {
  if (!registerWebEntry) throw new Error('DockerInstancesWebEntry was not registered');
  return registerWebEntry;
};

// Collect plain strings from the simulated JSX tree.
type MockProps = JSXProps & { 'aria-label'?: string };

const collectStrings = (node: MockJsxNode, out: string[] = []): string[] => {
  if (!node || typeof node !== 'object') {
    // Leaf value from the shim: plain string or number text.
    if (node !== null && node !== undefined && !Array.isArray(node)) out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectStrings(child, out));
    return out;
  }
  if (node) {
    const props = node.props;
    // SAFETY: mock elements declare their own props; aria labels are strings.
    const ariaLabel = props['aria-label'] as string | undefined;
    if (ariaLabel !== undefined) out.push(ariaLabel);
    // SAFETY: children flow through our own jsx shim, whose value contract is
    // exactly MockJsxNode.
    if (props.children !== undefined) collectStrings(props.children as MockJsxNode, out);
  }
  return out;
};

const findButtons = (node: MockJsxNode, out: MockProps[] = []): MockProps[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => findButtons(child, out));
    return out;
  }
  if (node && typeof node === 'object' && node.type === 'Button') {
    out.push(node.props);
  }
  // SAFETY: children flow through our own jsx shim, whose value contract is
  // exactly MockJsxNode.
  if (node && typeof node === 'object' && node.props.children !== undefined) findButtons(node.props.children as MockJsxNode, out);
  return out;
};

const enabledPayload = {
  enabled: true,
  activeInstanceId: 'docker-running',
  sharedSkillsHostPath: 'C:\\skills',
  instances: [
    {
      id: 'docker-running',
      label: 'Project A',
      image: 'opencode-instance:local',
      containerId: 'cid-1',
      containerName: 'openchamber-opencode-docker-running',
      port: 4567,
      workspaceHostPath: 'C:\\proj\\a',
      workspaceContainerPath: '/workspace',
      sharing: { config: true, skills: true, credentials: false, skillsHostDir: null },
      lifecycleState: 'running',
      lastError: null,
      createdAt: 1,
    },
    {
      id: 'docker-stopped',
      label: 'Project B',
      image: 'opencode-instance:local',
      containerId: 'cid-2',
      containerName: 'openchamber-opencode-docker-stopped',
      port: 4568,
      workspaceHostPath: 'C:\\proj\\b',
      workspaceContainerPath: '/workspace',
      sharing: { config: false, skills: false, credentials: false, skillsHostDir: null },
      lifecycleState: 'stopped',
      lastError: null,
      createdAt: 2,
    },
  ],
};

describe('DockerInstanceSection behavior', () => {
  test('hides entirely while the feature toggle is off', async () => {
    resetGlobals();
    runtimeFetchResponses = [{ ok: true, payload: { enabled: false, instances: [], activeInstanceId: null, sharedSkillsHostPath: null } }];
    await registerPromise();
    const first = renderComponent(requireSection(), {});
    expect(first).toBeNull();
  });

  test('renders rows with lifecycle state and gates removal behind confirmation', async () => {
    resetGlobals();
    runtimeFetchResponses = [{ ok: true, payload: enabledPayload }];
    await registerPromise();
    const first = renderComponent(requireSection(), {});
    runEffects();
    await flushMicrotasks();
    const output = renderComponent(requireSection(), {});

    const strings = collectStrings(output);
    expect(strings).toContain('dockerInstances.title');
    expect(strings).toContain('Project A');
    expect(strings).toContain('dockerInstances.state.running');
    expect(strings).toContain('dockerInstances.state.stopped');
    expect(strings).toContain('C:\\proj\\a');

    const buttons = findButtons(output);
    const removeButtons = buttons.filter((button) => button['aria-label'] === 'dockerInstances.actions.remove');
    expect(removeButtons.length).toBe(2);

    const removeCallsBefore = runtimeFetchCalls.filter((call) => call.includes('/remove')).length;
    // SAFETY: the mocked Button stores onClick as a plain callable prop.
    await (removeButtons[0].onClick as () => void)();
    await flushMicrotasks();
    expect(runtimeFetchCalls.filter((call) => call.includes('/remove')).length).toBe(removeCallsBefore);

    // Re-render with the confirmation state applied, then click again.
    const confirmed = findButtons(renderComponent(requireSection(), {}));
    const confirmButton = confirmed.find((button) => button['aria-label'] === 'dockerInstances.actions.confirmRemove');
    expect(confirmButton).toBeDefined();
    // SAFETY: the mocked JSX tree stores handler functions as plain props; the find above asserted the label, and the runtime type is a callable prop set by our own Button mock.
    await (confirmButton?.onClick as (() => void) | undefined)?.();
    await flushMicrotasks();
    expect(runtimeFetchCalls.filter((call) => call.includes('/remove')).length).toBe(removeCallsBefore + 1);
  });

  test('a failed authoritative load shows retry state instead of an empty list', async () => {
    resetGlobals();
    runtimeFetchResponses = [];
    await registerPromise();
    const first = renderComponent(requireSection(), {});
    runEffects();
    await flushMicrotasks();
    const output = renderComponent(requireSection(), {});
    const strings = collectStrings(output);
    expect(strings).toContain('dockerInstances.state.loadFailed');
    expect(strings).not.toContain('Project A');
  });

  test('re-scopes identity when the upstream-changed event fires from another surface', async () => {
    resetGlobals();
    runtimeFetchResponses = [
      { ok: true, payload: { ...enabledPayload, activeInstanceId: null } },
      { ok: true, payload: { ...enabledPayload, activeInstanceId: 'docker-running' } },
    ];
    await registerPromise();
    renderComponent(requireSection(), {});
    runEffects();
    await flushMicrotasks();
    expect(identityOverrideCalls.at(-1)).toBeNull();

    globalThis.__ocWindowListeners?.get('openchamber:docker-upstream-changed')?.forEach((listener) => listener());
    await flushMicrotasks();
    expect(identityOverrideCalls.at(-1)).toBe('local-docker-docker-running');
  });

  test('re-scopes the runtime identity to the active docker instance and back', async () => {
    resetGlobals();
    runtimeFetchResponses = [
      { ok: true, payload: { ...enabledPayload, activeInstanceId: 'docker-running' } },
      { ok: true, payload: { ...enabledPayload, activeInstanceId: null } },
    ];
    await registerPromise();
    renderComponent(requireSection(), {});
    runEffects();
    await flushMicrotasks();
    expect(identityOverrideCalls.at(-1)).toBe('local-docker-docker-running');

    // Second refresh with no active instance restores the original identity.
    const retry = findButtons(renderComponent(requireSection(), {}));
    void retry;
    // Trigger a refresh through the retry affordance path: force a new effect
    // cycle by clearing hook state (fresh mount) and replaying the second
    // queued response.
    hookRecords.clear();
    renderComponent(requireSection(), {});
    runEffects();
    await flushMicrotasks();
    expect(identityOverrideCalls.at(-1)).toBeNull();
  });
});

describe('DockerInstancesWebEntry behavior', () => {
  test('renders nothing on the desktop shell', async () => {
    resetGlobals();
    desktopShell = true;
    runtimeFetchResponses = [{ ok: true, payload: enabledPayload }];
    await registerPromise();
    const output = renderComponent(requireWebEntry(), {});
    runEffects();
    await flushMicrotasks();
    expect(renderComponent(requireWebEntry(), {})).toBeNull();
  });

  test('renders the header entry in web mode only while the feature is enabled', async () => {
    resetGlobals();
    desktopShell = false;
    // The entry check and the mounted section both fetch; queue enough.
    runtimeFetchResponses = [
      { ok: true, payload: enabledPayload },
      { ok: true, payload: enabledPayload },
      { ok: true, payload: enabledPayload },
    ];
    await registerPromise();
    renderComponent(requireWebEntry(), { variant: 'icon' });
    runEffects();
    await flushMicrotasks();
    const output = renderComponent(requireWebEntry(), { variant: 'icon' });
    expect(output).not.toBeNull();
    const buttons = findButtons(output);
    expect(buttons.some((button) => button['aria-label'] === 'dockerInstances.actions.openAria')).toBe(true);

    desktopShell = false;
    runtimeFetchResponses = [{ ok: true, payload: { enabled: false, instances: [], activeInstanceId: null, sharedSkillsHostPath: null } }];
    // Fresh mount: the entry decides availability once per component lifetime.
    hookRecords.clear();
    renderComponent(requireWebEntry(), { variant: 'icon' });
    runEffects();
    await flushMicrotasks();
    expect(renderComponent(requireWebEntry(), { variant: 'icon' })).toBeNull();
  });
});

async function registerPromise() {
  if (!registerDockerSection || !registerWebEntry) {
    // SAFETY: the imported module is our own source file; the literal shape of
    // its exports is asserted by the tests below.
    const section = await import('./DockerInstanceSection') as {
      DockerInstanceSection: ComponentFn;
      DockerInstancesWebEntry: ComponentFn;
    };
    registerDockerSection = section.DockerInstanceSection;
    registerWebEntry = section.DockerInstancesWebEntry;
  }
}
