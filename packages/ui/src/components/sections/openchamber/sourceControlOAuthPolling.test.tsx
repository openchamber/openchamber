import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitTransportBindingIntent, GitTransportBindingRemovalIntent, GitTransportBindingRemovalResult, GitTransportBindingResult, SourceControlAuthStatus, SourceControlBindingRead, SourceControlIdentity, SourceControlProviderBindingMutation, SourceControlRepositoryBindingResetIntent } from '@/lib/api/types';

type TestNode = ElementNode | TestNode[] | string | number | boolean | null | undefined;
type Component<Props extends object = Record<string, never>> = (props: Props) => TestNode;
type ClickHandler = () => void | Promise<void>;
type ElementProps = {
  'aria-label'?: string;
  children?: TestNode;
  description?: TestNode;
  headerAction?: TestNode;
  onClick?: ClickHandler;
  onChange?: (event: { target: { value: string } }) => void;
  value?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  ref?: { current: { focus: () => void } | null };
};
type ElementNode = { type: string | symbol; props: ElementProps };
type Effect = () => void | (() => void);

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
};

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];

const sameDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getCurrentRecord = (): HookRecord => {
  if (!currentRecord) throw new Error('Hooks can only run while rendering');
  return currentRecord;
};

const renderComponent = <Props extends object>(component: Component<Props>, props: Props): TestNode => {
  const previousRecord = currentRecord;
  const previousIndex = hookIndex;
  let record = hookRecords.get(component);
  if (!record) {
    record = { values: [], deps: [], cleanups: [] };
    hookRecords.set(component, record);
  }
  currentRecord = record;
  hookIndex = 0;
  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousIndex;
  }
};

function useCallback<Args extends never[], Result>(callback: (...args: Args) => Result, deps?: unknown[]): (...args: Args) => Result {
  const record = getCurrentRecord();
  const index = hookIndex++;
  if (!sameDeps(record.deps[index], deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  // SAFETY: This slot is only written with the callback passed to this hook index.
  return record.values[index] as (...args: Args) => Result;
}

function useEffect(effect: Effect, deps?: unknown[]): void {
  const record = getCurrentRecord();
  const index = hookIndex++;
  if (sameDeps(record.deps[index], deps)) return;
  record.deps[index] = deps;
  pendingEffects.push(() => {
    record.cleanups[index]?.();
    const cleanup = effect();
    record.cleanups[index] = cleanup || undefined;
  });
}

function useRef<Value>(initialValue: Value): { current: Value } {
  const record = getCurrentRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) record.values[index] = { current: initialValue };
  // SAFETY: This hook index is initialized once with a ref container.
  return record.values[index] as { current: Value };
}

function useState<Value>(initialValue: Value): [Value, (next: Value | ((value: Value) => Value)) => void] {
  const record = getCurrentRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) record.values[index] = initialValue;
  return [
    // SAFETY: This hook index is initialized and subsequently written only with Value.
    record.values[index] as Value,
    (next) => {
      // SAFETY: This hook slot contains Value, and Function values follow React's updater contract.
      record.values[index] = next instanceof Function
        ? (next as (value: Value) => Value)(record.values[index] as Value)
        : next;
    },
  ];
}

const fragment = Symbol('Fragment');
const jsx = <Props extends object>(type: Component<Props> | string | symbol, props: Props & ElementProps): TestNode => {
  if (type === fragment) return props.children ?? null;
  if (type instanceof Function) return renderComponent(type, props);
  return { type, props };
};

function useMemo<Value>(factory: () => Value, deps: unknown[]): Value {
  const memo = useRef<{ value: Value; deps: unknown[] } | null>(null);
  if (!memo.current || !sameDeps(memo.current.deps, deps)) memo.current = { value: factory(), deps };
  return memo.current.value;
}

function useSyncExternalStore<Value>(subscribe: (listener: () => void) => () => void, snapshot: () => Value): Value {
  // This harness renders explicitly in renderSettled; subscription-driven
  // rendering is covered by the React probes in repository-binding tests.
  useEffect(() => subscribe(() => {}), [subscribe]);
  return snapshot();
}

