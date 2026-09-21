import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import type { GitAPI, GitManagedSshIntent, GitManagedSshResult, RuntimeAPIs } from '@/lib/api/types';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { ManagedSshCredentials } from './ManagedSshCredentials';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';

const inventory: GitManagedSshResult = { status: 'available',
  credentials: [{ credentialId: 'ocgit:v1:ssh:a2V5X29uZQ', label: 'SSH', fingerprint: `SHA256:${'a'.repeat(43)}`, capability: { status: 'ready' } }],
};
const candidate = { candidateId: 'ssh_candidate_one', label: 'id_ed25519', fingerprint: `SHA256:${'b'.repeat(43)}`,
  capability: { status: 'ready' as const } };
const discovery: GitManagedSshResult = { status: 'discovered', candidates: [candidate], truncated: false };
const importedCredential = { credentialId: 'ocgit:v1:ssh:aW1wb3J0ZWQ', label: 'SSH', fingerprint: candidate.fingerprint,
  capability: { status: 'ready' as const } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const descendants = (node: React.ReactNode): React.ReactElement<{ children?: React.ReactNode }>[] => {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node, ...descendants(node.props.children)];
};

const mount = async () => {
  class TestWindow extends EventTarget {
    HTMLIFrameElement = class {};
    __OPENCHAMBER_API_BASE_URL__ = 'https://runtime-a.example.com';
  }
  const runtimeWindow = new TestWindow();
  const document = Object.assign(new EventTarget(), { nodeType: 9, defaultView: runtimeWindow, activeElement: null, documentElement: { lang: '' } });
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml' });
  Object.defineProperty(container, 'ownerDocument', { value: document });
  const globals: Array<[string, PropertyDescriptor]> = [
    ['window', { value: runtimeWindow, configurable: true }], ['document', { value: document, configurable: true }],
    ['IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true }],
  ];
  const previous = globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, descriptor] of globals) Object.defineProperty(globalThis, key, descriptor);
  // SAFETY: The probe renders null; the container implements React root setup and event members.
  const root = createRoot(container as Element);
  const calls: GitManagedSshIntent[] = [];
  let pending: { resolve: (result: GitManagedSshResult) => void; reject: (error: Error) => void } | undefined;
  const managedSshCredentials: NonNullable<GitAPI['managedSshCredentials']> = async (intent) => {
    calls.push(intent);
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  };
  const unused = (): never => { throw new Error('Unexpected API access'); };
  // Only the inventory API is reachable in this probe. Any provider access fails the test.
  const git = new Proxy({ managedSshCredentials }, { get: (target, key) => key === 'managedSshCredentials' ? target.managedSshCredentials : unused });
  // SAFETY: Every other Git method is a throwing function supplied by the proxy above.
  const gitApi = git as GitAPI;
  const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isVSCode: false, isDesktop: false }, git: gitApi,
    get sourceControl() { return unused(); }, get terminal() { return unused(); }, get files() { return unused(); },
    get settings() { return unused(); }, get permissions() { return unused(); }, get notifications() { return unused(); }, get tools() { return unused(); },
  };
  let view: React.ReactNode;
  let selected = '';
  // Run the real component hooks, retaining its element tree without mounting platform UI controls.
  const Probe = () => {
    const [value, onChange] = React.useState('');
    selected = value;
    view = ManagedSshCredentials({ selection: { value, onChange } });
    return null;
  };
  await act(async () => { root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><Probe /></I18nProvider></RuntimeAPIContext.Provider>); });
  let mounted = true;
  const unmount = () => { if (mounted) { act(() => root.unmount()); mounted = false; } };
  cleanups.push(() => {
    unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    calls, unmount,
    get selected() { return selected; },
    get picker() {
      const picker = descendants(view).find((node) => node.type === Select);
      if (!React.isValidElement<{ disabled?: boolean; onValueChange: (value: string) => void }>(picker)) throw new Error('Missing picker');
      return picker.props;
    },
    get confirmation() {
      const checkbox = descendants(view).find((node) => node.type === SettingsCheckboxRow);
      if (!React.isValidElement<{ checked: boolean; onChange: (checked: boolean) => void }>(checkbox)) throw new Error('Missing confirmation');
      return checkbox.props;
    },
    button: (label: string) => {
      const button = descendants(view).find((node) => node.type === Button && node.props.children === label);
      if (!React.isValidElement<{ disabled?: boolean; onClick: () => void }>(button)) throw new Error('Missing button');
      return button.props;
    },
    click: async (label: string) => {
      const button = descendants(view).find((node) => node.type === Button && node.props.children === label);
      if (!React.isValidElement<{ disabled?: boolean; onClick: () => void }>(button) || button.props.disabled) throw new Error('Button unavailable');
      await act(async () => { button.props.onClick(); });
    },
    resolve: async (result: GitManagedSshResult = inventory) => {
      if (!pending) throw new Error('No pending inventory request');
      await act(async () => { pending?.resolve(result); });
    },
    reject: async () => {
      if (!pending) throw new Error('No pending inventory request');
      await act(async () => { pending?.reject(new Error('offline')); });
    },
    switchRuntime: () => act(() => {
      runtimeWindow.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
      runtimeWindow.__OPENCHAMBER_API_BASE_URL__ = 'https://runtime-b.example.com';
    }),
  };
};

