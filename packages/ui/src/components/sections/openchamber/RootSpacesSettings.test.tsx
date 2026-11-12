import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { SpacePlace } from '@/lib/spaces/spaces-api';
import type { RootPasskeyDependencies } from '@/lib/spaces/root-activation';
import { RootSpacesSettings } from './RootSpacesSettings';

const place: SpacePlace = {
  id: 'host-root', kind: 'host-root', machine: null, available: true, hostIsolation: false, version: '', setup: null,
  rootActivation: { available: false, reason: 'no_passkey_approved', origins: [] },
};
const fetch = spyOn(globalThis, 'fetch');
const passkeys: RootPasskeyDependencies = {
  authenticate: async () => ({ id: 'sign-in', rawId: 'sign-in', type: 'public-key', clientExtensionResults: {}, response: { authenticatorData: 'data', clientDataJSON: 'client', signature: 'sig' } }),
  origin: () => 'http://localhost:3000',
};
const authentication = spyOn(passkeys, 'authenticate');
const globals = new Map<string, PropertyDescriptor | undefined>();
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  const window = new Window({ url: 'http://localhost:3000/' });
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  useI18nStore.setState({ locale: 'en', dictionary: dict, loadingLocale: null });
  fetch.mockResolvedValue(Response.json({ available: false, reason: 'no_passkey_approved', passkeys: [] }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); fetch.mockReset(); authentication.mockReset();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});
const render = async (value: SpacePlace | null = place) => {
  await act(async () => root.render(<I18nProvider><RootSpacesSettings place={value} onRecheck={() => {}} rootPasskey={passkeys} /></I18nProvider>));
};
const enter = async (label: string, value: string) => {
  const input = Array.from(container.querySelectorAll('input')).find((input) => input.getAttribute('aria-label') === label);
  if (!input) throw new Error(`Missing field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
  if (!button) throw new Error(`Missing action ${label}`);
  await act(async () => button.click());
};
const beginApproval = async () => {
  await enter(dict['settings.openchamber.spaces.root.code'], 'ABCD-EFGH');
  await enter(dict['settings.openchamber.spaces.root.label'], 'My key');
  fetch.mockResolvedValueOnce(Response.json({ challenge: 'approval', rpID: 'localhost', allowCredentials: [{ id: 'sign-in', label: 'My key' }] }))
    .mockResolvedValueOnce(Response.json({ awaitingConfirmation: true, fingerprint: 'FINGERPRINT-1234', label: 'My key', origin: 'http://localhost' }));
  authentication.mockResolvedValue({ id: 'sign-in', rawId: 'sign-in', type: 'public-key', clientExtensionResults: {}, response: { authenticatorData: 'data', clientDataJSON: 'client', signature: 'sig' } });
  await click(dict['settings.openchamber.spaces.root.approve']);
};

describe('root passkeys in Settings', () => {
  it('makes no unsupported endpoint call on a host that has no root place', async () => {
    // Given / When
    await render(null);
    // Then
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('shows the fingerprint as awaiting terminal confirmation after the ceremony', async () => {
    // Given
    await render();
    // When
    await beginApproval();
    // Then
    expect(container.textContent).toContain(dict['settings.openchamber.spaces.root.confirm']);
    expect(container.textContent).toContain('FINGERPRINT-1234');
    expect(container.textContent).not.toContain(dict['settings.openchamber.spaces.root.available']);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(fetch.mock.calls.map(([path]) => String(path))).toEqual([
      '/api/openchamber/spaces/root-passkeys', '/api/openchamber/spaces/root-passkeys/approval-challenge', '/api/openchamber/spaces/root-passkeys/approval',
    ]);
  });

  it('keeps terminal confirmation pending until both fingerprint and exact origin are approved', async () => {
    // Given
    await render();
    await beginApproval();
    const approved = {
      id: 'key-id', label: 'My key', origin: 'http://localhost:8080', rpID: 'localhost', approvedAt: '2026-11-06', fingerprint: 'FINGERPRINT-1234',
    };
    fetch.mockResolvedValue(Response.json({ available: true, reason: null, passkeys: [approved] }));
    // When
    await click(dict['settings.openchamber.spaces.places.retry']);
    // Then
    expect(container.textContent).toContain(dict['settings.openchamber.spaces.root.confirm']);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    // When the same credential is approved for the requested origin
    fetch.mockResolvedValue(Response.json({ available: true, reason: null, passkeys: [{ ...approved, origin: 'http://localhost' }] }));
    await click(dict['settings.openchamber.spaces.places.retry']);
    // Then
    expect(container.textContent).not.toContain(dict['settings.openchamber.spaces.root.confirm']);
    expect(container.querySelectorAll('input')).toHaveLength(2);
  });

  it('restores code entry after an abandoned terminal confirmation without claiming approval', async () => {
    // Given
    await render();
    await beginApproval();
    const requests = fetch.mock.calls.length;
    // When
    await click(dict['settings.openchamber.spaces.root.approve']);
    // Then
    expect(fetch.mock.calls).toHaveLength(requests);
    expect(container.textContent).not.toContain(dict['settings.openchamber.spaces.root.available']);
    expect(container.querySelector('input')?.value).toBe('');
    // When
    await enter(dict['settings.openchamber.spaces.root.code'], 'IJKL-MNOP');
    fetch.mockResolvedValueOnce(Response.json({ code: 'approval_expired', message: 'Expired' }, { status: 409 }));
    await click(dict['settings.openchamber.spaces.root.approve']);
    // Then
    expect(fetch.mock.calls[requests]?.[1]?.body).toBe(JSON.stringify({ code: 'IJKL-MNOP' }));
    expect(container.textContent).toContain(dict['spaces.failure.approvalExpired']);
    expect(container.querySelectorAll('input')).toHaveLength(2);
  });

  it('shows approved key metadata and the root-only revoke command without an HTTP revoke action', async () => {
    // Given
    fetch.mockResolvedValue(Response.json({ available: true, reason: null, passkeys: [{
      id: 'key-id', label: 'Security key', origin: 'https://host.test', rpID: 'host.test', approvedAt: '2026-11-06', fingerprint: 'FINGERPRINT-5678',
    }] }));
    // When
    await render();
    // Then
    expect(container.textContent).toContain('Security key');
    expect(container.textContent).toContain('https://host.test');
    expect(container.textContent).toContain('FINGERPRINT-5678');
    expect(container.textContent).toContain("sudo openchamber-host revoke-root-passkey 'key-id'");
    expect(fetch.mock.calls).toHaveLength(1);
  });
});
