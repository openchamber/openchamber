import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SourceControlAuthStatus, SourceControlIdentity } from '@/lib/api/types';

// The GitHubEnterpriseSettings instance block renders through the mocked JSX
// runtime below; the tree is a plain object graph the tests can search and
// click, the same harness sourceControlOAuthPolling.test.tsx uses for the
// neighboring provider cards.
type TestNode = ElementNode | TestNode[] | string | number | boolean | null | undefined;
type Component<Props extends object = Record<string, never>> = (props: Props) => TestNode;
type ClickHandler = () => void | Promise<void>;
type ElementProps = {
  'aria-label'?: string;
  children?: TestNode;
  label?: string;
  info?: string;
  description?: TestNode;
  onClick?: ClickHandler;
  onChange?: (event: { target: { value: string } }) => void;
  value?: string;
  disabled?: boolean;
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

const runtimeKey = 'runtime-a';
const enterpriseIdentity: SourceControlIdentity = { provider: 'github', instance: 'github.example.com' };

type StatusEntry = { status: SourceControlAuthStatus | null; isLoading: boolean; hasChecked: boolean };

let entry: StatusEntry = {
  status: null,
  isLoading: false,
  hasChecked: true,
};
let cliDisabledCalls: Array<[SourceControlIdentity, boolean]> = [];
let tokenCalls: string[] = [];
let activateCalls: Array<[SourceControlIdentity, string]> = [];

const capabilities = async () => ({
  identity: enterpriseIdentity,
  authentication: true,
  authenticationMethods: {
    device: { available: false },
    pat: { available: true },
    cli: { available: true },
  },
  multipleAccounts: true,
  projects: true,
  issues: true,
  changeRequests: true,
  draftChangeRequests: true,
  mergeChangeRequests: true,
  ci: true,
});
const sourceControl = {
  capabilities,
  authStatus: async () => entry.status,
  authInstances: async () => [enterpriseIdentity],
  authSetToken: async (_identity: SourceControlIdentity, token: string) => {
    tokenCalls.push(token);
    return entry.status;
  },
  authSetCliDisabled: async (identity: SourceControlIdentity, disabled: boolean) => {
    cliDisabledCalls.push([identity, disabled]);
    return { disabled };
  },
  authDisconnect: async () => undefined,
  authActivate: async (identity: SourceControlIdentity, accountId: string) => {
    activateCalls.push([identity, accountId]);
    return entry.status;
  },
};
const storeState = {
  identities: [enterpriseIdentity],
  refreshInstances: async () => [enterpriseIdentity],
  refreshStatus: async () => entry.status,
  setStatus: () => undefined,
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
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({ sourceControl }),
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_CONTROL_CLUSTER_CLASS: '',
  SETTINGS_FIELDS_STACK_CLASS: '',
  SettingsControlGroup: ({ children }: ElementProps) => children ?? null,
  SettingsFieldRow: ({ label, info, children }: ElementProps) => [label, info, children ?? null],
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}));
mock.module('@/lib/source-control/identity', () => ({
  getManagedCredentialSourceLabelKey: (key: string) => key,
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: () => () => undefined,
}));
mock.module('@/stores/useSourceControlAuthStore', () => ({
  useSourceControlAuthEntry: () => entry,
  useSourceControlAuthStore: <Value,>(selector: (state: typeof storeState) => Value) => selector(storeState),
}));
mock.module('./SourceControlAccountList', () => ({
  SourceControlAccountList: ({ accounts, currentLabel, renderActions }: {
    accounts: Array<{ id: string; user: { username: string }; source: string; current: boolean }>;
    currentLabel?: TestNode;
    renderActions?: (account: { id: string; user: { username: string }; source: string; current: boolean }) => TestNode;
  }) => jsx('account-list', {
    children: (accounts ?? []).map((account) => jsx('account-row', {
      children: [String(account.user.username), account.current ? currentLabel : null, renderActions ? renderActions(account) : null],
    })),
  }),
}));

// SAFETY: These synchronous function components render through the mocked JSX runtime above.

const setStatus = (status: SourceControlAuthStatus | null) => {
  entry = { status, isLoading: false, hasChecked: true };
};

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

// SAFETY: Harness is the component the mock loader returns for
// './GitHubEnterpriseSettings'; the cast only narrows it to the renderComponent
// contract the component module satisfies.
const renderSettled = async (): Promise<TestNode> => {
  const { GitHubEnterpriseSettings: Harness } = await import('./GitHubEnterpriseSettings');
  // SAFETY: Harness is the mock-loader component module; the cast only narrows it to the renderComponent contract it implements.
  renderComponent(Harness as Component, {});
  const { GitHubEnterpriseSettings: _Harness } = await import('./GitHubEnterpriseSettings');
  // SAFETY: Harness is the mock-loader component module; the cast only narrows it to the renderComponent contract it implements.
  renderComponent(_Harness as Component, {});
  // SAFETY: Harness is the mock-loader component module; the cast only narrows it to the renderComponent contract it implements.
  return renderComponent(_Harness as Component, {});
};

const textOf = (node: TestNode): string => {
  if (node == null || node === true || node === false) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node instanceof Object) return textOf(node.props.children);
  return String(node);
};

