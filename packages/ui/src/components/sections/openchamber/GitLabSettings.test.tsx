import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, SourceControlAPI, SourceControlAuthStatus, SourceControlIdentity } from '@/lib/api/types';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

const firstInstance = 'https://gitlab.first.example';
const secondInstance = 'https://gitlab.second.example';
const identityFor = (instance: string): SourceControlIdentity => ({ provider: 'gitlab', instance });
const unexpected = (): never => { throw new Error('Unexpected runtime API access'); };

describe('GitLab CLI instance registration', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const savedInstances = new Set<string>();
  let instanceReads = 0;
  let activationFails = false;
  let discoveryFails = false;
  let beforeActivation = async () => {};

  const statusFor = (identity: SourceControlIdentity): SourceControlAuthStatus => {
    const current = savedInstances.has(identity.instance);
    const user = { ...identity, id: 'user-one', username: 'cli-user' };
    const accounts = identity.instance === 'https://gitlab.com' ? [] : [{
      id: `${identity.instance}#cli:user-one`,
      credentialId: `${identity.instance}#cli:user-one`,
      credentialRevision: 1,
      providerUserId: `${identity.instance}#user-one`,
      providerUserStatus: 'available' as const,
      user,
      current,
      source: 'cli' as const,
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
      return [identityFor('https://gitlab.com'), ...[...savedInstances].map(identityFor)];
    },
    capabilities: async (identity) => ({
      identity, authentication: true, multipleAccounts: true,
      authenticationMethods: { device: { available: false }, pat: { available: true }, cli: { available: true } },
      projects: true, issues: true, changeRequests: true, draftChangeRequests: true,
      mergeChangeRequests: true, ci: true,
    }),
    authStatus: async (identity) => statusFor(identity),
    authActivate: async (identity) => {
      await beforeActivation();
      if (activationFails) throw new Error('CLI activation failed');
      savedInstances.add(identity.instance);
      return statusFor(identity);
    },
    repositoryContext: unexpected, repositoryBinding: unexpected, resetRepositoryBinding: unexpected,
    repositoryProviderBindingMutate: unexpected, authStart: unexpected, authComplete: unexpected,
    authSetToken: unexpected, authDisconnect: unexpected, authSetCliDisabled: unexpected,
    changeRequestStatus: unexpected, changeRequestCreate: unexpected, changeRequestUpdate: unexpected,
    changeRequestMerge: unexpected, changeRequestReady: unexpected, changeRequestComment: unexpected,
    changeRequestStartThread: unexpected, changeRequestReplyToThread: unexpected, changeRequestResolveThread: unexpected,
    changeRequestReview: unexpected, issueComment: unexpected, changeRequestSetState: unexpected,
    issueSetState: unexpected, changeRequestSetLabels: unexpected, issueSetLabels: unexpected,
    changeRequestSetReviewers: unexpected, refreshProviderReads: unexpected, referenceLabels: unexpected,
    referenceReviewers: unexpected, changeRequestsList: unexpected, changeRequestContext: unexpected,
    issuesList: unexpected, issueGet: unexpected, issueComments: unexpected, projectUpstream: unexpected,
    projectBranches: unexpected, githubReferences: unexpected, githubReferenceDetail: unexpected,
    githubPullStatuses: unexpected,
  };
  const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isVSCode: false, isDesktop: false }, sourceControl,
    get git() { return unexpected(); }, get terminal() { return unexpected(); },
    get files() { return unexpected(); }, get settings() { return unexpected(); },
    get permissions() { return unexpected(); }, get notifications() { return unexpected(); },
  };

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
    instanceReads = 0;
    activationFails = false;
    discoveryFails = false;
    beforeActivation = async () => {};
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

  const mount = async () => {
    const { createRoot } = await import('react-dom/client');
    const { GitLabSettings } = await import('./GitLabSettings');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(<I18nProvider><TooltipProvider><GitLabSettings /></TooltipProvider></I18nProvider>);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!trigger) throw new Error('Missing GitLab card trigger');
    await act(async () => { trigger.click(); });
  };

  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    await act(async () => { button.click(); });
  };

  const addInstance = async (instance: string) => {
    await click('Add instance');
    const input = container.querySelector<HTMLInputElement>('input[placeholder="https://gitlab.example.com"]');
    if (!input) throw new Error('Missing instance input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, instance);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Use instance');
  };

  test('keeps an activated CLI instance visible when a second custom domain is added', async () => {
    await mount();
    await addInstance(firstInstance);
    await click('Use');

    expect(savedInstances.has(firstInstance)).toBe(true);
    expect(instanceReads).toBe(2);
    expect(useSourceControlAuthStore.getState().identities).toEqual([
      identityFor('https://gitlab.com'), identityFor(firstInstance),
    ]);

    await addInstance(secondInstance);
    expect(container.textContent).toContain('gitlab.first.example');
    expect(container.textContent).toContain('gitlab.second.example');
    await click('Use');
    expect(instanceReads).toBe(3);
    expect(useSourceControlAuthStore.getState().identities).toEqual([
      identityFor('https://gitlab.com'), identityFor(firstInstance), identityFor(secondInstance),
    ]);

    await act(async () => { root?.unmount(); });
    useSourceControlAuthStore.getState().resetForRuntimeSwitch();
    await mount();
    expect(container.textContent).toContain('gitlab.first.example');
    expect(container.textContent).toContain('gitlab.second.example');
  });

  test('keeps a failed activation available for retry without refreshing instances', async () => {
    await mount();
    await addInstance(firstInstance);
    activationFails = true;
    await click('Use');
    expect(savedInstances.size).toBe(0);
    expect(instanceReads).toBe(1);
    expect(container.textContent).toContain('gitlab.first.example');

    activationFails = false;
    await click('Use');
    await addInstance(secondInstance);
    expect(container.textContent).toContain('gitlab.first.example');
    expect(container.textContent).toContain('gitlab.second.example');
  });

  test('retains the temporary instance when discovery fails after successful activation', async () => {
    await mount();
    await addInstance(firstInstance);
    discoveryFails = true;
    await click('Use');
    expect(savedInstances.has(firstInstance)).toBe(true);
    expect(instanceReads).toBe(2);
    expect(useSourceControlAuthStore.getState().identitiesError).toBe('Instance discovery failed');
    expect(container.textContent).toContain('gitlab.first.example');
    expect(container.textContent).toContain('cli-user');
  });

  test('ignores an activation that finishes after a runtime round trip', async () => {
    await mount();
    await addInstance(firstInstance);
    let finishActivation = () => {};
    const pendingActivation = new Promise<void>((resolve) => { finishActivation = resolve; });
    beforeActivation = () => pendingActivation;
    await click('Use');

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
});