describe('managed SSH inventory UI lifecycle', () => {
  test('mount stays idle and import requires explicit confirmation of the discovered fingerprint', async () => {
    const fixture = await mount();
    expect(fixture.calls).toEqual([]);
    expect(fixture.picker.disabled).toBe(true);
    await fixture.click('Load server keys');
    expect(fixture.calls).toEqual([{ operation: 'inventory' }]);
    await fixture.resolve();
    expect(fixture.picker.disabled).toBe(false);
    expect(fixture.selected).toBe('');
    act(() => fixture.picker.onValueChange?.('ocgit:v1:ssh:a2V5X29uZQ'));
    expect(fixture.selected).toBe('ocgit:v1:ssh:a2V5X29uZQ');
    await fixture.click('Discover host keys');
    await fixture.resolve(discovery);
    expect(fixture.calls).toEqual([{ operation: 'inventory' }, { operation: 'discover' }]);
    expect(fixture.button('Import key').disabled).toBe(true);
    expect(fixture.confirmation.checked).toBe(false);
    act(() => fixture.confirmation.onChange(true));
    expect(fixture.button('Import key').disabled).toBe(false);
    await fixture.click('Import key');
    expect(fixture.calls[2]).toEqual({ operation: 'import', candidateId: candidate.candidateId,
      expectedFingerprint: candidate.fingerprint, confirmed: true });
    await fixture.resolve({ status: 'imported', credentials: [...inventory.credentials, importedCredential],
      selectedCredential: importedCredential });
    expect(fixture.selected).toBe(importedCredential.credentialId);
  });

  test('runtime switching clears selection and rejects a late response without automatic reload', async () => {
    const fixture = await mount();
    await fixture.click('Load server keys');
    await fixture.resolve();
    act(() => fixture.picker.onValueChange?.('ocgit:v1:ssh:a2V5X29uZQ'));
    fixture.switchRuntime();
    expect(fixture.selected).toBe('');
    expect(fixture.picker.disabled).toBe(true);
    expect(fixture.calls).toHaveLength(1);
    await fixture.click('Load server keys');
    fixture.switchRuntime();
    await fixture.resolve();
    expect(fixture.picker.disabled).toBe(true);
    expect(fixture.calls).toHaveLength(2);
  });

  test('read failure disables retained data and can be retried; unmount discards late reads', async () => {
    const fixture = await mount();
    await fixture.click('Load server keys');
    await fixture.resolve();
    await fixture.click('Load server keys');
    await fixture.reject();
    expect(fixture.picker.disabled).toBe(true);
    await fixture.click('Load server keys');
    fixture.unmount();
    await fixture.resolve();
    expect(fixture.calls).toHaveLength(3);
  });

  test('a rejected import keeps discovery explicit and allows a fresh discovery retry', async () => {
    const fixture = await mount();
    await fixture.click('Discover host keys');
    await fixture.resolve(discovery);
    act(() => fixture.confirmation.onChange(true));
    await fixture.click('Import key');
    await fixture.resolve({ status: 'rejected', reason: 'candidate-changed' });
    expect(fixture.selected).toBe('');
    await fixture.click('Discover host keys');
    expect(fixture.calls).toEqual([
      { operation: 'discover' },
      { operation: 'import', candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true },
      { operation: 'discover' },
    ]);
  });
});
