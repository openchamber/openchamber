import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { SpaceMcpAccess } from './SpaceMcpAccess';

const entry: SpaceEntry = {
  id: 'a1b2c3d4e5f6', kind: 'host', name: 'Work', placeId: 'host', machine: null,
  projectDirectory: '/project', projectFolder: { path: '/project', found: true }, directory: '/spaces/a1b2c3d4e5f6/project',
  state: 'running', stoppedIdle: false, step: null, failure: null, network: { mode: 'allowlist', domains: [] },
  grants: [], access: null, needsAccess: [], accessFailures: [{ provider: 'openai', code: 'secret_source_missing', message: 'Missing' }], damage: null, setup: null,
};
const connection = 'pmcp_0123456789abcdef';
const status = {
  host: { supported: true }, selections: null, selectionsError: null,
  service: { state: 'available', status: { administration: 'separate', enforcement: { status: 'protected', findings: [] }, connections: [
    { id: connection, name: 'github', revision: 1, enabled: true, transport: 'http', credential: 'stored', target: { kind: 'url', label: 'https://mcp.test' } },
  ] } },
};
const fetch = spyOn(globalThis, 'fetch');
const globals = new Map<string, PropertyDescriptor | undefined>();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  const window = new Window({ url: 'http://localhost:3000/' });
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useI18nStore.setState({ locale: 'en', dictionary: dict, loadingLocale: null });
  useSpacesStore.getState().resetForRuntimeSwitch();
  fetch.mockResolvedValue(Response.json(status));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetch.mockReset();
  useSpacesStore.getState().resetForRuntimeSwitch();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});
const render = async (space: SpaceEntry) => {
  await act(async () => root.render(<I18nProvider><SpaceMcpAccess entry={space} /></I18nProvider>));
};

describe('MCP access by place', () => {
  it('offers no grant button or protected-status request for Docker spaces', async () => {
    // Given / When
    await render({ ...entry, kind: 'docker', placeId: 'docker' });
    // Then
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain(dict['spaces.access.mcp.dockerOnly']);
  });

  it.each(['host', 'host-root'] as const)('grants a protected connection on %s without clearing model failures', async (kind) => {
    // Given
    const space = { ...entry, kind, placeId: kind };
    useSpacesStore.getState().addJourneyEntry(space);
    await render(space);
    const grant = { id: 'mcp-github', kind: 'mcp', connection, name: 'github' };
    fetch.mockResolvedValue(Response.json({ grant }));
    const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === dict['spaces.access.mcp.give']);
    if (!button) throw new Error('Missing grant action');
    // When
    await act(async () => button.click());
    // Then
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ kind: 'mcp', connection, name: 'github' }) });
    expect(useSpacesStore.getState().journey?.get(entry.id)?.grants).toEqual([grant]);
    expect(useSpacesStore.getState().journey?.get(entry.id)?.accessFailures).toEqual(entry.accessFailures);
  });

  it('keeps a granted connection visible after it disappears from protected status, without revocation', async () => {
    // Given / When
    await render({ ...entry, grants: [{ id: 'gone', kind: 'mcp', connection: 'pmcp_gone', name: 'retained' }] });
    // Then
    expect(container.textContent).toContain('retained');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent).toContain(dict['spaces.access.mcp.irreversible']);
  });

  it.each(['missing', 'unknown'] as const)('allows re-granting a recorded MCP connection whose access is %s', async (access) => {
    // Given
    const grant = { id: 'mcp-github', kind: 'mcp' as const, connection, name: 'github' };
    const space: SpaceEntry = { ...entry, grants: [grant], access: access === 'unknown' ? 'unknown' : 'granted', needsAccess: access === 'missing' ? [grant.id] : [] };
    useSpacesStore.getState().addJourneyEntry(space);
    await render(space);
    expect(container.textContent).not.toContain(dict['spaces.access.mcp.given']);
    expect(container.textContent).toContain(dict[access === 'missing' ? 'spaces.access.model.none' : 'spaces.group.access.unknown']);
    const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === dict['spaces.access.mcp.give']);
    if (!button) throw new Error('Missing re-grant action');
    fetch.mockResolvedValue(Response.json({ grant }));
    // When
    await act(async () => button.click());
    // Then
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ kind: 'mcp', connection, name: 'github' }) });
    expect(useSpacesStore.getState().journey?.get(entry.id)?.needsAccess).toEqual([]);
    expect(useSpacesStore.getState().journey?.get(entry.id)?.accessFailures).toEqual(entry.accessFailures);
  });
});
