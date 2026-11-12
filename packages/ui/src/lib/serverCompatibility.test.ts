import { describe, expect, test } from 'bun:test';
import { fetchConnectedServerVersion, isServerBeforeOpenCode2 } from './serverCompatibility';

const answer = (status: number, body: string) => async () => new Response(body, { status });

describe('isServerBeforeOpenCode2', () => {
  test('flags only a server whose major version is below 2', () => {
    expect(isServerBeforeOpenCode2('1.24.2')).toBe(true);
    expect(isServerBeforeOpenCode2('0.9.0')).toBe(true);
    expect(isServerBeforeOpenCode2('2.0.0')).toBe(false);
    expect(isServerBeforeOpenCode2('2.1.1')).toBe(false);
    expect(isServerBeforeOpenCode2('10.0.0')).toBe(false);
  });

  test('does not flag a version it cannot read', () => {
    expect(isServerBeforeOpenCode2('unknown')).toBe(false);
    expect(isServerBeforeOpenCode2('')).toBe(false);
  });
});

describe('fetchConnectedServerVersion', () => {
  const signal = new AbortController().signal;

  test('reads the version the server reports', async () => {
    expect(await fetchConnectedServerVersion(signal, answer(200, JSON.stringify({ status: 'ok', openchamberVersion: ' 1.24.2 ' }))))
      .toBe('1.24.2');
  });

  test('says nothing for a failed request, a web page, or a missing field', async () => {
    expect(await fetchConnectedServerVersion(signal, answer(500, '{}'))).toBeNull();
    expect(await fetchConnectedServerVersion(signal, answer(200, '<!doctype html>'))).toBeNull();
    expect(await fetchConnectedServerVersion(signal, answer(200, JSON.stringify({ status: 'ok' })))).toBeNull();
  });
});
