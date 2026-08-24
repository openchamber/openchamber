import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OrdinarySessionJournal, ORDINARY_SESSION_ERRORS, startOrdinaryWorkspaceSession } from './ordinary-session-start.js';

const workspace = { id: 'ws-1', type: 'docker', projectID: 'project-1' };
const session = (workspaceID = 'ws-1') => ({ id: 'session-1', projectID: 'project-1', workspaceID });

function fixture(overrides = {}) {
  const listed = overrides.listed ?? [workspace];
  const client = {
    experimental: {
      workspace: {
        list: vi.fn(async () => ({ data: listed })),
        create: vi.fn(async () => ({ data: workspace })),
        status: vi.fn(async () => ({ data: [{ workspaceID: workspace.id, status: 'connected' }] })),
      },
    },
    session: {
      create: vi.fn(async () => ({ data: session() })),
      get: vi.fn(async () => ({ data: session() })),
    },
  };
  return { client, journal: new OrdinarySessionJournal({ rootDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-journal-')) }) };
}

const input = (fixture, overrides = {}) => ({ operationID: 'operation-123', principal: 'client:test', directory: '/repo', projectID: 'project-1', provider: 'docker', client: fixture.client, journal: fixture.journal, pollIntervalMs: 0, ...overrides });

describe('ordinary workspace session start', () => {
  it('reuses one connected applicable workspace and routes the session', async () => {
    const fx = fixture();
    const result = await startOrdinaryWorkspaceSession(input(fx));
    expect(result).toMatchObject({ status: 'completed', session: { id: 'session-1', workspaceID: 'ws-1' } });
    expect(fx.client.experimental.workspace.create).not.toHaveBeenCalled();
    expect(fx.client.session.create).toHaveBeenCalledWith({ directory: '/repo', workspace: 'ws-1' });
  });

  it('accepts OpenCode project IDs from a different ID space than the OpenChamber project', async () => {
    const openCodeScoped = { id: 'ws-global', type: 'docker', projectID: 'global' };
    const fx = fixture({ listed: [openCodeScoped] });
    fx.client.experimental.workspace.status.mockResolvedValue({ data: [{ workspaceID: 'ws-global', status: 'connected' }] });
    fx.client.session.create.mockResolvedValue({ data: { id: 'session-1', projectID: 'global', workspaceID: 'ws-global' } });
    fx.client.session.get.mockResolvedValue({ data: { id: 'session-1', projectID: 'global', workspaceID: 'ws-global' } });

    const result = await startOrdinaryWorkspaceSession(input(fx, { projectID: 'path_QzovVXNlcnMvT3BlbkNoYW1iZXI' }));

    expect(result).toMatchObject({ status: 'completed', workspaceID: 'ws-global' });
    expect(fx.client.experimental.workspace.create).not.toHaveBeenCalled();
  });

  it('compensates the row OpenCode retains when create fails', async () => {
    const fx = fixture({ listed: [] });
    fx.client.experimental.workspace.create.mockResolvedValue({ error: { message: 'adapter refused' } });
    const compensateCreate = vi.fn(async () => ({ completed: true, remainingResources: [] }));

    await expect(startOrdinaryWorkspaceSession(input(fx, {
      authorizeCreation: vi.fn(async () => true),
      compensateCreate,
    }))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE });

    // The compensated ID must be the one we generated, so the exact row is reclaimed.
    const requestedID = fx.client.experimental.workspace.create.mock.calls[0][0].id;
    expect(compensateCreate).toHaveBeenCalledWith(requestedID);
  });

  it('reports a record that could not be reclaimed instead of failing silently', async () => {
    const fx = fixture({ listed: [] });
    fx.client.experimental.workspace.create.mockResolvedValue({ error: { message: 'adapter refused' } });
    const compensateCreate = vi.fn(async () => ({ completed: false, remainingResources: ['container:runtime'] }));

    await expect(startOrdinaryWorkspaceSession(input(fx, {
      authorizeCreation: vi.fn(async () => true),
      compensateCreate,
    }))).rejects.toThrow(/unused workspace record was left behind/);
  });

  it('adopts the row OpenCode gave up waiting on instead of destroying a booting workspace', async () => {
    // OpenCode's own post-create wait is a few seconds; a Docker cold start is longer.
    // Its timeout says it stopped watching, not that the workspace failed, so the row
    // it kept is adopted and the bounded connect wait decides the outcome.
    const fx = fixture({ listed: [] });
    let provisionalID = '';
    fx.client.experimental.workspace.create.mockImplementation(async ({ id }) => {
      provisionalID = id;
      fx.client.experimental.workspace.list.mockResolvedValue({ data: [{ id, type: 'docker', projectID: 'project-1' }] });
      fx.client.experimental.workspace.status.mockResolvedValue({ data: [{ workspaceID: id, status: 'connected' }] });
      fx.client.session.create.mockImplementation(async () => ({ data: { id: 'session-1', projectID: 'project-1', workspaceID: id } }));
      fx.client.session.get.mockImplementation(async () => ({ data: { id: 'session-1', projectID: 'project-1', workspaceID: id } }));
      throw new Error('Timed out waiting for global event');
    });
    const compensateCreate = vi.fn();

    const result = await startOrdinaryWorkspaceSession(input(fx, { authorizeCreation: vi.fn(async () => true), compensateCreate }));

    expect(result).toMatchObject({ status: 'completed', workspaceID: provisionalID });
    expect(compensateCreate).not.toHaveBeenCalled();
  });

  it('connects through the disconnected status OpenCode stamps at sync start', async () => {
    const fx = fixture();
    // The first snapshot selects the workspace as usable; the connect wait then sees
    // the `disconnected` OpenCode stamps at sync start before reaching `connected`.
    const statuses = ['connecting', 'disconnected', 'disconnected', 'connected'];
    fx.client.experimental.workspace.status.mockImplementation(async () => ({
      data: [{ workspaceID: workspace.id, status: statuses.length > 1 ? statuses.shift() : statuses[0] }],
    }));

    const result = await startOrdinaryWorkspaceSession(input(fx));

    expect(result).toMatchObject({ status: 'completed', workspaceID: workspace.id });
  });

  it('keeps the workspace and answers a retryable timeout when it stays disconnected', async () => {
    const fx = fixture();
    fx.client.experimental.workspace.status.mockImplementation(async () => {
      const calls = fx.client.experimental.workspace.status.mock.calls.length;
      // The first snapshot must offer a usable workspace so one is selected at all;
      // afterwards the connect wait only ever sees `disconnected`.
      return { data: [{ workspaceID: workspace.id, status: calls <= 1 ? 'connecting' : 'disconnected' }] };
    });
    const compensateCreate = vi.fn();

    await expect(startOrdinaryWorkspaceSession(input(fx, { maxAttempts: 2, compensateCreate })))
      .rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.CONNECTION_TIMEOUT, workspaceID: workspace.id, retryable: true });

    expect(compensateCreate).not.toHaveBeenCalled();
    expect(fx.client.session.create).not.toHaveBeenCalled();
  });

  it('compensates the upstream wait timeout when no authoritative row survived it', async () => {
    const fx = fixture({ listed: [] });
    fx.client.experimental.workspace.create.mockImplementation(async () => { throw new Error('Timed out waiting for global event'); });
    const compensateCreate = vi.fn(async () => ({ completed: true, remainingResources: [] }));

    await expect(startOrdinaryWorkspaceSession(input(fx, {
      authorizeCreation: vi.fn(async () => true),
      compensateCreate,
    }))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.WORKSPACE_UNAVAILABLE });

    expect(compensateCreate).toHaveBeenCalled();
  });

  it('does not compensate a workspace that was created successfully', async () => {
    const fx = fixture({ listed: [] });
    const compensateCreate = vi.fn();

    await startOrdinaryWorkspaceSession(input(fx, { authorizeCreation: vi.fn(async () => true), compensateCreate }));

    expect(compensateCreate).not.toHaveBeenCalled();
  });

  it('creates exactly one workspace and retries idempotently', async () => {
    const fx = fixture({ listed: [] });
    const first = await startOrdinaryWorkspaceSession(input(fx, { authorizeCreation: vi.fn(async () => true) }));
    const second = await startOrdinaryWorkspaceSession(input(fx, { authorizeCreation: vi.fn(async () => true) }));
    expect(first.session.id).toBe(second.session.id);
    expect(fx.client.experimental.workspace.create).toHaveBeenCalledTimes(1);
    expect(fx.client.session.create).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent requests for the same operation', async () => {
    const fx = fixture({ listed: [] });
    fx.client.experimental.workspace.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { data: workspace };
    });
    const authorizeCreation = vi.fn(async () => true);
    const [first, second] = await Promise.all([
      startOrdinaryWorkspaceSession(input(fx, { authorizeCreation })),
      startOrdinaryWorkspaceSession(input(fx, { authorizeCreation })),
    ]);
    expect(first.sessionID).toBe('session-1');
    expect(second.sessionID).toBe('session-1');
    expect(fx.client.experimental.workspace.create).toHaveBeenCalledTimes(1);
    expect(fx.client.session.create).toHaveBeenCalledTimes(1);
    expect(authorizeCreation).toHaveBeenCalledTimes(1);
  });

  it('returns an explicit bounded timeout without creating a session', async () => {
    const fx = fixture();
    fx.client.experimental.workspace.status.mockResolvedValue({ data: [{ workspaceID: 'ws-1', status: 'connecting' }] });
    await expect(startOrdinaryWorkspaceSession(input(fx, { maxAttempts: 2 }))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.CONNECTION_TIMEOUT, statusCode: 202, retryable: true });
    expect(fx.client.session.create).not.toHaveBeenCalled();
  });

  it('retries a persisted connecting operation without reauthorizing creation', async () => {
    const fx = fixture();
    const authorizeCreation = vi.fn(async () => true);
    fx.client.experimental.workspace.status
      .mockResolvedValueOnce({ data: [{ workspaceID: 'ws-1', status: 'connecting' }] })
      .mockResolvedValueOnce({ data: [{ workspaceID: 'ws-1', status: 'connecting' }] })
      .mockResolvedValueOnce({ data: [{ workspaceID: 'ws-1', status: 'connected' }] });
    await expect(startOrdinaryWorkspaceSession(input(fx, { maxAttempts: 1, authorizeCreation }))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.CONNECTION_TIMEOUT });
    await expect(startOrdinaryWorkspaceSession(input(fx, { maxAttempts: 1, authorizeCreation }))).resolves.toMatchObject({ sessionID: 'session-1' });
    expect(authorizeCreation).not.toHaveBeenCalled();
    expect(fx.client.experimental.workspace.create).not.toHaveBeenCalled();
  });

  it('does not create a duplicate after a partial session success', async () => {
    const fx = fixture();
    fx.client.session.get.mockResolvedValueOnce({ error: { name: 'temporary verification failure' } });
    await expect(startOrdinaryWorkspaceSession(input(fx))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.SESSION_PARTIAL, sessionID: 'session-1' });
    await expect(startOrdinaryWorkspaceSession(input(fx))).resolves.toMatchObject({ status: 'completed', session: { id: 'session-1' } });
    expect(fx.client.session.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused operation ID with a different request binding', async () => {
    const fx = fixture();
    await startOrdinaryWorkspaceSession(input(fx));
    await expect(startOrdinaryWorkspaceSession(input(fx, { directory: '/other' }))).rejects.toMatchObject({ code: ORDINARY_SESSION_ERRORS.IDEMPOTENCY_CONFLICT });
  });
});
