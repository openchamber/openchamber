import { describe, expect, test } from 'bun:test';

import { isGuestApproved, requestedGuestCapabilities } from './index.ts';
import type { OpenChamberContributes, ServiceContribution } from './manifest.ts';
import { parseManifestJson } from './parse.ts';

const panel = { id: 'opencode-client', name: 'OpenCode client', icon: 'apps' };
const service: ServiceContribution = { entry: 'service/main.js', runtime: 'host', provides: ['opencode'] };
const manifest = (contributes: Partial<OpenChamberContributes>) => parseManifestJson(JSON.stringify({
  apiVersion: 1,
  contributes: { panel, ...contributes },
}));

describe('OpenCode service capability', () => {
  test('accepts a service-only role without operation declarations or a custom contribution', () => {
    const parsed = manifest({ service });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.manifest.contributes).toEqual({ panel, service });
    const requested = requestedGuestCapabilities(parsed.manifest.contributes);
    expect(requested).toEqual(['service', 'opencode']);
    expect(isGuestApproved({ requested, granted: ['service', 'opencode'] })).toBe(true);
  });

  test('preserves host-service capabilities alongside separate OpenCode approval', () => {
    const parsed = manifest({
      service: { ...service, keepRunning: true, schedule: [{ id: 'daily', cron: '0 9 * * *' }] },
      sessionControl: { content: true },
      instructions: true,
      skills: 'skills',
    });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.manifest.contributes.service).toEqual({
      ...service, keepRunning: true, schedule: [{ id: 'daily', cron: '0 9 * * *' }],
    });
    const requested = requestedGuestCapabilities(parsed.manifest.contributes);
    expect(requested).toEqual(['service', 'transcript', 'sessionControl', 'instructions', 'skills', 'opencode']);
    expect(isGuestApproved({ requested, granted: requested.filter((capability) => capability !== 'opencode') })).toBe(false);
    expect(isGuestApproved({ requested, granted: requested })).toBe(true);
  });

  test('requires OpenCode approval separately from service approval', () => {
    const parsed = manifest({ service });
    if (!parsed.ok) throw new Error(parsed.message);
    const requested = requestedGuestCapabilities(parsed.manifest.contributes);
    expect(isGuestApproved({ requested, granted: ['service'] })).toBe(false);
    expect(isGuestApproved({ requested, granted: ['opencode'] })).toBe(false);
  });

  test('keeps ordinary service approval unchanged', () => {
    const parsed = manifest({ panel: { ...panel, entry: 'panel/index.html' }, service: {
      entry: service.entry, runtime: service.runtime,
    } });
    if (!parsed.ok) throw new Error(parsed.message);
    const requested = requestedGuestCapabilities(parsed.manifest.contributes);
    expect(requested).toEqual(['service']);
    expect(isGuestApproved({ requested, granted: ['service'] })).toBe(true);
  });

  test('derives OpenCode access from the role instead of a declared capability', () => {
    expect(parseManifestJson(JSON.stringify({ apiVersion: 1, contributes: { panel, service, capabilities: ['opencode'] } })))
      .toMatchObject({ ok: false, code: 'invalid-capabilities' });
  });
});