const ReactMock = { useCallback, useEffect, useLayoutEffect: useEffect, useRef, useState, useMemo, useSyncExternalStore };
const jsxRuntime = { Fragment: fragment, jsx, jsxs: jsx, jsxDEV: jsx };

let runtimeKey = 'runtime-a';
let runtimeWillChange: (() => void) | null = null;
const runtimeChanged = new Set<() => void>();
let nextTimerId = 1;
const timers = new Map<number, () => void>();
const successMessages: string[] = [];
const errorMessages: string[] = [];
let refreshStatusCalls = 0;
let refreshInstancesCalls = 0;
let setStatusCalls = 0;
let refreshAuthStatus: () => Promise<SourceControlAuthStatus | null> = async () => null;
let setTokenAuth: () => Promise<SourceControlAuthStatus>;
const gitLabIdentity: SourceControlIdentity = { provider: 'gitlab', instance: 'https://gitlab.com' };
const availableCapabilities = {
  authenticationMethods: {
    device: { available: true },
    pat: { available: true },
    cli: { available: false },
  },
};
let readCapabilities = async () => availableCapabilities;
let disconnectedAccountIds: string[] = [];
let cliDisabledValues: boolean[] = [];
let disconnectAuth: () => Promise<void> = async () => undefined;
let setCliDisabledAuth: () => Promise<void> = async () => undefined;
const translate = (key: string) => key;

type CompletionResult =
  | { status: 'connected' }
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'error'; message?: string };

let completeAuth: () => Promise<CompletionResult> = async () => ({ status: 'pending' });
let effectiveDirectory = '/workspace/project';
let bindingRead: () => Promise<SourceControlBindingRead>;
let resetBinding: (intent: SourceControlRepositoryBindingResetIntent) => Promise<SourceControlBindingRead>;
let providerMutation: (input: SourceControlProviderBindingMutation) => Promise<SourceControlBindingRead>;
let providerMutationCalls: SourceControlProviderBindingMutation[] = [];
let configureTransportCalls: GitTransportBindingIntent[] = [];
let configureTransport: () => Promise<GitTransportBindingResult> = async () => ({ status: 'configured', binding: boundBinding });
let removeTransportCalls: GitTransportBindingRemovalIntent[] = [];
const removeTransport: () => Promise<GitTransportBindingRemovalResult> = async () => ({ status: 'removed', binding: missingBinding });

const endpoint = (displayUrl: string, fingerprint: string) => ({ displayUrl, fingerprint });
const repository = {
  repositoryId: 'repository-one',
  configRevision: 'config-one',
  bare: false,
  remotes: [{
    name: 'origin',
    fetch: endpoint('https://github.com/team/repository.git', 'f'.repeat(64)),
    push: endpoint('https://github.com/team/repository.git', 'p'.repeat(64)),
  }],
};
const missingBinding: SourceControlBindingRead = {
  status: 'missing',
  repository,
  revision: 7,
  binding: null,
};
const boundBinding: SourceControlBindingRead = {
  status: 'bound',
  repository,
  revision: 8,
  binding: {
    repositoryId: repository.repositoryId,
    revision: 8,
    providers: [{
      provider: 'github',
      instance: 'github.com',
      accountId: 'account-one',
      primaryRemote: 'origin',
      readiness: 'ready',
      endpoint: repository.remotes[0].fetch,
    }],
    remotes: [{ ...repository.remotes[0], mode: 'system', readiness: 'ready' }],
    auxiliary: [],
    state: 'bound',
    configRevision: repository.configRevision,
  },
};

