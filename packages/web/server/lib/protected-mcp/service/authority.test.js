import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketClient } from '../test-support/admin-socket-client.js';
import { SENTINEL, engineRequest, startService } from '../test-support/fixtures.js';

const fixtures = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function setup() {
  const fixture = await startService();
  fixtures.push(fixture);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const definition = { name: 'example', transport: 'http', http: { url: 'https://mcp.example.com/mcp', headers: { Authorization: { secret: 'token', prefix: 'Bearer ' } } } };
  const { connection } = await admin.create(definition, { token: SENTINEL });
  return { fixture, admin, definition, connection };
}

describe('call authority versus administrative authority', () => {
  it('refuses administrative engine frames and keeps secrets out of status', async () => {
    // Given
    const { fixture, connection } = await setup();
    // When / Then
    for (const type of ['approve', 'create', 'update', 'secret', 'export', 'getCredential']) {
      expect(await engineRequest(fixture.engineSocketPath, { type, connection: connection.id }))
        .toEqual([{ type: 'error', code: 'unsupported_request' }]);
    }
    const [status] = await engineRequest(fixture.engineSocketPath, { type: 'status' });
    expect(status.connections).toEqual([expect.objectContaining({ id: connection.id, credential: 'stored' })]);
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
  });

  it('refuses a stale revision over the admin socket', async () => {
    // Given
    const { admin, connection } = await setup();
    // When
    const answer = await admin.apply({ kind: 'set-enabled', id: connection.id, expectedRevision: connection.revision + 1, enabled: false });
    // Then
    expect(answer).toMatchObject({ type: 'error', code: 'revision_conflict', status: 409 });
  });

  it('refuses to redirect stored credentials and preserves policy-only edits', async () => {
    // Given
    const { admin, connection, definition } = await setup();
    const moved = { ...definition, http: { ...definition.http, url: 'https://other.example/mcp' } };
    // When
    const answer = await admin.update(connection.id, connection.revision, moved);
    // Then
    expect(answer).toMatchObject({ type: 'error', code: 'credential_rebind_required' });
    expect((await admin.get(connection.id)).connection.http.url).toBe(definition.http.url);
    const policy = await admin.update(connection.id, connection.revision, { ...definition, policy: { denyTools: ['delete_everything'] } });
    expect(policy.connection.secrets).toEqual({ token: { set: true } });
    const rebound = await admin.update(connection.id, policy.connection.revision, moved, { token: 'replacement-value' });
    expect(rebound.connection.secrets).toEqual({ token: { set: true } });
  });

  it('keeps credential values out of reads and restricts state files to their owner', async () => {
    // Given
    const { fixture, admin, connection } = await setup();
    // When
    const answers = [await admin.list(), await admin.get(connection.id)];
    // Then
    expect(answers[0].connections[0].secrets).toEqual({ token: { set: true } });
    expect(JSON.stringify(answers)).not.toContain(SENTINEL);
    const modes = [];
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        modes.push((await fs.stat(full)).mode & 0o077);
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(fixture.stateDir);
    expect(modes.filter((mode) => mode !== 0)).toEqual([]);
  });
});
