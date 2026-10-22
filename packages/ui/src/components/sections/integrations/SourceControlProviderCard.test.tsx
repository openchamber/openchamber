import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type {
  RuntimeAPIs,
  SourceControlAPI,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlIdentity,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { normalizeInstanceInput } from '@/components/sections/openchamber/sourceControlProviderSettings';

const unexpected = (): never => { throw new Error('Unexpected runtime API access'); };

describe('normalizeInstanceInput', () => {
  const origin = acmeDescriptor();
  const host = githubLikeDescriptor();

  test('reads an origin provider\'s input as an origin', () => {
    expect(normalizeInstanceInput(origin, 'forge.example.com')).toBe('https://forge.example.com');
    expect(normalizeInstanceInput(origin, ' https://Forge.Example.com/ ')).toBe('https://forge.example.com');
    expect(normalizeInstanceInput(origin, 'https://forge.example.com:8443')).toBe('https://forge.example.com:8443');
    expect(normalizeInstanceInput(origin, 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeInstanceInput(origin, 'http://127.0.0.1')).toBe('http://127.0.0.1');
  });

  test('reads a host provider\'s input as a bare host', () => {
    expect(normalizeInstanceInput(host, 'github.example.com')).toBe('github.example.com');
    expect(normalizeInstanceInput(host, 'https://GitHub.Example.com./')).toBe('github.example.com');
  });

  test('refuses what the descriptor does not allow', () => {
    for (const value of [
      '',
      'http://forge.example.com',
      'https://user:pass@forge.example.com',
      'https://forge.example.com/group',
      'https://forge.example.com/?q=1',
      'https://forge.example.com/#top',
      'ftp://forge.example.com',
    ]) {
      expect(normalizeInstanceInput(origin, value)).toBeNull();
    }
    const strict = acmeDescriptor({ instances: { ...origin.instances, allowLoopbackHttp: false, allowPort: false } });
    expect(normalizeInstanceInput(strict, 'http://localhost')).toBeNull();
    expect(normalizeInstanceInput(strict, 'https://forge.example.com:8443')).toBeNull();
    expect(normalizeInstanceInput(host, 'github.com')).toBeNull();
    expect(normalizeInstanceInput(host, 'https://github.com')).toBeNull();
    expect(normalizeInstanceInput(host, 'https://github.example.com:8443')).toBeNull();
  });
});

const capabilitiesFor = (
  identity: SourceControlIdentity,
  available: { device: boolean; pat: boolean; cli: boolean },
): SourceControlCapabilities => ({
  identity, authentication: true, multipleAccounts: true,
  authenticationMethods: {
    device: { available: available.device },
    pat: { available: available.pat },
    cli: { available: available.cli },
  },
  projects: true, issues: true, changeRequests: true, draftChangeRequests: true,
  mergeChangeRequests: true, ci: true,
});

describe('SourceControlProviderCard', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const savedInstances = new Set<string>();
  const savedTokens: Array<[string, string]> = [];
  let instanceReads = 0;
  let activationFails = false;
  let discoveryFails = false;
  let tokenAccepted = true;
  let beforeActivation = async () => {};
  let available = { device: true, pat: true, cli: true };
  let withCliLogin = true;
  // Where the listed login came from: the CLI, or a stored token.
  let accountSource: 'cli' | 'pat' = 'cli';
  let cliDisabled = false;
  // The instance the server lists before anything is added (GitLab's default).
  let listedDefault: SourceControlIdentity[] = [];
  // The provider the mounted card is for: the server lists instances per provider.
  let mountedProvider = 'gitlab';

  const statusFor = (identity: SourceControlIdentity): SourceControlAuthStatus => {
    const current = savedInstances.has(identity.instance);
    const user = { ...identity, id: 'user-one', username: 'cli-user' };
    if (cliDisabled) {
      return { ...identity, status: 'disconnected', connected: false, accounts: [], cli: { available: true, disabled: true, active: false } };
    }
    const accounts = !withCliLogin || identity.instance === 'https://gitlab.com' ? [] : [{
      id: `${identity.instance}#cli:user-one`,
      credentialId: `${identity.instance}#cli:user-one`,
      credentialRevision: 1,
      providerUserId: `${identity.instance}#user-one`,
      providerUserStatus: 'available' as const,
      user,
      current,
      source: accountSource,
      status: 'valid' as const,
    }];
    const cli = { available: accounts.length > 0, disabled: false, active: current, user };
    return current
      ? { ...identity, status: 'connected', connected: true, user, accounts, cli }
      : { ...identity, status: 'disconnected', connected: false, accounts, cli };
  };

  const sourceControl: SourceControlAPI = {
    authInstances: async () => {
      instanceReads += 1;
      if (discoveryFails) throw new Error('Instance discovery failed');
      return [...listedDefault, ...[...savedInstances].map((instance): SourceControlIdentity => ({ provider: mountedProvider, instance }))];
    },
    capabilities: async (identity) => capabilitiesFor(identity, available),
    authStatus: async (identity) => statusFor(identity),
    authActivate: async (identity) => {
      await beforeActivation();
      if (activationFails) throw new Error('CLI activation failed');
      savedInstances.add(identity.instance);
      return statusFor(identity);
    },
    authSetToken: async (identity, token) => {
      if (!tokenAccepted) throw Object.assign(new Error('Token rejected'), { code: 'INVALID_TOKEN' });
      savedTokens.push([identity.instance, token]);
      return statusFor(identity);
    },
    providers: unexpected, repositoryContext: unexpected, repositoryBinding: unexpected, resetRepositoryBinding: unexpected,
    repositoryProviderBindingMutate: unexpected, authStart: unexpected, authComplete: unexpected,
    authDisconnect: unexpected, authSetCliDisabled: unexpected,
    changeRequestStatus: unexpected, changeRequestCreate: unexpected, changeRequestUpdate: unexpected,
    changeRequestMerge: unexpected, changeRequestReady: unexpected, changeRequestComment: unexpected,
    changeRequestStartThread: unexpected, changeRequestReplyToThread: unexpected, changeRequestResolveThread: unexpected,
    changeRequestReview: unexpected, issueComment: unexpected, changeRequestSetState: unexpected,
    issueSetState: unexpected, changeRequestSetLabels: unexpected, issueSetLabels: unexpected,
    changeRequestSetReviewers: unexpected, refreshProviderReads: unexpected, referenceLabels: unexpected,
    referenceReviewers: unexpected, changeRequestsList: unexpected, changeRequestContext: unexpected,
    issuesList: unexpected, issueGet: unexpected, issueComments: unexpected, projectUpstream: unexpected,
    projectBranches: unexpected, references: unexpected, referenceDetail: unexpected,
    changeRequestListStatuses: unexpected,
  };
  const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isVSCode: false, isDesktop: false }, sourceControl,
    get git() { return unexpected(); }, get terminal() { return unexpected(); },
    get files() { return unexpected(); }, get settings() { return unexpected(); },
    get permissions() { return unexpected(); }, get notifications() { return unexpected(); },
  };

  // The server's GitLab descriptor: every method, the glab CLI, a default instance.
  const gitlab: SourceControlProviderDescriptor = {
    ...gitlabLikeDescriptor(),
    auth: { methods: ['device', 'pat', 'cli'], cliName: 'glab', cliTransport: false, token: { scopes: ['api'] } },
  };
  // A provider the UI has no code for: PAT only, no default instance, a path icon.
  const acme: SourceControlProviderDescriptor = acmeDescriptor();

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement, DocumentFragment: dom.DocumentFragment,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { configurable: true, value: 'https://runtime-a.example' });
    savedInstances.clear();
    savedTokens.length = 0;
    instanceReads = 0;
    activationFails = false;
    discoveryFails = false;
    tokenAccepted = true;
    beforeActivation = async () => {};
    available = { device: true, pat: true, cli: true };
    withCliLogin = true;
    accountSource = 'cli';
    cliDisabled = false;
    listedDefault = [{ provider: 'gitlab', instance: 'https://gitlab.com' }];
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    registerRuntimeAPIs(apis);
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    registerRuntimeAPIs(null);
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    await dom.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const mount = async (descriptor: SourceControlProviderDescriptor) => {
    mountedProvider = descriptor.id;
    if (!descriptor.instances.defaultInstance) listedDefault = [];
    const { createRoot } = await import('react-dom/client');
    const { SourceControlProviderCard } = await import('./SourceControlProviderCard');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(<I18nProvider><TooltipProvider><SourceControlProviderCard descriptor={descriptor} /></TooltipProvider></I18nProvider>);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!trigger) throw new Error('Missing provider card trigger');
    await act(async () => { trigger.click(); });
  };

  const buttonLabels = () => [...container.querySelectorAll('button')].map((entry) => entry.textContent?.trim());

  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    await act(async () => { button.click(); });
  };

  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const addInstance = async (placeholder: string, instance: string) => {
    await click('Add instance');
    const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    if (!input) throw new Error('Missing instance input');
    await type(input, instance);
    await click('Use instance');
  };

  const passwordInput = () => container.querySelector<HTMLInputElement>('input[type="password"]');

  test('names the provider by its label and draws its served mark', async () => {
    await mount(acme);
    expect(container.textContent).toContain('Acme Forge');
    expect(container.querySelector('[data-settings-item="integrations.source-control.acme"] svg path')?.getAttribute('d'))
      .toBe('M12 2L2 22h20L12 2z');
  });

  test('offers only the methods both the descriptor and the instance support', async () => {
    withCliLogin = false;
    await mount(acme);
    await addInstance('https://forge.example.com', 'forge.example.com');
    expect(container.textContent).toContain('forge.example.com');
    // The instance reports device and CLI too, but the descriptor names only a token.
    expect(passwordInput()).not.toBeNull();
    expect(buttonLabels()).not.toContain('Connect GitHub');

    await act(async () => { root?.unmount(); });
    available = { device: true, pat: false, cli: true };
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    await mount(gitlab);
    expect(buttonLabels()).toContain('Connect GitLab');
    expect(passwordInput()).toBeNull();
  });

  test('starts the token field empty, sends what was typed, and clears it once saved', async () => {
    withCliLogin = false;
    await mount(acme);
    await addInstance('https://forge.example.com', 'https://forge.example.com');
    const input = passwordInput();
    if (!input) throw new Error('Missing token input');
    expect(input.value).toBe('');
    expect(input.getAttribute('autocomplete')).toBe('off');

    tokenAccepted = false;
    await type(input, '  secret-token  ');
    await click('Save changes');
    expect(savedTokens).toEqual([]);
    expect(passwordInput()?.value).toBe('  secret-token  ');
    expect(container.textContent).toContain('did not accept that token');

    tokenAccepted = true;
    await click('Save changes');
    expect(savedTokens).toEqual([['https://forge.example.com', 'secret-token']]);
    expect(passwordInput()?.value ?? '').toBe('');
  });

  test('links to the provider\'s token page on the instance and names the scopes it needs', async () => {
    withCliLogin = false;
    await mount({ ...acme, auth: { ...acme.auth, token: { scopes: ['repo', 'read:org'], createPath: '/user/settings/applications' } } });
    await addInstance('https://forge.example.com', 'https://forge.example.com');
    expect(buttonLabels()).toContain('Create token');
    expect(container.textContent).toContain('Scopes: repo, read:org');
  });

  test('switches between sign-in methods with one form showing at a time', async () => {
    withCliLogin = false;
    await mount(gitlab);
    const chips = () => [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button[aria-pressed]')];
    // Starts on the first method the descriptor names: the device code, without a token field.
    expect(chips().map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
      ['Device code', 'true'], ['Personal access token', 'false'],
    ]);
    expect(buttonLabels()).toContain('Connect GitLab');
    expect(passwordInput()).toBeNull();

    await act(async () => { chips()[1]?.click(); });
    expect(chips()[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(passwordInput()).not.toBeNull();
    expect(buttonLabels()).not.toContain('Connect GitLab');
  });

  test('adding another account starts on the method the existing one came from', async () => {
    accountSource = 'pat';
    await mount(gitlab);
    await addInstance('https://gitlab.example.com', 'https://gitlab.first.example');
    await click('Add account');
    // The last switch is the added instance's; gitlab.com above still shows its own.
    const groups = [...container.querySelectorAll('[role="group"]')];
    const chips = [...(groups.at(-1)?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? [])];
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
      ['Device code', 'false'], ['Personal access token', 'true'],
    ]);
  });

  test('shows no method switch when the instance offers one way to connect', async () => {
    withCliLogin = false;
    available = { device: false, pat: true, cli: false };
    await mount(gitlab);
    expect(container.querySelector('[role="group"] button[aria-pressed]')).toBeNull();
    expect(passwordInput()).not.toBeNull();
  });

  test('refuses an instance the descriptor does not accept and keeps the field open', async () => {
    await mount(acme);
    await addInstance('https://forge.example.com', 'http://forge.example.com');
    expect(container.querySelector('input[placeholder="https://forge.example.com"]')).not.toBeNull();
    expect(container.textContent).toContain('Operation failed');
    expect(passwordInput()).toBeNull();
  });

  test('shows the github.com account section only for a descriptor with the special flow', async () => {
    withCliLogin = false;
    const withFlow = githubLikeDescriptor();
    await mount({ ...withFlow, instances: { ...withFlow.instances, legacyFlow: { instance: 'github.com', kind: 'github-com-device' } } });
    expect(buttonLabels()).toContain('Connect GitHub');
    expect(container.textContent).toContain('Other instances');

    await act(async () => { root?.unmount(); });
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    await mount(githubLikeDescriptor());
    expect(buttonLabels()).not.toContain('Connect GitHub');
    expect(container.textContent).not.toContain('Other instances');
  });

  test('offers no Add instance for a provider whose settings take no instance address', async () => {
    await mount(acmeDescriptor({ settings: { fields: [{ id: 'token', kind: 'personal-access-token', secret: true }] } }));
    expect(buttonLabels()).not.toContain('Add instance');

    await act(async () => { root?.unmount(); });
    await mount(acme);
    expect(buttonLabels()).toContain('Add instance');
  });

  test('asks for an update instead of a form when the descriptor names a field kind this version cannot draw', async () => {
    await mount(acmeDescriptor({
      settings: { fields: [{ id: 'instance', kind: 'instance-url', secret: false }, { id: 'region', kind: 'unknown', secret: false }] },
    }));
    expect(container.textContent).toContain('Update OpenChamber');
    expect(buttonLabels()).not.toContain('Add instance');
    expect(passwordInput()).toBeNull();
  });

  describe('CLI instance registration', () => {
    const firstInstance = 'https://gitlab.first.example';
    const secondInstance = 'https://gitlab.second.example';
    const identityFor = (instance: string): SourceControlIdentity => ({ provider: 'gitlab', instance });

    test('keeps an activated CLI instance visible when a second custom domain is added', async () => {
      await mount(gitlab);
      await addInstance('https://gitlab.example.com', firstInstance);
      await click('Use glab CLI');

      expect(savedInstances.has(firstInstance)).toBe(true);
      expect(instanceReads).toBe(2);
      expect(useSourceControlAuthStore.getState().identities).toEqual([
        identityFor('https://gitlab.com'), identityFor(firstInstance),
      ]);

      await addInstance('https://gitlab.example.com', secondInstance);
      expect(container.textContent).toContain('gitlab.first.example');
      expect(container.textContent).toContain('gitlab.second.example');
      await click('Use glab CLI');
      expect(instanceReads).toBe(3);
      expect(useSourceControlAuthStore.getState().identities).toEqual([
        identityFor('https://gitlab.com'), identityFor(firstInstance), identityFor(secondInstance),
      ]);

      await act(async () => { root?.unmount(); });
      useSourceControlAuthStore.getState().resetForRuntimeSwitch();
      await mount(gitlab);
      expect(container.textContent).toContain('gitlab.first.example');
      expect(container.textContent).toContain('gitlab.second.example');
    });

    test('keeps a failed activation available for retry without refreshing instances', async () => {
      await mount(gitlab);
      await addInstance('https://gitlab.example.com', firstInstance);
      activationFails = true;
      await click('Use glab CLI');
      expect(savedInstances.size).toBe(0);
      expect(instanceReads).toBe(1);
      expect(container.textContent).toContain('gitlab.first.example');

      activationFails = false;
      await click('Use glab CLI');
      await addInstance('https://gitlab.example.com', secondInstance);
      expect(container.textContent).toContain('gitlab.first.example');
      expect(container.textContent).toContain('gitlab.second.example');
    });

    test('retains the temporary instance when discovery fails after successful activation', async () => {
      await mount(gitlab);
      await addInstance('https://gitlab.example.com', firstInstance);
      discoveryFails = true;
      await click('Use glab CLI');
      expect(savedInstances.has(firstInstance)).toBe(true);
      expect(instanceReads).toBe(2);
      expect(useSourceControlAuthStore.getState().identitiesError).toBe('Instance discovery failed');
      expect(container.textContent).toContain('gitlab.first.example');
      expect(container.textContent).toContain('cli-user');
    });

    test('ignores an activation that finishes after a runtime round trip', async () => {
      await mount(gitlab);
      await addInstance('https://gitlab.example.com', firstInstance);
      let finishActivation = () => {};
      const pendingActivation = new Promise<void>((resolve) => { finishActivation = resolve; });
      beforeActivation = () => pendingActivation;
      await click('Use glab CLI');

      await act(async () => {
        window.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
        Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { configurable: true, value: 'https://runtime-b.example' });
        useSourceControlAuthStore.getState().resetForRuntimeSwitch();
        window.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
        Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { configurable: true, value: 'https://runtime-a.example' });
        finishActivation();
      });

      expect(instanceReads).toBe(1);
      expect(useSourceControlAuthStore.getState().entries).toEqual({});
      expect(useSourceControlAuthStore.getState().identities).toEqual([]);
    });

    test('offers the CLI switch only for a provider whose descriptor names a CLI', async () => {
      cliDisabled = true;
      await mount(gitlab);
      expect(buttonLabels()).toContain('Enable glab');

      await act(async () => { root?.unmount(); });
      useSourceControlAuthStore.getState().resetForRuntimeSwitch();
      await mount({ ...gitlab, auth: { ...gitlab.auth, methods: ['device', 'pat'], cliName: undefined } });
      expect(buttonLabels()).not.toContain('Enable glab');
    });
  });
});
