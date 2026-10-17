import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Server } from 'node:http';
import { createDiskSpaceServer } from '../examples/disk-space-status/service/server.ts';
import { parseCapacity, formatBytes } from '../examples/disk-space-status/status/capacity.ts';
import { diskSpaceMessages } from '../examples/disk-space-status/status/messages.ts';

const servers: Server[] = [];
const token = 'disk-space-test-fixture';
const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return `http://127.0.0.1:${port}`;
};
const headers = { Authorization: `Bearer ${token}` };
const query = new URLSearchParams({ directory: process.cwd() });
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

describe('disk-space extension service', () => {
  test('requires authentication even on health, before any capacity read', async () => {
    let reads = 0;
    const origin = await listen(createDiskSpaceServer(token, async () => { reads += 1; return { blocks: 100, bsize: 1, bavail: 20 }; }));
    for (const path of ['/health', `/disk-space?${query}`]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
      expect((await fetch(`${origin}${path}`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    }
    expect(reads).toBe(0);
    expect((await fetch(`${origin}/health`, { headers })).status).toBe(200);
  });

  test('uses available blocks and no-store responses', async () => {
    const origin = await listen(createDiskSpaceServer(token, async () => ({ blocks: 100, bsize: 4096, bavail: 20 })));
    const response = await fetch(`${origin}/disk-space?${query}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(parseCapacity(await response.text())).toEqual({ totalBytes: 409600, availableBytes: 81920 });
  });

  test('rejects wrong methods and missing, repeated or relative directories', async () => {
    let reads = 0;
    const origin = await listen(createDiskSpaceServer(token, async () => { reads += 1; return { blocks: 100, bsize: 1, bavail: 20 }; }));
    for (const suffix of ['', '?directory=relative', '?directory=/one&directory=/two', '?directory=%2Fbad%00path']) {
      expect((await fetch(`${origin}/disk-space${suffix}`, { headers })).status).toBe(400);
    }
    expect((await fetch(`${origin}/disk-space?${query}`, { headers, method: 'POST' })).status).toBe(405);
    expect((await fetch(`${origin}/unknown`, { headers })).status).toBe(404);
    expect(reads).toBe(0);
  });

  test('full disks and invalid or failed reads stay distinct', async () => {
    for (const bavail of [0, -1]) {
      const origin = await listen(createDiskSpaceServer(token, async () => ({ blocks: 100, bsize: 1, bavail })));
      const response = await fetch(`${origin}/disk-space?${query}`, { headers });
      expect(parseCapacity(await response.text())).toEqual({ totalBytes: 100, availableBytes: 0 });
    }
    for (const stats of [{ blocks: 0, bsize: 1, bavail: 0 }, { blocks: 100, bsize: 1, bavail: 101 }, { blocks: 100, bsize: 1, bavail: NaN }]) {
      const origin = await listen(createDiskSpaceServer(token, async () => stats));
      expect((await fetch(`${origin}/disk-space?${query}`, { headers })).status).toBe(503);
    }
    const origin = await listen(createDiskSpaceServer(token, async () => { throw new Error('/private/path'); }));
    const response = await fetch(`${origin}/disk-space?${query}`, { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('/private/path');
  });

  test('reads real filesystem capacity on this host', async () => {
    const origin = await listen(createDiskSpaceServer(token));
    const response = await fetch(`${origin}/disk-space?${query}`, { headers });
    expect(response.status).toBe(200);
    const capacity = parseCapacity(await response.text());
    expect(capacity.totalBytes).toBeGreaterThan(0);
    expect(capacity.availableBytes).toBeLessThanOrEqual(capacity.totalBytes);
  });

  test('a slow read never queues more filesystem work from another client', async () => {
    const pending = Promise.withResolvers<{ blocks: number; bsize: number; bavail: number }>();
    const started = Promise.withResolvers<void>();
    let reads = 0;
    const origin = await listen(createDiskSpaceServer(token, () => {
      reads += 1;
      started.resolve();
      return pending.promise;
    }));
    const first = fetch(`${origin}/disk-space?${query}`, { headers });
    await started.promise;
    expect((await fetch(`${origin}/disk-space?${query}`, { headers })).status).toBe(503);
    expect(reads).toBe(1);
    pending.resolve({ blocks: 100, bsize: 1, bavail: 20 });
    expect((await first).status).toBe(200);
  });

  test('rejects malformed service payloads and formats disk magnitudes', () => {
    for (const body of ['invalid', '{}', '{"totalBytes":0,"availableBytes":0}', '{"totalBytes":100,"availableBytes":101}']) {
      expect(() => parseCapacity(body)).toThrow();
    }
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1024 ** 4, 'en')).toBe('1 TB');
    expect(formatBytes(1.5 * 1024 ** 3, 'de')).toBe('1,5 GB');
  });

  test('ships complete, translated body labels for every host locale', () => {
    const english = diskSpaceMessages('en');
    for (const locale of ['nl', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW', 'ar', 'he']) {
      const translated = diskSpaceMessages(locale);
      expect(Object.keys(translated)).toEqual(Object.keys(english));
      for (const key of ['used', 'available', 'refresh', 'loading', 'unavailable', 'grant', 'project'] as const) {
        expect(translated[key]).not.toBe(english[key]);
      }
      expect(translated.available).toContain('{available}');
      expect(translated.available).toContain('{total}');
    }
  });
});