const sourceControl = {
  authStart: async () => ({
    flowId: 'flow-a',
    userCode: 'ABCD-1234',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: 'https://example.test/device?code=ABCD-1234',
    interval: 1,
  }),
  authComplete: async () => completeAuth(),
  authStatus: async () => ({ status: 'disconnected' as const, connected: false }),
  authInstances: async () => [],
  capabilities: async () => readCapabilities(),
  authSetToken: async () => setTokenAuth(),
  authDisconnect: async (_identity: SourceControlIdentity, accountId: string) => {
    disconnectedAccountIds.push(accountId);
    await disconnectAuth();
  },
  authActivate: async () => ({ status: 'disconnected' as const, connected: false }),
  authSetCliDisabled: async (_identity: SourceControlIdentity, disabled: boolean) => {
    cliDisabledValues.push(disabled);
    await setCliDisabledAuth();
  },
  repositoryBinding: async () => {
    return bindingRead();
  },
  resetRepositoryBinding: async (intent: SourceControlRepositoryBindingResetIntent) => resetBinding(intent),
  repositoryProviderBindingMutate: async (input: SourceControlProviderBindingMutation) => {
    providerMutationCalls.push(input);
    return providerMutation(input);
  },
};
const git = {
  configureTransportBinding: async (intent: (typeof configureTransportCalls)[number]) => {
    configureTransportCalls.push(intent);
    return configureTransport();
  },
  removeTransportBinding: async (intent: GitTransportBindingRemovalIntent) => {
    removeTransportCalls.push(intent);
    return removeTransport();
  },
};

const connectedStatus: Extract<SourceControlAuthStatus, { status: 'connected' }> = {
  provider: 'github' as const,
  instance: 'https://github.com',
  status: 'connected' as const,
  connected: true as const,
  user: {
    provider: 'github',
    instance: 'https://github.com',
    id: 'user-one',
    username: 'octocat',
  },
  accounts: [{
    id: 'account-one',
    credentialId: 'account-one',
    credentialRevision: 1,
    providerUserId: 'github.com#user-one',
    providerUserStatus: 'available',
    user: {
      provider: 'github' as const,
      instance: 'https://github.com',
      id: 'user-one',
      username: 'octocat',
    },
    current: false,
    source: 'oauth' as const,
    status: 'valid' as const,
  }],
};
const nullable = <Value,>(value: Value | null): Value | null => value;
const authIdentities: SourceControlIdentity[] = [];
const gitLabAuthEntry = { status: nullable<SourceControlAuthStatus>(null), isLoading: false, hasChecked: true };

const authStoreState = {
  entries: {
    github: {
      status: nullable<SourceControlAuthStatus>(null),
      isLoading: false,
      hasChecked: true,
    },
  },
  identities: authIdentities,
  refreshStatus: async () => {
    refreshStatusCalls += 1;
    return refreshAuthStatus();
  },
  refreshInstances: async () => {
    refreshInstancesCalls += 1;
    return [];
  },
  setStatus: () => { setStatusCalls += 1; },
  refreshAll: async () => undefined,
};

mock.module('react/jsx-runtime', () => jsxRuntime);
mock.module('react/jsx-dev-runtime', () => jsxRuntime);
mock.module('react', () => ({ __esModule: true, default: ReactMock, ...ReactMock }));
mock.module('@/components/ui/button', () => ({
  Button: (props: ElementProps) => jsx('button', props),
}));
mock.module('@/components/ui/input', () => ({
  Input: (props: ElementProps) => jsx('input', props),
}));
mock.module('@/components/ui/select', () => ({
  Select: (props: ElementProps) => jsx('select', props),
  SelectContent: ({ children }: ElementProps) => children ?? null,
  SelectItem: ({ children }: ElementProps) => children ?? null,
  SelectTrigger: (props: ElementProps) => jsx('button', props),
  SelectValue: ({ children }: ElementProps) => children ?? null,
}));
mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => { successMessages.push(message); },
    error: (message: string) => { errorMessages.push(message); },
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: ElementProps) => children ?? null,
  CollapsibleTrigger: ({ children }: ElementProps) => children ?? null,
  CollapsibleContent: ({ children }: ElementProps) => children ?? null,
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_CONTROL_CLUSTER_CLASS: '',
  SETTINGS_FIELDS_STACK_CLASS: '',
  SETTINGS_HELPER_CLASS: '',
  SETTINGS_SELECT_ROW_TRIGGER_CLASS: '',
  SETTINGS_SELECT_SIZE: 'sm',
  SettingsControlGroup: ({ children }: ElementProps) => children ?? null,
  SettingsFieldRow: ({ children, description }: ElementProps) => [description ?? null, children ?? null],
  SettingsStackedField: ({ children }: ElementProps) => children ?? null,
  SettingsCheckboxRow: ({ label, onChange, checked, disabled }: { label: string; onChange: (checked: boolean) => void; checked: boolean; disabled?: boolean }) =>
    jsx('button', { children: label, disabled, onClick: () => onChange(!checked) }),
  SettingsGroupTitle: ({ children }: ElementProps) => children ?? null,
  SettingsSection: ({ children, headerAction }: ElementProps) => [headerAction ?? null, children ?? null],
}));
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({ sourceControl }),
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ sourceControl, git, runtime: { isVSCode: false } }),
}));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
mock.module('@/stores/useSourceControlAuthStore', () => ({
  getSourceControlAuthKey: () => 'github',
  useSourceControlAuthEntry: () => gitLabAuthEntry,
  useSourceControlAuthStore: <Value,>(selector: (state: typeof authStoreState) => Value) => selector(authStoreState),
}));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }) }));
mock.module('@/lib/url', () => ({ openExternalUrl: async () => undefined }));
mock.module('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => {
    runtimeWillChange = listener;
    return () => {
      if (runtimeWillChange === listener) runtimeWillChange = null;
    };
  },
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeChanged.add(listener);
    return () => { runtimeChanged.delete(listener); };
  },
}));

