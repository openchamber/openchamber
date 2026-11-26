import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOpenCodeTrust } from '../../web/server/lib/opencode-trust/index.js';
import {
  configureProjectStartCommandSource,
  openCodeProjectStartCommandSource,
  readProjectStartCommand,
} from '../../web/server/lib/opencode/project-start-command.js';
import {
  assertOpenCodeDirectoryTrusted,
  guardProjectStartCommandSource,
  OpenCodeTrustRefusedError,
} from './opencodeTrust';

let requests: Array<{ path: string; directory: string | undefined }> = [];
let port = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const directory = req.headers['x-opencode-directory'];
  requests.push({
    path: url.pathname,
    directory: Array.isArray(directory) ? directory.join(',') : directory,
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  if (url.pathname === '/api/location') {
    res.end(JSON.stringify({ directory: '/repo', project: { id: 'proj_1' } }));
    return;
  }
  if (url.pathname === '/api/project') {
    res.end(JSON.stringify([{ id: 'proj_1', commands: { start: 'bun install' } }]));
    return;
  }
  res.end('[]');
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  port = address instanceof Object ? address.port : 0;
});

after(async () => {
  configureProjectStartCommandSource(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  configureProjectStartCommandSource(null);
});

describe('VS Code OpenCode folder trust helpers', () => {
  test('refuses an untrusted folder including literal percent signs and passes once trusted', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-trust-helper-')));
    const repo = path.join(root, '100%repo');
    await mkdir(path.join(repo, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(repo, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'trust.json'),
      homeDirectory: path.join(root, 'home'),
    });

    try {
      let refused: Error | null = null;
      try {
        await assertOpenCodeDirectoryTrusted(repo, { trust });
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }
      assert.ok(refused instanceof OpenCodeTrustRefusedError);
      assert.equal(refused.status, 403);
      assert.equal(refused.code, 'opencode_trust_required');
      assert.equal(refused.directory, repo);

      const { assessment } = await trust.assess(repo, { fresh: true });
      await trust.trust(repo, assessment.fingerprint);

      await assert.doesNotReject(() => assertOpenCodeDirectoryTrusted(repo, { trust }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('guards project start-command lookup from contacting OpenCode for an untrusted folder', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-start-cmd-trust-')));
    const repo = path.join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'evil.js'), 'export default {}');
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ plugins: ['./evil.js'] }));
    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'trust.json'),
      homeDirectory: path.join(root, 'home'),
    });

    const source = guardProjectStartCommandSource(openCodeProjectStartCommandSource({
      buildOpenCodeUrl: () => `http://127.0.0.1:${port}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    }), trust);
    configureProjectStartCommandSource(source);

    try {
      let refused: Error | null = null;
      try {
        await source.read(repo);
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }
      assert.ok(refused instanceof OpenCodeTrustRefusedError);
      assert.equal(refused.status, 403);
      assert.equal(refused.code, 'opencode_trust_required');
      assert.equal(refused.directory, repo);
      assert.equal(await readProjectStartCommand(repo), '');
      assert.equal(requests.length, 0);

      const { assessment } = await trust.assess(repo, { fresh: true });
      await trust.trust(repo, assessment.fingerprint);

      assert.equal(await readProjectStartCommand(repo), 'bun install');
      assert.deepEqual(requests.map((request) => request.path).sort(), ['/api/location', '/api/project']);
      assert.ok(requests.every((request) => request.directory === encodeURIComponent(repo)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
