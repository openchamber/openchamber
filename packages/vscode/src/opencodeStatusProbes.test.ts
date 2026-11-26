import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOpenCodeTrust } from '../../web/server/lib/opencode-trust/index.js';
import { formatOpenCodeStatusProbes, runOpenCodeStatusProbes } from './opencodeStatusProbes';
import type { OpenCodeTrustGuard } from './opencodeTrust';

interface SeenRequest {
  path: string;
  location: string | null;
  filter: string | null;
}

let seenPaths: string[] = [];
let seenRequests: SeenRequest[] = [];
let port = 0;

const locationOf = (url: URL, header: string | undefined): string | null => {
  const query = url.searchParams.get('location[directory]');
  if (query) return query;
  if (!header) return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  seenPaths.push(url.pathname);
  seenRequests.push({
    path: url.pathname,
    location: locationOf(url, req.headers['x-opencode-directory']?.toString()),
    filter: url.searchParams.get('directory'),
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  port = address instanceof Object ? address.port : 0;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seenPaths = [];
  seenRequests = [];
});

const LOCATION_PATHS = ['/api/config', '/api/provider', '/api/agent', '/api/command', '/api/location'];
const GLOBAL_PATHS = ['/api/info', '/api/project', '/api/session', '/api/session/active'];

describe('OpenCode status diagnostics probes', () => {
  test('skips directory-scoped probes for an untrusted folder and probes all endpoints once trusted', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-status-probes-trust-')));
    const repo = path.join(root, 're%po 1');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'evil.js'), 'export default {}');
    await writeFile(path.join(repo, 'opencode.json'), JSON.stringify({ plugins: ['./evil.js'] }));
    const trust = createOpenCodeTrust({
      storePath: path.join(root, 'trust.json'),
      homeDirectory: path.join(root, 'home'),
    });

    try {
      const refusedProbes = await runOpenCodeStatusProbes({
        resolvedApiUrl: `http://127.0.0.1:${port}`,
        workingDirectory: repo,
        trust,
      });

      for (const blockedPath of LOCATION_PATHS) {
        assert.ok(!seenPaths.includes(blockedPath), `unexpected probe to ${blockedPath}`);
      }
      assert.deepEqual(seenPaths.sort(), [...GLOBAL_PATHS].sort());
      assert.ok(seenRequests.every((request) => request.location === null));

      const byLabel = new Map(refusedProbes.map((probe) => [probe.label, probe]));
      for (const label of ['config', 'providers', 'agents', 'commands', 'location']) {
        const probe = byLabel.get(label);
        assert.equal(probe?.result?.skipped, true);
        assert.equal(probe?.result?.ok, false);
        assert.equal(probe?.result?.status, 403);
        assert.equal(probe?.result?.summary, 'folder trust required');
      }
      for (const label of ['health', 'project', 'sessions', 'sessionStatus']) {
        assert.equal(byLabel.get(label)?.result?.ok, true);
        assert.equal(byLabel.get(label)?.result?.status, 200);
      }

      const formatted = formatOpenCodeStatusProbes(refusedProbes);
      assert.ok(formatted.includes('- config: skipped status=403 folder trust required'));
      assert.ok(formatted.includes('- location: skipped status=403 folder trust required'));

      seenPaths = [];
      seenRequests = [];
      const { assessment } = await trust.assess(repo, { fresh: true });
      await trust.trust(repo, assessment.fingerprint);

      const trustedProbes = await runOpenCodeStatusProbes({
        resolvedApiUrl: `http://127.0.0.1:${port}`,
        workingDirectory: repo,
        trust,
      });
      assert.equal(trustedProbes.length, 9);
      assert.ok(trustedProbes.every((probe) => probe.result?.ok === true && probe.result?.status === 200));
      assert.equal(seenPaths.length, 9);
      for (const request of seenRequests) {
        if (LOCATION_PATHS.includes(request.path)) {
          assert.equal(request.location, repo, `${request.path} must open the workspace folder`);
        } else {
          assert.equal(request.location, null, `${request.path} must not name a location`);
        }
      }
      assert.equal(seenRequests.find((request) => request.path === '/api/session')?.filter, repo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('checks trust before any location request is sent', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-status-probes-order-')));
    const repo = path.join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const checked: Array<{ path: string; directory: string | undefined }> = [];
    const trust: OpenCodeTrustGuard = {
      refusalFor: async ({ path: requestPath, headers }) => {
        checked.push({ path: requestPath, directory: headers?.['x-opencode-directory']?.toString() });
        assert.ok(!seenRequests.some((request) => request.location !== null), 'a location request went out before its check');
        const pathname = new URL(requestPath, 'http://opencode.invalid').pathname;
        if (!LOCATION_PATHS.includes(pathname)) return null;
        return { status: 403, body: { error: 'trust required', code: 'opencode_trust_required', directory: repo } };
      },
    };

    const probes = await runOpenCodeStatusProbes({
      resolvedApiUrl: `http://127.0.0.1:${port}`,
      workingDirectory: repo,
      trust,
    });

    assert.deepEqual(seenPaths.sort(), [...GLOBAL_PATHS].sort());
    for (const entry of checked) {
      const pathname = new URL(entry.path, 'http://opencode.invalid').pathname;
      assert.equal(entry.directory, LOCATION_PATHS.includes(pathname) ? encodeURIComponent(repo) : undefined);
    }
    assert.equal(probes.filter((probe) => probe.result?.skipped).length, LOCATION_PATHS.length);
    await rm(root, { recursive: true, force: true });
  });

  test('reports an unreachable folder instead of asking for trust', async () => {
    const directory = path.join(os.tmpdir(), 'vscode-status-probes-unreachable');
    const trust: OpenCodeTrustGuard = {
      refusalFor: async ({ path: requestPath }) => {
        const pathname = new URL(requestPath, 'http://opencode.invalid').pathname;
        if (!LOCATION_PATHS.includes(pathname)) return null;
        return { status: 503, body: { error: `Folder is unavailable: ${directory}`, code: 'DIRECTORY_UNREACHABLE', directory } };
      },
    };

    const probes = await runOpenCodeStatusProbes({
      resolvedApiUrl: `http://127.0.0.1:${port}`,
      workingDirectory: directory,
      trust,
    });

    assert.deepEqual(seenPaths.sort(), [...GLOBAL_PATHS].sort());
    const formatted = formatOpenCodeStatusProbes(probes);
    assert.ok(formatted.includes(`- config: skipped status=503 Folder is unavailable: ${directory}`));
    assert.ok(!formatted.some((line) => line.includes('folder trust required')));
  });

  test('skips location probes without a workspace folder and keeps global probes running', async () => {
    const trust = createOpenCodeTrust({
      storePath: path.join(os.tmpdir(), `vscode-status-probes-none-${process.pid}.json`),
    });
    const probes = await runOpenCodeStatusProbes({
      resolvedApiUrl: `http://127.0.0.1:${port}`,
      workingDirectory: '',
      trust,
    });

    assert.deepEqual(seenPaths.sort(), [...GLOBAL_PATHS].sort());
    assert.ok(seenRequests.every((request) => request.location === null && request.filter === null));
    const formatted = formatOpenCodeStatusProbes(probes);
    assert.ok(formatted.includes('- location: skipped status=0 no workspace folder'));
    assert.ok(formatted.some((line) => line.startsWith('- health: ok status=200')));
  });
});