const { GitHubSettings } = await import('./GitHubSettings');
const { GitLabSettings } = await import('./GitLabSettings');
const { repositoryBindingOwner } = await import('@/lib/source-control/repository-binding');
// SAFETY: These synchronous function components render through the mocked JSX runtime above.
const GitHubSettingsHarness = GitHubSettings as Component;
// SAFETY: These synchronous function components render through the mocked JSX runtime above.
const GitLabSettingsHarness = GitLabSettings as Component;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

const flush = async (): Promise<void> => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    await Promise.resolve();
  }
  await Promise.resolve();
  await Promise.resolve();
};

const renderSettled = async (component: Component): Promise<TestNode> => {
  renderComponent(component, {});
  await flush();
  renderComponent(component, {});
  await flush();
  return renderComponent(component, {});
};

const collectText = (node: TestNode): string => {
  if (node == null || node === true || node === false) return '';
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node instanceof Object) return collectText(node.props.children);
  return String(node);
};

const findButton = (node: TestNode, label: string): ElementNode | null => {
  if (node == null || node === true || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child, label);
      if (match) return match;
    }
    return null;
  }
  if (!(node instanceof Object)) return null;
  const element = node;
  if (element.type === 'button' && collectText(element) === label) return element;
  return findButton(element.props.children, label);
};



const click = async (tree: TestNode, label: string): Promise<void> => {
  const button = findButton(tree, label);
  if (!button) throw new Error(`Button not found: ${label}`);
  const onClick = button.props.onClick;
  if (!onClick) throw new Error(`Button has no click handler: ${label}`);
  await onClick();
  await flush();
};

const findInput = (node: TestNode, ariaLabel: string): ElementNode | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const input = findInput(child, ariaLabel);
      if (input) return input;
    }
    return null;
  }
  if (!(node instanceof Object)) return null;
  if (node.type === 'input' && node.props['aria-label'] === ariaLabel) return node;
  return findInput(node.props.children, ariaLabel);
};


const runNextTimer = async (): Promise<void> => {
  const entry = timers.entries().next().value;
  if (!entry) throw new Error('Expected a pending poll timer');
  timers.delete(entry[0]);
  entry[1]();
  await flush();
};

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<Value>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

const switchRuntime = (): void => {
  runtimeKey = 'runtime-b';
  runtimeWillChange?.();
  runtimeChanged.forEach((listener) => listener());
};

