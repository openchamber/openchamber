import { describe, expect, test } from 'bun:test';
import { evaluateServerCompatibility, REQUIRED_SERVER_CAPABILITIES } from './server-compatibility';

const compatiblePayload = () => ({
  status: 'ok',
  openchamberVersion: '1.10.4',
  runtime: 'web',
  compatibility: {
    apiVersion: 1,
    minClientApiVersion: 1,
    capabilities: [...REQUIRED_SERVER_CAPABILITIES],
  },
});

describe('evaluateServerCompatibility', () => {
  test('accepts a compatible server', () => {
    const result = evaluateServerCompatibility(compatiblePayload());

    expect(result.status).toBe('compatible');
    expect(result.openchamberVersion).toBe('1.10.4');
    expect(result.runtime).toBe('web');
  });

  test('rejects invalid compatibility payloads', () => {
    expect(evaluateServerCompatibility({ status: 'ok' }).status).toBe('invalid-response');
    expect(evaluateServerCompatibility(null).status).toBe('invalid-response');
  });

  test('detects old servers and old clients', () => {
    expect(evaluateServerCompatibility({
      ...compatiblePayload(),
      compatibility: { ...compatiblePayload().compatibility, apiVersion: 1 },
    }, { clientApiVersion: 2 }).status).toBe('server-too-old');

    expect(evaluateServerCompatibility({
      ...compatiblePayload(),
      compatibility: { ...compatiblePayload().compatibility, minClientApiVersion: 2 },
    }, { clientApiVersion: 1 }).status).toBe('client-too-old');
  });

  test('detects missing required capabilities', () => {
    const result = evaluateServerCompatibility({
      ...compatiblePayload(),
      compatibility: {
        ...compatiblePayload().compatibility,
        capabilities: ['api.health.v1'],
      },
    });

    expect(result.status).toBe('missing-capability');
    expect(result.missingCapabilities).toContain('realtime.sse.v1');
  });
});
