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

describe('GitHub attachments', () => {
  const context: SourceControlReadContext = {
    provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo', accountId: 'account', bindingRevision: 3, primaryRemote: 'origin',
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

  const routeTarget = (output: string, name: string) => {
    const match = new RegExp(`/api/source-control/github/uploads/([A-Za-z0-9_-]+)/${name}\\?`).exec(output);
    return match ? Buffer.from(match[1]!, 'base64url').toString('utf8') : null;
  };

  test('reads a private blob link and a pasted screenshot through the bound account', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = [
      '![iPad](https://github.com/acme/app/blob/e81f2ed/docs/ipad-landscape.png?raw=true)',
      '![shot](https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9)',
      '<img src="https://raw.githubusercontent.com/acme/app/main/docs/menu.png" width="300">',
    ].join('\n');

    const output = rewriteProjectUploads(markdown, urls);

    expect(routeTarget(output, 'ipad-landscape.png')).toBe('https://github.com/acme/app/blob/e81f2ed/docs/ipad-landscape.png?raw=true');
    expect(routeTarget(output, '47f9b551-5ecf-4bb0-9122-0c1b8302e1b9')).toBe('https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9');
    expect(routeTarget(output, 'menu.png')).toBe('https://raw.githubusercontent.com/acme/app/main/docs/menu.png');
    expect(output).not.toContain('https://github.com/acme/app/blob/e81f2ed');
  });

  test('leaves other hosts, blob pages and code as written', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = [
      '![public](https://example.com/shot.png)',
      '![page](https://github.com/acme/app/blob/main/docs/shot.png)',
      `Write \`![x](https://github.com/acme/app/blob/main/docs/shot.png?raw=true)\` to embed.`,
      `\`\`\`md\n![x](https://github.com/acme/app/blob/main/docs/shot.png?raw=true)\n\`\`\``,
    ].join('\n\n');

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('leaves absolute GitHub URLs when the descriptor does not ask for them', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' });
    const markdown = '![iPad](https://github.com/acme/app/blob/e81f2ed/docs/ipad-landscape.png?raw=true)';

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('leaves a GitHub clip as written on the relay', () => {
    adoptRelayTunnel({ relayUrl: 'wss://relay.test/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = '![clip](https://github.com/acme/app/blob/main/demo.mp4?raw=true)';

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('keeps a GitHub picture on the bare uploads route over the relay', () => {
    adoptRelayTunnel({ relayUrl: 'wss://relay.test/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const output = rewriteProjectUploads('![shot](https://github.com/acme/app/blob/main/docs/shot.png?raw=true)', urls);

    expect(output.startsWith('![shot](/api/source-control/github/uploads/')).toBe(true);
    expect(output).not.toContain('oc_url_token');
  });

  test('leaves relative upload paths in GitHub Markdown as written', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = [
      '![old](/uploads/0123456789abcdef0123456789abcdef/shot.png)',
      '[log](/uploads/0123456789abcdef0123456789abcdef/build.log)',
    ].join('\n');

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('leaves an SVG and another repository file at their own URLs', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = [
      '![badge](https://raw.githubusercontent.com/acme/app/main/docs/badge.svg)',
      '![other](https://raw.githubusercontent.com/other/lib/main/docs/shot.png)',
      '![other](https://github.com/other/lib/blob/main/docs/shot.png?raw=true)',
    ].join('\n');

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
    expect(routeTarget(rewriteProjectUploads('![own](https://raw.githubusercontent.com/Acme/App/main/a.png)', urls), 'a.png'))
      .toBe('https://raw.githubusercontent.com/Acme/App/main/a.png');
  });

  test('keeps a raw video source on the relay and reads a raw picture through it', () => {
    adoptRelayTunnel({ relayUrl: 'wss://relay.test/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const asset = 'https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9';
    const video = `<video src="${asset}" controls></video>\n<video controls><source src="${asset}"></video>`;

    expect(rewriteProjectUploads(video, urls)).toBe(video);
    expect(rewriteProjectUploads(`<img width="300" src="${asset}">`, urls).startsWith('<img width="300" src="/api/source-control/github/uploads/')).toBe(true);
  });

  test('leaves a Markdown clip named only by its alt text as written on the relay', () => {
    adoptRelayTunnel({ relayUrl: 'wss://relay.test/ws', serverId: 'srv_test', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' } }, tunnel);
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = '![clip.mp4](https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9)';

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('leaves a repository clip at its own URL so the browser keeps byte ranges', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = '![clip](https://github.com/acme/app/blob/main/demo.mp4?raw=true)';

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
  });

  test('leaves a fragment-bearing GitHub picture as written', () => {
    const urls = uploadUrls(context, { owner: 'acme', repo: 'app', source: 'origin' }, true);
    const markdown = '![shot](https://github.com/acme/app/blob/main/docs/shot.png?raw=true#L5)';

    expect(rewriteProjectUploads(markdown, urls)).toBe(markdown);
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
    const written = new URLSearchParams(urls.media(`/uploads/${secret}/shot.png?inline=1`).split('?')[1]);
    expect([written.get('inline'), written.get('owner')]).toEqual(['1', 'team']);
    expect(urls.media(`/uploads/${secret}/demo.webm`)).toBe(`https://gitlab.test/team/repo/uploads/${secret}/demo.webm`);
  });

  test('off the relay a picture and a clip stay addresses the browser loads', () => {
    const urls = uploadUrls(context, { owner: 'team', repo: 'repo', source: 'origin' });

    expect(urls.media(`/uploads/${secret}/shot.png`).startsWith(`https://localhost/api/source-control/gitlab/uploads/${secret}/shot.png?`)).toBe(true);
    expect(urls.media(`/uploads/${secret}/demo.webm`).startsWith(`https://localhost/api/source-control/gitlab/uploads/${secret}/demo.webm?`)).toBe(true);
  });
});
