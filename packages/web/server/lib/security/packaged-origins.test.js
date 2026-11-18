import { describe, expect, test } from 'bun:test';
import {
  PACKAGED_CLIENT_ORIGINS,
  buildCorsOriginSet,
  buildFrameAncestorsPolicy,
  createRequestSecurityRuntime,
} from './request-security.js';

const createRuntime = () => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
});

describe('packaged client origins', () => {
  test('the CORS allowlist, the socket check and the frame policy share one list', async () => {
    const runtime = createRuntime();
    const cors = buildCorsOriginSet();
    const framePolicy = buildFrameAncestorsPolicy();

    for (const origin of PACKAGED_CLIENT_ORIGINS) {
      expect(cors.has(origin)).toBe(true);
      expect(framePolicy).toContain(origin);
      expect(await runtime.isRequestOriginAllowed({
        headers: { origin, host: '192.168.1.130:1202' },
        socket: {},
      })).toBe(true);
    }
  });

  test('plain http localhost stays a CORS client and never a socket origin', async () => {
    const runtime = createRuntime();

    expect(buildCorsOriginSet().has('http://localhost')).toBe(true);
    expect(PACKAGED_CLIENT_ORIGINS).not.toContain('http://localhost');
    expect(await runtime.isRequestOriginAllowed({
      headers: { origin: 'http://localhost', host: '192.168.1.130:1202' },
      socket: {},
    })).toBe(false);
  });
});