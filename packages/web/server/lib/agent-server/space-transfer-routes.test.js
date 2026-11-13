import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { ID, cleanupTransfers, transferFixture } from './space-transfer-fixture.js';
import { readBoundedBody } from './agent-upstream.js';

afterEach(cleanupTransfers);
const json = async (response) => ({ status: response.statusCode, body: JSON.parse(await readBoundedBody(response, 65536)) });

describe('agent project-transfer authorization', () => {
  it('requires normal UI authentication when a registered project is requested', async () => {
    // Given an agent server with a registered repository.
    const fixture = await transferFixture();
    // When an unauthenticated client requests snapshot metadata.
    const response = await fetch(`${fixture.origin}${fixture.route('snapshot')}`);
    // Then the normal UI gate refuses it before project git runs.
    expect(response.status).toBe(401);
    expect(fixture.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });
  it('registers no transfer routes when agent-server mode is off', async () => {
    // Given a normal server, authenticated as its owner.
    const fixture = await transferFixture({ agent: false });
    // When the transfer endpoint is requested.
    const response = await fixture.upstream.request({ path: fixture.route('snapshot') });
    // Then no agent-only handler exists.
    expect(response.statusCode).toBe(404);
    response.destroy();
  });
  it('refuses a real but unregistered directory when snapshotting', async () => {
    // Given another existing directory beside the registered project.
    const fixture = await transferFixture();
    const directory = path.join(fixture.host.root, 'unregistered');
    fs.cpSync(fixture.repo, directory, { recursive: true });
    // When that directory is requested through authenticated HTTP.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot', { directory }),
      method: 'POST', body: '{"mode":"clean"}', headers: { 'content-type': 'application/json' } }));
    // Then registration, rather than filesystem existence, decides authority.
    expect(response).toMatchObject({ status: 403, body: { code: 'agent_project_unregistered' } });
  });
  it('accepts a symlink to the registered project when canonical paths match', async () => {
    // Given an alias that resolves to the one registered repository.
    const fixture = await transferFixture();
    const alias = path.join(fixture.host.root, 'alias');
    fs.symlinkSync(fixture.repo, alias);
    // When a clean snapshot is requested through the alias.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot', { directory: alias }),
      method: 'POST', body: '{"mode":"clean"}' }));
    // Then metadata is bound to the canonical project.
    expect(response.body).toMatchObject({ directory: fixture.repo, base: fixture.g(['rev-parse', 'HEAD']).trim() });
  });
  it('refuses an invalid space id before making refs', async () => {
    // Given a registered project and an id containing no valid namespace.
    const fixture = await transferFixture();
    // When authenticated snapshot creation names it.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot').replace(ID, 'bad-id') }));
    // Then no ref is created.
    expect(response.body.code).toBe('invalid_space_id');
    expect(fixture.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });
  it.each([
    ['body ref', { mode: 'clean', ref: 'refs/heads/main' }, {}],
    ['query ref', { mode: 'clean' }, { ref: 'refs/heads/main' }],
  ])('refuses %s outside the fixed namespace', async (_name, body, query) => {
    // Given a client-supplied ref outside the space namespace.
    const fixture = await transferFixture();
    // When the client attempts to snapshot into it.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot', query), method: 'POST', body: JSON.stringify(body) }));
    // Then the request is rejected without touching refs.
    expect(response.body.code).toBe('agent_transfer_invalid_request');
    expect(fixture.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });
  it('rejects malformed metadata when the request body is not JSON', async () => {
    // Given the authenticated project boundary.
    const fixture = await transferFixture();
    // When a malformed JSON body arrives.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot'), method: 'POST', body: '{' }));
    // Then parsing fails explicitly.
    expect(response.body.code).toBe('agent_metadata_invalid');
  });
  it('rejects an oversized result stream before promotion', async () => {
    // Given a real start snapshot and a small agent upload cap.
    const fixture = await transferFixture({ caps: { bundleBytes: 64 } });
    const snapshot = await fixture.upstream.json(fixture.route('snapshot'), { method: 'POST', body: '{"mode":"clean"}' });
    // When a result body exceeds that cap.
    const response = await fixture.upstream.request({ path: fixture.route('result', { start: snapshot.start, result: snapshot.start }), method: 'POST', body: Readable.from([Buffer.alloc(65)]) });
    const answer = await json(response);
    // Then no result reaches the repository.
    expect(answer.body.code).toBe('agent_bundle_too_large');
    expect(fixture.g(['for-each-ref', '--format=%(refname)', `refs/openchamber/spaces/${ID}/result`])).toBe('');
  });
  it.each(['malformed', 'parents'])('refuses %s persisted metadata when recovering a snapshot', async (corruption) => {
    // Given a real snapshot whose agent-owned metadata was damaged after writing.
    const fixture = await transferFixture();
    const metadata = await fixture.upstream.json(fixture.route('snapshot'), { method: 'POST', body: '{"mode":"uncommitted"}' });
    const file = path.join(fixture.dataDir, 'space-transfer', `${ID}.json`);
    fs.writeFileSync(file, corruption === 'malformed' ? '{' : JSON.stringify({ ...metadata, staged: fixture.g(['rev-parse', 'HEAD~1']).trim() }));
    // When the agent receives a request to reuse that snapshot.
    const response = await json(await fixture.upstream.request({ path: fixture.route('snapshot') }));
    // Then neither malformed data nor a false chain becomes snapshot authority.
    expect(response.body.code).toBe(corruption === 'malformed' ? 'agent_metadata_invalid' : 'agent_snapshot_chain_invalid');
    expect(fixture.g(['rev-parse', metadata.ref]).trim()).toBe(metadata.start);
  });
  it('answers an oversized chunked result before the sender ends its body', async () => {
    // Given an authenticated upload that remains open after crossing its byte cap.
    const fixture = await transferFixture({ caps: { bundleBytes: 64 } });
    const metadata = await fixture.upstream.json(fixture.route('snapshot'), { method: 'POST', body: '{"mode":"clean"}' });
    const body = new PassThrough();
    body.write(Buffer.alloc(65));
    try {
      // When the agent rejects the stream without waiting for EOF.
      const response = await json(await fixture.upstream.request({ path: fixture.route('result', { start: metadata.start, result: metadata.start }), method: 'POST', body, timeoutMs: 5000 }));
      // Then the limit is enforced without requiring the untrusted sender to finish.
      expect(response.body.code).toBe('agent_bundle_too_large');
    } finally { body.destroy(); }
  });
});

describe('a project another account owns', () => {
  it('snapshots and exports it when the agent trusts it, with its own configuration off for the bundle', async () => {
    // Given a project git treats as another account's, which the agent's global config trusts, as git-trust.js makes it.
    const fixture = await transferFixture({ agentEnvironment: { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } });
    fs.appendFileSync(fixture.host.environment.GIT_CONFIG_GLOBAL, `\n[safe]\n\tdirectory = ${fixture.repo}\n`);
    // When the front door asks for a snapshot and its bundle.
    const snapshot = await json(await fixture.upstream.request({ path: fixture.route('snapshot'), method: 'POST', body: '{"mode":"uncommitted"}' }));
    const bundle = await fixture.upstream.request({ path: fixture.route('bundle') });
    const head = (await readBoundedBody(bundle, 64 * 1024 * 1024)).slice(0, 20);
    // Then both answer, though the isolated git reads no global config.
    expect(snapshot).toMatchObject({ status: 200, body: { directory: fixture.repo } });
    expect(bundle.statusCode).toBe(200);
    expect(head).toMatch(/^# v[23] git bundle/);
  });
});
