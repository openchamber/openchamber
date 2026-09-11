import { describe, expect, test } from 'bun:test';

import { extractAnnouncedUrls, extractProjectActionUrl, extractTerminalPreviewUrl } from './terminalPreview';

/**
 * Real output from a project running four Astro apps behind a dev gateway. The
 * gateway logs its own routing table, so the output is full of URLs that look
 * perfectly openable but are backends the user should never be sent to — and
 * two of the apps are served under a base path.
 */
const GATEWAY_LOG = [
  '[gateway] OpenChamber website dev gateway ready on http://localhost:3000',
  '[gateway] - site -> http://127.0.0.1:4321',
  '[gateway] - docs -> http://127.0.0.1:4322',
  '[gateway] - analytics -> http://127.0.0.1:4323',
  '[gateway] - api -> http://127.0.0.1:8787',
].join('\n');

const ANALYTICS_LOG = [
  '[analytics]  astro  v5.18.1 ready in 1531 ms',
  '[analytics]',
  '[analytics] ┃ Local    http://localhost:4323/__analytics',
  '[analytics] ┃ Network  http://192.168.1.115:4323/__analytics',
].join('\n');

describe('announced preview url', () => {
  test('takes the gateway front door over the backends it lists', () => {
    expect(extractTerminalPreviewUrl(GATEWAY_LOG)).toBe('http://localhost:3000');
  });

  test('keeps the base path an app is served under', () => {
    expect(extractTerminalPreviewUrl(ANALYTICS_LOG)).toBe('http://localhost:4323/__analytics');
  });

  test('prefers the LAN-independent local address over the network one', () => {
    expect(extractTerminalPreviewUrl(ANALYTICS_LOG)).not.toContain('192.168');
  });

  test('ignores a routing-table line, which announces nothing', () => {
    expect(extractTerminalPreviewUrl('[gateway] - analytics -> http://127.0.0.1:4323')).toBeNull();
  });
});

describe('project action url', () => {
  test('opens the gateway, not a backend from its routing table', () => {
    expect(extractProjectActionUrl(GATEWAY_LOG + '\n' + ANALYTICS_LOG)).toBe('http://localhost:3000');
  });

  test('keeps the base path instead of stripping it to the origin', () => {
    // Dropping the path is what lands the user on the app's own 404.
    expect(extractProjectActionUrl(ANALYTICS_LOG)).toBe('http://localhost:4323/__analytics');
  });

  test('falls back to scoring when nothing announces itself', () => {
    const output = 'starting\nhttp://127.0.0.1:4323/__analytics\n';
    expect(extractProjectActionUrl(output)).toBe('http://127.0.0.1:4323/__analytics');
  });

  test('prefers a loopback candidate over a public one', () => {
    const output = 'see https://example.com:8443/app and http://127.0.0.1:5173/ui';
    expect(extractProjectActionUrl(output)).toBe('http://127.0.0.1:5173/ui');
  });

  test('returns nothing when the output has no url with a port', () => {
    expect(extractProjectActionUrl('building...\ndone\n')).toBeNull();
    expect(extractProjectActionUrl('')).toBeNull();
  });

  test('normalizes a wildcard bind to an address the browser can reach', () => {
    expect(extractProjectActionUrl('server listening on http://0.0.0.0:4000/app'))
      .toBe('http://127.0.0.1:4000/app');
  });
});

describe('auto-discovery url', () => {
  const ROUTING_TABLE_CHUNK = [
    '[gateway] - site -> http://127.0.0.1:4321',
    '[gateway] - docs -> http://127.0.0.1:4322',
    '[gateway] - analytics -> http://127.0.0.1:4323',
  ].join('\n');

  test('waits rather than opening a backend from a routing table', () => {
    // Whether this chunk or the announcement arrives first depends on where the
    // terminal split its output, so guessing here is guessing differently each run.
    expect(extractProjectActionUrl(ROUTING_TABLE_CHUNK, { requireAnnounced: true })).toBeNull();
  });

  test('opens the gateway once it announces itself', () => {
    expect(extractProjectActionUrl(GATEWAY_LOG, { requireAnnounced: true })).toBe('http://localhost:3000');
  });

  test('a configured action may still open a bare url it printed, taking the first', () => {
    expect(extractProjectActionUrl(ROUTING_TABLE_CHUNK)).toBe('http://127.0.0.1:4321/');
  });
});

describe('every announced url', () => {
  test('returns each server that announced itself, in order', () => {
    const output = [
      '[gateway] OpenChamber website dev gateway ready on http://localhost:3000',
      '[gateway] - site -> http://127.0.0.1:4321',
      '[api] ⚡  API dev server running on http://localhost:8787',
      '[analytics] ┃ Local    http://localhost:4323/__analytics',
      '[docs] ┃ Local    http://localhost:4322/docs',
    ].join('\n');

    expect(extractAnnouncedUrls(output)).toEqual([
      'http://localhost:3000',
      'http://localhost:8787',
      'http://localhost:4323/__analytics',
      'http://localhost:4322/docs',
    ]);
  });

  test('leaves out routing-table entries, which announce nothing', () => {
    expect(extractAnnouncedUrls('[gateway] - site -> http://127.0.0.1:4321')).toEqual([]);
  });

  test('does not repeat an address announced twice', () => {
    const output = [
      '[site] ┃ Local    http://localhost:4321/',
      '[site] server running on http://localhost:4321/',
    ].join('\n');
    expect(extractAnnouncedUrls(output)).toEqual(['http://localhost:4321/']);
  });

  test('is empty for output with no announcement', () => {
    expect(extractAnnouncedUrls('building...\ndone')).toEqual([]);
    expect(extractAnnouncedUrls('')).toEqual([]);
  });
});