beforeEach(() => {
  repositoryBindingOwner.reset();
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeKey = 'runtime-a';
  runtimeWillChange = null;
  runtimeChanged.clear();
  nextTimerId = 1;
  timers.clear();
  successMessages.length = 0;
  errorMessages.length = 0;
  refreshStatusCalls = 0;
  refreshInstancesCalls = 0;
  setStatusCalls = 0;
  refreshAuthStatus = async () => null;
  setTokenAuth = async () => ({ ...gitLabIdentity, status: 'disconnected', connected: false });
  readCapabilities = async () => availableCapabilities;
  authStoreState.identities = [];
  gitLabAuthEntry.status = null;
  gitLabAuthEntry.isLoading = false;
  disconnectedAccountIds = [];
  cliDisabledValues = [];
  disconnectAuth = async () => undefined;
  setCliDisabledAuth = async () => undefined;
  completeAuth = async () => ({ status: 'pending' });
  effectiveDirectory = '/workspace/project';
  bindingRead = async () => missingBinding;
  configureTransport = async () => ({ status: 'configured', binding: boundBinding });
  resetBinding = async () => missingBinding;
  providerMutation = async () => boundBinding;
  providerMutationCalls = [];
  configureTransportCalls = [];
  removeTransportCalls = [];
  authStoreState.entries.github.status = null;
  authStoreState.entries.github.isLoading = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
  });
});

