import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GUEST_PROJECT_ICON_MAX_BYTES } from '@openchamber/sdk';

import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';

const runtimeFetchModule = await import('@/lib/runtime-fetch');

type FetchCall = { path: string; init?: RequestInit & { query?: URLSearchParams } };
let calls: FetchCall[] = [];
let response: Response = new Response(null, { status: 200 });

mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
  runtimeFetch: async (path: string, init?: RequestInit & { query?: URLSearchParams }) => {
    calls.push({ path, init });
    return response;
  },
}));

const { readGuestProjectIcon } = await import('./project-icon');

const project = (overrides: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id: 'p1',
  path: '/repo',
  label: 'Repo',
  addedAt: 1,
  icon: 'code',
  color: 'primary',
  ...overrides,
});

beforeEach(() => {
  calls = [];
  response = new Response(null, { status: 200 });
  useProjectsStore.setState({
    hasServerSnapshot: true,
    serverSnapshotFailed: false,
    projects: [project()],
  });
});

describe('readGuestProjectIcon', () => {
  test('returns the preset symbol and resolved colour without an image', async () => {
    const icon = await readGuestProjectIcon('p1');
    expect(icon).toEqual({
      kind: 'symbol', symbol: 'code', color: 'var(--primary)',
    });
    expect(calls).toHaveLength(0);
  });

  test('returns the custom image as a data URL and keeps its background', async () => {
    useProjectsStore.setState({
      projects: [project({
        iconImage: { mime: 'image/svg+xml', updatedAt: 7, source: 'custom' },
        iconBackground: '#112233',
      })],
    });
    response = new Response(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    });

    const icon = await readGuestProjectIcon('p1', { themeVariant: 'dark', iconColor: '#ffffff' });
    expect(icon.kind).toBe('image');
    if (icon.kind !== 'image') return;
    expect(icon.mime).toBe('image/svg+xml');
    expect(icon.background).toBe('#112233');
    expect(icon.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/projects/p1/icon');
    expect(calls[0]?.init?.query?.get('v')).toBe('7');
    expect(calls[0]?.init?.query?.get('theme')).toBe('dark');
    expect(calls[0]?.init?.query?.get('iconColor')).toBe('#ffffff');
  });

  test('falls back to the preset when the image route refuses', async () => {
    useProjectsStore.setState({
      projects: [project({ iconImage: { mime: 'image/png', updatedAt: 9, source: 'custom' } })],
    });
    response = new Response(null, { status: 404 });

    const icon = await readGuestProjectIcon('p1');
    expect(icon).toEqual({
      kind: 'symbol', symbol: 'code', color: 'var(--primary)',
    });
  });

  test('falls back to the preset when the image is too large to send', async () => {
    useProjectsStore.setState({
      projects: [project({ iconImage: { mime: 'image/png', updatedAt: 9, source: 'custom' } })],
    });
    response = new Response(new Blob([new Uint8Array(GUEST_PROJECT_ICON_MAX_BYTES + 1)], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });

    const icon = await readGuestProjectIcon('p1');
    expect(icon).toEqual({
      kind: 'symbol', symbol: 'code', color: 'var(--primary)',
    });
  });

  test('reports an unregistered project', async () => {
    await expect(readGuestProjectIcon('missing')).rejects.toThrow('Project is not registered.');
  });
});