const findButton = (node: TestNode, label: string): ElementNode | null => {
  if (node == null || node === true || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (node instanceof Object && node.type === 'button' && textOf(node.props.children) === label) return node;
  return node instanceof Object ? findButton(node.props.children, label) : null;
};

const account = (id: string, source: 'pat' | 'cli', current = source === 'cli') => ({
  id,
  credentialId: id,
  credentialRevision: 1,
  providerUserId: `${enterpriseIdentity.instance}#${id}`,
  providerUserStatus: 'available' as const,
  user: { ...enterpriseIdentity, id, username: 'octocat' },
  current,
  source,
  status: 'valid' as const,
});

beforeEach(() => {
  activateCalls = [];
  cliDisabledCalls = [];
  tokenCalls = [];
  entry = { status: null, isLoading: false, hasChecked: true };
});

describe('GitHubEnterpriseSettings', () => {
  test('offers the host gh login with an explicit Use before any account connects and clicking it activates that host gh with no PAT', async () => {
    // Switch off, gh login listed, no PAT account: the gh account row's Use
    // offer turns this host's gh on — the same offer the GitLab card makes for
    // glab — and no token is entered.
    setStatus({
      ...enterpriseIdentity,
      status: 'disconnected',
      connected: false,
      accounts: [account('github.example.com#cli:42', 'cli', false)],
      cli: { available: true, disabled: false, active: false, user: { ...enterpriseIdentity, id: '42', username: 'octocat' } },
    });

    const tree = await renderSettled();
    const use = findButton(tree, 'settings.github.enterprise.actions.useCli');
    expect(use).not.toBeNull();

    use!.props.onClick?.();
    await flush();
    expect(activateCalls).toEqual([[enterpriseIdentity, 'github.example.com#cli:42']]);
    expect(tokenCalls).toEqual([]);
  });

  test('shows the activated gh login as the current cli account with no Use offer left', async () => {
    setStatus({
      ...enterpriseIdentity,
      status: 'connected',
      connected: true,
      user: { ...enterpriseIdentity, id: '42', username: 'octocat' },
      accounts: [account('github.example.com#cli:42', 'cli', true)],
      cli: { available: true, disabled: false, active: true, user: { ...enterpriseIdentity, id: '42', username: 'octocat' } },
    });

    const tree = await renderSettled();
    expect(findButton(tree, 'settings.github.enterprise.actions.useCli')).toBeNull();
    expect(textOf(tree)).toContain('settings.github.enterprise.actions.disableCli');
    expect(textOf(tree)).toContain('settings.sourceControl.accounts.inUse');
  });

  test('keeps the turn-on affordance reachable before connection when the host gh is switched off', async () => {
    setStatus({
      ...enterpriseIdentity,
      status: 'disconnected',
      connected: false,
      accounts: [],
      cli: { available: false, disabled: true, active: false },
    });

    const tree = await renderSettled();
    const enable = findButton(tree, 'settings.github.enterprise.actions.enableCli');
    expect(enable).not.toBeNull();

    enable!.props.onClick?.();
    await flush();
    expect(cliDisabledCalls).toEqual([[enterpriseIdentity, false]]);
  });

  test('keeps the gh switch visible after connecting via PAT', async () => {
    setStatus({
      ...enterpriseIdentity,
      status: 'connected',
      connected: true,
      user: { ...enterpriseIdentity, id: 'pat-1', username: 'octocat' },
      accounts: [account('pat-1', 'pat')],
      cli: { available: true, disabled: false, active: false },
    });

    const tree = await renderSettled();
    expect(textOf(tree)).toContain('settings.github.enterprise.actions.disableCli');

    const disable = findButton(tree, 'settings.github.enterprise.actions.disableCli');
    disable!.props.onClick?.();
    await flush();
    expect(cliDisabledCalls).toEqual([[enterpriseIdentity, true]]);
  });

  test('hides the switch row entirely when the host has no gh login', async () => {
    setStatus({
      ...enterpriseIdentity,
      status: 'connected',
      connected: true,
      user: { ...enterpriseIdentity, id: 'pat-1', username: 'octocat' },
      accounts: [account('pat-1', 'pat')],
      cli: { available: true, disabled: false, active: false },
    });

    const withoutCli = await renderSettled();
    expect(findButton(withoutCli, 'settings.github.enterprise.actions.disableCli')).not.toBeNull();
    expect(textOf(withoutCli)).toContain('settings.sourceControl.actions.remove');

    cliDisabledCalls = [];
    setStatus({
      ...enterpriseIdentity,
      status: 'connected',
      connected: true,
      user: { ...enterpriseIdentity, id: 'pat-1', username: 'octocat' },
      accounts: [account('pat-1', 'pat')],
    });

    const tree = await renderSettled();
    expect(findButton(tree, 'settings.github.enterprise.actions.disableCli')).toBeNull();
    expect(textOf(tree)).toContain('settings.sourceControl.actions.remove');
  });

  const findInput = (node: TestNode): ElementNode | null => {
    if (node == null || node === true || node === false) return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findInput(child);
        if (found) return found;
      }
      return null;
    }
    if (node instanceof Object && node.type === 'input') return node;
    return node instanceof Object ? findInput(node.props.children) : null;
  };

  test('keeps the PAT connect flow while the pre-PAT gh offer is listed', async () => {
    setStatus({
      ...enterpriseIdentity,
      status: 'disconnected',
      connected: false,
      accounts: [account('github.example.com#cli:42', 'cli', false)],
      cli: { available: true, disabled: false, active: false },
    });

    const first = await renderSettled();
    const addAccount = findButton(first, 'settings.github.page.actions.addAccount');
    expect(addAccount).not.toBeNull();
    addAccount!.props.onClick?.();
    const afterAdd = await renderSettled();
    findInput(afterAdd)!.props.onChange?.({ target: { value: 'ghp_example' } });
    const afterTyping = await renderSettled();
    const save = findButton(afterTyping, 'settings.common.actions.saveChanges');
    expect(save).not.toBeNull();

    save!.props.onClick?.();
    await flush();
    expect(tokenCalls).toEqual(['ghp_example']);
  });
});