afterEach(() => {
  for (const record of hookRecords.values()) record.cleanups.forEach((cleanup) => cleanup?.());
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('source-control OAuth polling', () => {
  test('keeps cached GitHub accounts visible during refresh', async () => {
    authStoreState.entries.github.status = connectedStatus;
    authStoreState.entries.github.isLoading = true;

    const tree = await renderSettled(GitHubSettingsHarness);

    expect(collectText(tree)).toContain('octocat');
  });

  test('GitHub stops an active flow on runtime switch and ignores its late completion', async () => {
    const completion = deferred<CompletionResult>();
    completeAuth = () => completion.promise;
    let tree = await renderSettled(GitHubSettingsHarness);

    await click(tree, 'settings.github.page.actions.connect');
    tree = await renderSettled(GitHubSettingsHarness);
    expect(collectText(tree)).toContain('ABCD-1234');

    await runNextTimer();
    expect(timers.size).toBe(0);
    switchRuntime();
    runtimeKey = 'runtime-a';
    tree = await renderSettled(GitHubSettingsHarness);
    expect(collectText(tree)).not.toContain('ABCD-1234');

    completion.resolve({ status: 'connected' });
    await flush();
    await renderSettled(GitHubSettingsHarness);

    expect(refreshStatusCalls).toBe(0);
    expect(refreshInstancesCalls).toBe(0);
    expect(successMessages).toEqual([]);
  });

  test('GitHub stops OAuth follow-up discovery after a runtime round trip', async () => {
    completeAuth = async () => ({ status: 'connected' });
    const statusRead = deferred<SourceControlAuthStatus | null>();
    refreshAuthStatus = () => statusRead.promise;
    let tree = await renderSettled(GitHubSettingsHarness);

    await click(tree, 'settings.github.page.actions.connect');
    await renderSettled(GitHubSettingsHarness);
    await runNextTimer();
    expect(refreshStatusCalls).toBe(1);

    switchRuntime();
    runtimeKey = 'runtime-a';
    statusRead.resolve(null);
    await flush();
    tree = await renderSettled(GitHubSettingsHarness);

    expect(refreshInstancesCalls).toBe(0);
    expect(successMessages).toEqual([]);
    expect(findButton(tree, 'settings.github.page.actions.connect')?.props.disabled).toBe(false);
  });

  test('GitLab stops an active flow on runtime switch and ignores its late completion', async () => {
    const completion = deferred<CompletionResult>();
    completeAuth = () => completion.promise;
    let tree = await renderSettled(GitLabSettingsHarness);
    refreshStatusCalls = 0;
    refreshInstancesCalls = 0;

    await click(tree, 'settings.gitlab.actions.connect');
    tree = await renderSettled(GitLabSettingsHarness);
    expect(collectText(tree)).toContain('ABCD-1234');

    await runNextTimer();
    switchRuntime();
    tree = await renderSettled(GitLabSettingsHarness);
    expect(collectText(tree)).not.toContain('ABCD-1234');

    completion.resolve({ status: 'connected' });
    await flush();
    await renderSettled(GitLabSettingsHarness);

    expect(refreshStatusCalls).toBe(0);
    expect(refreshInstancesCalls).toBe(0);
    expect(successMessages).toEqual([]);
  });

  test('GitHub does not start another completion poll while one is unresolved', async () => {
    const firstCompletion = deferred<CompletionResult>();
    let completionCalls = 0;
    let activeCompletions = 0;
    let maxActiveCompletions = 0;
    completeAuth = async () => {
      completionCalls += 1;
      activeCompletions += 1;
      maxActiveCompletions = Math.max(maxActiveCompletions, activeCompletions);
      if (completionCalls === 1) {
        const result = await firstCompletion.promise;
        activeCompletions -= 1;
        return result;
      }
      activeCompletions -= 1;
      return { status: 'pending' };
    };

    let tree = await renderSettled(GitHubSettingsHarness);
    await click(tree, 'settings.github.page.actions.connect');
    await renderSettled(GitHubSettingsHarness);
    await runNextTimer();

    expect(completionCalls).toBe(1);
    expect(timers.size).toBe(0);
    await renderSettled(GitHubSettingsHarness);
    await renderSettled(GitHubSettingsHarness);
    expect(completionCalls).toBe(1);
    expect(timers.size).toBe(0);

    firstCompletion.resolve({ status: 'pending' });
    await flush();
    tree = await renderSettled(GitHubSettingsHarness);
    expect(timers.size).toBe(1);

    await runNextTimer();
    await renderSettled(GitHubSettingsHarness);
    expect(completionCalls).toBe(2);
    expect(maxActiveCompletions).toBe(1);
    expect(collectText(tree)).toContain('ABCD-1234');
  });
});

describe('GitHub auth lifecycle', () => {
  for (const outcome of ['success', 'failure'] as const) {
    test(`ignores late account removal ${outcome} after a runtime round trip`, async () => {
      authStoreState.entries.github.status = connectedStatus;
      const completion = deferred<void>();
      disconnectAuth = () => completion.promise;
      let tree = await renderSettled(GitHubSettingsHarness);
      refreshStatusCalls = 0;
      refreshInstancesCalls = 0;

      const action = findButton(tree, 'settings.sourceControl.actions.remove')?.props.onClick;
      if (!action) throw new Error('Remove action not found');
      const pending = action();
      await flush();
      switchRuntime();
      runtimeKey = 'runtime-a';
      if (outcome === 'success') completion.resolve();
      else completion.reject(new Error('old runtime failed'));
      await pending;
      tree = await renderSettled(GitHubSettingsHarness);

      expect(disconnectedAccountIds).toEqual(['account-one']);
      expect(refreshStatusCalls).toBe(0);
      expect(refreshInstancesCalls).toBe(0);
      expect(successMessages).toEqual([]);
      expect(errorMessages).toEqual([]);
      expect(findButton(tree, 'settings.sourceControl.actions.remove')?.props.disabled).toBe(false);
    });

    test(`ignores late CLI toggle ${outcome} after a runtime round trip`, async () => {
      const cli = { ...connectedStatus.accounts[0], id: 'account-cli', credentialId: 'account-cli', source: 'cli' as const };
      authStoreState.entries.github.status = { ...connectedStatus, accounts: [cli] };
      const completion = deferred<void>();
      setCliDisabledAuth = () => completion.promise;
      let tree = await renderSettled(GitHubSettingsHarness);
      refreshStatusCalls = 0;

      const action = findButton(tree, 'settings.github.page.ghCli.actions.disable')?.props.onClick;
      if (!action) throw new Error('CLI action not found');
      const pending = action();
      await flush();
      switchRuntime();
      runtimeKey = 'runtime-a';
      if (outcome === 'success') completion.resolve();
      else completion.reject(new Error('old runtime failed'));
      await pending;
      tree = await renderSettled(GitHubSettingsHarness);

      expect(cliDisabledValues).toEqual([true]);
      expect(refreshStatusCalls).toBe(0);
      expect(successMessages).toEqual([]);
      expect(errorMessages).toEqual([]);
      expect(findButton(tree, 'settings.github.page.ghCli.actions.disable')?.props.disabled).toBe(false);
    });
  }
});

describe('GitLab auth lifecycle', () => {
  for (const outcome of ['success', 'failure']) {
    test(`ignores late PAT ${outcome} and associated UI effects after a runtime round trip`, async () => {
      const completion = deferred<SourceControlAuthStatus>();
      setTokenAuth = () => completion.promise;
      let tree = await renderSettled(GitLabSettingsHarness);
      const input = findInput(tree, 'settings.gitlab.token.label');
      expect(input?.props.onChange).toBeDefined();
      input?.props.onChange?.({ target: { value: 'test-token' } });
      tree = await renderSettled(GitLabSettingsHarness);
      refreshStatusCalls = 0;
      refreshInstancesCalls = 0;

      const pending = click(tree, 'settings.common.actions.saveChanges');
      await flush();
      switchRuntime();
      runtimeKey = 'runtime-a';
      if (outcome === 'success') completion.resolve({ ...gitLabIdentity, status: 'disconnected', connected: false });
      else completion.reject(new Error('old runtime failed'));
      await pending;
      tree = await renderSettled(GitLabSettingsHarness);

      expect(setStatusCalls).toBe(0);
      expect(refreshStatusCalls).toBe(0);
      expect(refreshInstancesCalls).toBe(0);
      expect(findInput(tree, 'settings.gitlab.token.label')?.props.value).toBe('test-token');
      expect(findButton(tree, 'settings.common.actions.saveChanges')?.props.disabled).toBe(true);
      expect(collectText(tree)).not.toContain('settings.gitlab.status.operationFailed');
    });
  }

  test('stops PAT follow-up discovery if the runtime switches during status refresh', async () => {
    let tree = await renderSettled(GitLabSettingsHarness);
    findInput(tree, 'settings.gitlab.token.label')?.props.onChange?.({ target: { value: 'test-token' } });
    tree = await renderSettled(GitLabSettingsHarness);
    const statusRead = deferred<SourceControlAuthStatus | null>();
    refreshAuthStatus = () => statusRead.promise;
    refreshInstancesCalls = 0;
    const pending = click(tree, 'settings.common.actions.saveChanges');
    await flush();
    expect(setStatusCalls).toBe(1);

    switchRuntime();
    statusRead.resolve(null);
    await pending;

    expect(refreshInstancesCalls).toBe(0);
  });

  test('same-runtime PAT success updates inventory and clears the input', async () => {
    let tree = await renderSettled(GitLabSettingsHarness);
    findInput(tree, 'settings.gitlab.token.label')?.props.onChange?.({ target: { value: 'test-token' } });
    tree = await renderSettled(GitLabSettingsHarness);
    refreshStatusCalls = 0;
    refreshInstancesCalls = 0;
    await click(tree, 'settings.common.actions.saveChanges');
    tree = await renderSettled(GitLabSettingsHarness);

    expect(setStatusCalls).toBe(1);
    expect(refreshStatusCalls).toBe(1);
    expect(refreshInstancesCalls).toBe(1);
    expect(findInput(tree, 'settings.gitlab.token.label')?.props.value).toBe('');
  });

  test('preserves valid capabilities after deferred read failure and retries without a request loop', async () => {
    authStoreState.identities = [gitLabIdentity];
    let tree = await renderSettled(GitLabSettingsHarness);
    expect(findInput(tree, 'settings.gitlab.token.label')).not.toBeNull();

    const capabilitiesRead = deferred<typeof availableCapabilities>();
    let capabilityCalls = 0;
    readCapabilities = () => { capabilityCalls += 1; return capabilitiesRead.promise; };
    authStoreState.identities = [{ ...gitLabIdentity }];
    tree = await renderSettled(GitLabSettingsHarness);
    expect(findInput(tree, 'settings.gitlab.token.label')).not.toBeNull();
    capabilitiesRead.reject(new Error('offline'));
    await flush();
    tree = await renderSettled(GitLabSettingsHarness);

    expect(findInput(tree, 'settings.gitlab.token.label')).not.toBeNull();
    expect(collectText(tree)).toContain('settings.gitlab.status.operationFailed');
    expect(findButton(tree, 'sessionAuth.error.retry')).not.toBeNull();
    await renderSettled(GitLabSettingsHarness);
    expect(capabilityCalls).toBe(1);

    readCapabilities = async () => { capabilityCalls += 1; return availableCapabilities; };
    await click(tree, 'sessionAuth.error.retry');
    tree = await renderSettled(GitLabSettingsHarness);
    expect(capabilityCalls).toBe(2);
    expect(collectText(tree)).not.toContain('settings.gitlab.status.operationFailed');
    expect(findButton(tree, 'sessionAuth.error.retry')).toBeNull();
  });

  test('initial capability failure exposes retry instead of silently hiding all connection methods', async () => {
    readCapabilities = async () => { throw new Error('offline'); };
    let tree = await renderSettled(GitLabSettingsHarness);
    expect(collectText(tree)).toContain('settings.gitlab.status.operationFailed');
    expect(findInput(tree, 'settings.gitlab.token.label')).toBeNull();

    readCapabilities = async () => availableCapabilities;
    await click(tree, 'sessionAuth.error.retry');
    tree = await renderSettled(GitLabSettingsHarness);
    expect(findInput(tree, 'settings.gitlab.token.label')).not.toBeNull();
    expect(collectText(tree)).not.toContain('settings.gitlab.status.operationFailed');
  });

  test('ignores capability failure after a runtime switch', async () => {
    const capabilitiesRead = deferred<typeof availableCapabilities>();
    readCapabilities = () => capabilitiesRead.promise;
    await renderSettled(GitLabSettingsHarness);
    switchRuntime();
    capabilitiesRead.reject(new Error('old runtime offline'));
    await flush();
    const tree = renderComponent(GitLabSettingsHarness, {});
    expect(collectText(tree)).not.toContain('settings.gitlab.status.operationFailed');
  });
});

describe('source-control account presentation', () => {
  test('GitLab retains grouped credentials and exact account actions while inventory is unreachable', async () => {
    const oauth = connectedStatus.accounts[0];
    gitLabAuthEntry.status = {
      ...gitLabIdentity,
      status: 'unreachable',
      connected: false,
      accounts: [oauth, { ...oauth, id: 'account-cli', credentialId: 'account-cli', source: 'cli' }],
      cli: { available: true, disabled: false, active: false },
    };
    const tree = await renderSettled(GitLabSettingsHarness);
    expect(collectText(tree)).toContain('octocat');
    expect(collectText(tree)).toContain('settings.github.page.accountSource.oauth');
    expect(collectText(tree)).toContain('settings.gitlab.cli.label');
    expect(collectText(tree)).toContain('settings.gitlab.status.operationFailed');

    await click(tree, 'settings.sourceControl.actions.remove');
    await click(tree, 'settings.gitlab.actions.disableCli');
    expect(disconnectedAccountIds).toEqual(['account-one']);
    expect(cliDisabledValues).toEqual([true]);
  });

  test('groups credentials that belong to the same provider user', async () => {
    const oauth = connectedStatus.accounts[0];
    const cli = { ...oauth, id: 'account-cli', credentialId: 'account-cli', source: 'cli' as const };
    const otherInstance = {
      ...oauth,
      id: 'account-other-instance',
      user: { ...oauth.user, instance: 'https://github.example.com' },
    };
    authStoreState.entries.github.status = {
      ...connectedStatus,
      accounts: [oauth, cli, otherInstance],
    };

    const tree = await renderSettled(GitHubSettingsHarness);
    const usernames = collectText(tree).match(/octocat/g) ?? [];

    expect(usernames).toHaveLength(4);
    expect(collectText(tree)).toContain('settings.github.page.accountSource.oauth');
    expect(collectText(tree)).toContain('settings.github.page.accountSource.cli');
  });

  test('keeps credential actions scoped to their exact account source', async () => {
    const oauth = connectedStatus.accounts[0];
    const cli = { ...oauth, id: 'account-cli', credentialId: 'account-cli', source: 'cli' as const };
    authStoreState.entries.github.status = { ...connectedStatus, accounts: [oauth, cli] };
    const tree = await renderSettled(GitHubSettingsHarness);

    await click(tree, 'settings.sourceControl.actions.remove');
    await click(tree, 'settings.github.page.ghCli.actions.disable');

    expect(disconnectedAccountIds).toEqual(['account-one']);
    expect(cliDisabledValues).toEqual([true]);
  });
});
