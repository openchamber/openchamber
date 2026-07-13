import { describe, expect, test } from 'bun:test';

import { generateHostId, mergeDescriptor, normalizeDescriptor } from './host-registry';
import type { HostDescriptor, HostId } from './types';

describe('host-registry', () => {
  test('generateHostId returns unique ids', () => {
    const a = generateHostId();
    const b = generateHostId();
    expect(a).not.toBe(b);
    expect(a.startsWith('host_')).toBe(true);
  });

  test('normalizeDescriptor fills defaults', () => {
    const desc = normalizeDescriptor({});
    expect(desc.hostId).toBeTruthy();
    expect(desc.label).toBeTruthy();
    expect(desc.transport.kind).toBe('direct');
  });

  test('normalizeDescriptor preserves provided values', () => {
    const desc = normalizeDescriptor({
      hostId: 'h1' as HostId,
      label: 'My Host',
      transport: { kind: 'ssh', sshEndpoint: 'http://localhost:3000' },
    });
    expect(desc.hostId).toBe('h1');
    expect(desc.label).toBe('My Host');
    expect(desc.transport.kind).toBe('ssh');
    if (desc.transport.kind === 'ssh') {
      expect(desc.transport.sshEndpoint).toBe('http://localhost:3000');
    }
  });

  test('mergeDescriptor only overwrites provided fields', () => {
    const existing: HostDescriptor = {
      hostId: 'h1' as HostId,
      label: 'Original',
      transport: { kind: 'direct', apiUrl: 'http://old', requestHeaders: { 'X-Old': '1' } },
    };
    const merged = mergeDescriptor(existing, { label: 'Updated' });
    expect(merged.hostId).toBe('h1');
    expect(merged.label).toBe('Updated');
    expect(merged.transport.kind).toBe('direct');
    if (merged.transport.kind === 'direct') {
      expect(merged.transport.apiUrl).toBe('http://old');
      expect(merged.transport.requestHeaders).toEqual({ 'X-Old': '1' });
    }
  });

  test('mergeDescriptor deep-copies requestHeaders', () => {
    const headers = { 'X-Test': '1' };
    const existing: HostDescriptor = {
      hostId: 'h1' as HostId,
      label: 'H',
      transport: { kind: 'direct', apiUrl: 'http://test', requestHeaders: headers },
    };
    const merged = mergeDescriptor(existing, { transport: { kind: 'direct', apiUrl: 'http://test', requestHeaders: { 'X-New': '2' } } });
    if (merged.transport.kind === 'direct') {
      expect(merged.transport.requestHeaders).toEqual({ 'X-New': '2' });
      // Ensure mutation isolation.
      merged.transport.requestHeaders!['X-Evil'] = '3';
      if (existing.transport.kind === 'direct') {
        expect(existing.transport.requestHeaders!['X-Evil']).toBe(undefined);
      }
    }
  });
});
