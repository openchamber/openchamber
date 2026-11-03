import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import type { SourceControlReadContext } from '@/lib/source-control/types';

import { rewriteProjectUploads, uploadUrls } from './projectUploads';

const secret = '66dbcd21ec5d24ed6ea225176098d52b';
const urls = {
  media: (path: string) => `https://app.test/api/source-control/gitlab${path}?owner=team`,
  link: (path: string) => `https://gitlab.test/team/repo${path}`,
};

describe('rewriteProjectUploads', () => {
  test('reads pictures and clips through the server and opens other files on GitLab', () => {
    const markdown = [
      `![demo](/uploads/${secret}/demo.mp4)`,
      `[log.txt](/uploads/${secret}/log.txt) and <a href="/uploads/${secret}/a.pdf">a.pdf</a>`,
      `<img src="/uploads/${secret}/shot.png" width="300">`,
      'See /uploads/ in the docs and ![remote](https://gitlab.com/a.png).',
    ].join('\n\n');

    expect(rewriteProjectUploads(markdown, urls)).toBe([
      `![demo](https://app.test/api/source-control/gitlab/uploads/${secret}/demo.mp4?owner=team)`,
      `[log.txt](https://gitlab.test/team/repo/uploads/${secret}/log.txt) and <a href="https://gitlab.test/team/repo/uploads/${secret}/a.pdf">a.pdf</a>`,
      `<img src="https://app.test/api/source-control/gitlab/uploads/${secret}/shot.png?owner=team" width="300">`,
      'See /uploads/ in the docs and ![remote](https://gitlab.com/a.png).',
    ].join('\n\n'));
  });

  test('keeps upload paths inside code as written', () => {
    const markdown = [
      `Write \`![x](/uploads/${secret}/y.png)\` to embed.`,
      '```md',
      `![x](/uploads/${secret}/y.png)`,
      '```',
      `![real](/uploads/${secret}/z.png)`,
    ].join('\n');

    const result = rewriteProjectUploads(markdown, urls);
    expect(result.split(`(/uploads/${secret}/y.png)`)).toHaveLength(3);
    expect(result).toContain(`![real](https://app.test/api/source-control/gitlab/uploads/${secret}/z.png?owner=team)`);
  });
});

describe('uploadUrls', () => {
  const context: SourceControlReadContext = {
    provider: 'gitlab', instance: 'https://gitlab.test', directory: '/repo', repositoryId: 'repo', accountId: 'account', bindingRevision: 3, primaryRemote: 'origin',
  };
  const tunnel: RelayTunnelClient = {
    fetch: async () => new Response(),
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: () => () => undefined,
    retry: () => undefined,
    close: () => undefined,
  };
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.assign(globalThis, { window: new Window({ url: 'https://localhost/index.html' }) });
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://localhost' });
  });
  afterEach(() => {
    deactivateRelayTunnel();
    Object.assign(globalThis, { window: originalWindow });
  });

  test('over the relay a picture keeps the bare route and a clip points at the host', () => {
    adoptRelayTunnel({ relayUrl: 'wss://relay.test/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
    const urls = uploadUrls(context, { owner: 'team', repo: 'repo', source: 'origin' });

    const picture = urls.media(`/uploads/${secret}/shot.png`);
    expect(picture.startsWith(`/api/source-control/gitlab/uploads/${secret}/shot.png?`)).toBe(true);
    expect(new URLSearchParams(picture.split('?')[1]).get('owner')).toBe('team');
    expect(picture).not.toContain('oc_url_token');
    expect(urls.media(`/uploads/${secret}/demo.webm`)).toBe(`https://gitlab.test/team/repo/uploads/${secret}/demo.webm`);
  });

  test('off the relay a picture and a clip stay addresses the browser loads', () => {
    const urls = uploadUrls(context, { owner: 'team', repo: 'repo', source: 'origin' });

    expect(urls.media(`/uploads/${secret}/shot.png`).startsWith(`https://localhost/api/source-control/gitlab/uploads/${secret}/shot.png?`)).toBe(true);
    expect(urls.media(`/uploads/${secret}/demo.webm`).startsWith(`https://localhost/api/source-control/gitlab/uploads/${secret}/demo.webm?`)).toBe(true);
  });
});
