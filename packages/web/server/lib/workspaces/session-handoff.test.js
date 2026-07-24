import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSessionHandoff, WorkspaceHandoffJournal, workspaceHandoffInternals } from './session-handoff.js';

const principal = 'client:device-a';

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-project-'));
  const rootDirectory = overrides.rootDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-journal-'));
  const source = { id: 'session-source', projectID: 'project-1', workspaceID: 'workspace-source', directory, title: 'Source', metadata: {}, time: { created: 1, updated: 1 } };
  const workspaces = new Map([
    ['workspace-source', { id: 'workspace-source', projectID: 'project-1', directory }],
    ['workspace-target', { id: 'workspace-target', projectID: 'project-1', directory }],
  ]);
  let sourceMessages = overrides.sourceMessages ?? [
    { info: { id: 'message-user', role: 'user', time: { created: 1 } }, parts: [{ id: 'part-user', type: 'text', text: 'Implement the accepted design.' }, { id: 'part-file', type: 'file', url: 'data:text/plain;base64,c2VjcmV0' }] },
    { info: { id: 'message-assistant', role: 'assistant', time: { created: 2 } }, parts: [{ id: 'part-assistant', type: 'text', text: 'The implementation is ready for review.' }, { id: 'part-reasoning', type: 'reasoning', text: 'hidden' }] },
  ];
  const targetSessions = [];
  const targetMessages = new Map();
  const session = {
    get: vi.fn(async () => ({ data: source })),
    status: vi.fn(async () => ({ data: { [source.id]: { type: overrides.sourceStatus ?? 'idle' } } })),
    messages: vi.fn(async ({ sessionID, before, limit }) => {
      if (sessionID === source.id && overrides.messagesError) return { error: { name: 'failed' }, response: { status: 502 } };
      const records = sessionID === source.id ? sourceMessages : targetMessages.get(sessionID) ?? [];
      const end = before ? Number(before.replace('cursor-', '')) : records.length;
      const pageEnd = end < 0 ? 0 : end;
      const start = Math.max(0, pageEnd - limit);
      return {
        data: records.slice(start, pageEnd).reverse(),
        response: { headers: { get: (name) => name.toLowerCase() === 'x-next-cursor' && start > 0 ? `cursor-${start}` : null } },
      };
    }),
    list: vi.fn(async ({ start = 0, limit = 100 }) => ({ data: targetSessions.slice(start, start + limit) })),
    create: vi.fn(async (input) => {
      const created = { id: 'session-target', projectID: 'project-1', workspaceID: overrides.wrongRouting ? 'workspace-wrong' : input.workspace, directory, title: input.title, metadata: input.metadata, time: { created: 2, updated: 2 } };
      targetSessions.push(created);
      if (overrides.createTimeout) throw new Error('create timeout');
      return { data: created };
    }),
    prompt: vi.fn(async (input) => {
      const message = { info: { id: input.messageID, role: 'user', time: { created: 3 } }, parts: input.parts };
      if (!overrides.insertMissing) {
        const padding = Array.from({ length: overrides.targetMessagePadding ?? 0 }, (_, index) => ({
          info: { id: `target-later-${index}`, role: 'user', time: { created: 4 + index } },
          parts: [{ id: `target-later-part-${index}`, type: 'text', text: `Later ${index}` }],
        }));
        targetMessages.set(input.sessionID, [message, ...padding]);
      }
      if (overrides.insertTimeout) throw new Error('insert timeout');
      if (overrides.insertMissing) throw new Error('insert failed');
      return { data: message };
    }),
    delete: vi.fn(async ({ sessionID }) => {
      if (overrides.cleanupFailure) throw new Error('delete failed');
      const index = targetSessions.findIndex((item) => item.id === sessionID);
      if (index >= 0) targetSessions.splice(index, 1);
      targetMessages.delete(sessionID);
      return { data: true };
    }),
  };
  const client = { session };
  const handoff = createWorkspaceSessionHandoff({
    journal: new WorkspaceHandoffJournal({ rootDirectory }),
    createClient: async () => client,
    persistedContext: async () => ({ directory, project: { id: 'persisted-project', path: directory } }),
    loadWorkspace: async (id) => {
      const workspace = workspaces.get(id);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      return workspace;
    },
    workspaceStatus: async () => [{ workspaceID: 'workspace-target', status: overrides.targetStatus ?? 'connected' }],
    randomID: (() => {
      const ids = ['operation-00000001', 'draft-000000000001'];
      return () => ids.shift();
    })(),
  });
  const binding = { projectID: 'project-1', directory, sourceSessionID: source.id, sourceWorkspaceID: source.workspaceID, targetWorkspaceID: 'workspace-target' };
  return { binding, client, handoff, rootDirectory, source, targetSessions, targetMessages, setSourceMessages: (value) => { sourceMessages = value; } };
}

async function reviewed(fx) {
  const operation = await fx.handoff.draft(fx.binding, principal);
  return { operation, commit: { ...fx.binding, operationID: operation.operationID, draftID: operation.draft.id, draftRevision: operation.draft.revision, draftHash: operation.draft.hash, text: operation.draft.text } };
}

describe('Secure Workspace session handoff', () => {
  it('extracts only visible text and reports every omitted part category', () => {
    const result = workspaceHandoffInternals.extractDraft({ metadata: { openchamber: { goal: { objective: 'Ship safely' } } } }, [
      { info: { role: 'user' }, parts: [
        { type: 'text', text: 'Visible request' },
        { type: 'text', text: 'api_key=super-secret-value' },
        { type: 'reasoning', text: 'private thought' },
        { type: 'tool', output: 'payload' },
        { type: 'file', url: 'data:image/png;base64,AAAA' },
        { type: 'subtask', prompt: 'hidden' },
      ] },
    ]);
    expect(result.text).toContain('Ship safely');
    expect(result.text).toContain('Visible request');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.text).not.toContain('private thought');
    expect(result.omissions).toEqual(expect.arrayContaining([
      { code: 'file', count: 1 }, { code: 'reasoning', count: 1 }, { code: 'subtask', count: 1 }, { code: 'text', count: 1 }, { code: 'tool', count: 1 },
    ]));
    expect(result.warningCodes).toEqual(['not-exact-history', 'excluded-content', 'file-changes-excluded']);
  });

  it('returns draft text once without persisting or reconstructing user content', async () => {
    const fx = fixture();
    const operation = await fx.handoff.draft(fx.binding, principal);
    const file = path.join(fx.rootDirectory, `${operation.operationID}.json`);
    const serialized = fs.readFileSync(file, 'utf8');
    const persisted = JSON.parse(serialized);

    expect(operation.draft.text).toContain('Implement the accepted design.');
    expect(operation.draft.warningCodes).toEqual(['not-exact-history', 'excluded-content', 'file-changes-excluded']);
    expect(serialized).not.toContain('Implement the accepted design.');
    expect(serialized).not.toContain('The implementation is ready for review.');
    expect(serialized).not.toContain(operation.draft.text);
    expect(persisted.draft).toEqual({
      id: operation.draft.id,
      revision: operation.draft.revision,
      hash: operation.draft.hash,
      boundary: operation.draft.boundary,
      omissions: operation.draft.omissions,
    });
    expect(await fx.handoff.inspect(operation.operationID, principal)).not.toHaveProperty('draft');
    const restarted = fixture({ rootDirectory: fx.rootDirectory });
    expect(await restarted.handoff.inspect(operation.operationID, principal)).not.toHaveProperty('draft');
  });

  it('creates one routed text-only no-reply context and leaves the source unchanged', async () => {
    const fx = fixture();
    const sourceBefore = structuredClone(fx.source);
    const { commit } = await reviewed(fx);
    const completed = await fx.handoff.commit(commit, principal);
    expect(completed).toMatchObject({ state: 'completed', targetSessionID: 'session-target' });
    expect(fx.client.session.create).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'workspace-target', metadata: { openchamber: expect.objectContaining({ handoffOperationID: commit.operationID }) } }));
    expect(fx.client.session.get).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'workspace-source' }));
    expect(fx.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ noReply: true, workspace: 'workspace-target', parts: [{ id: expect.stringMatching(/^prt_handoff_/), type: 'text', text: commit.text }] }));
    expect(fx.source).toEqual(sourceBefore);
    expect(fx.client.session.delete).not.toHaveBeenCalledWith(expect.objectContaining({ sessionID: fx.source.id }));
    const journal = fs.readFileSync(path.join(fx.rootDirectory, `${commit.operationID}.json`), 'utf8');
    expect(journal).not.toContain('c2VjcmV0');
    expect(journal).not.toContain('Implement the accepted design.');
    expect(journal).not.toContain(commit.text);
  });

  it('rejects stale, mismatched, busy, disconnected, and wrong-principal requests', async () => {
    const fx = fixture();
    const { operation, commit } = await reviewed(fx);
    await expect(fx.handoff.inspect(operation.operationID, 'client:other')).rejects.toMatchObject({ statusCode: 403 });
    await expect(fx.handoff.commit({ ...commit, projectID: 'project-other' }, principal)).rejects.toThrow('binding');
    await expect(fx.handoff.draft({ ...fx.binding, sourceWorkspaceID: 'workspace-target' }, principal)).rejects.toThrow('workspace changed');
    fx.setSourceMessages([{ info: { id: 'new-message', role: 'user', time: { created: 3 } }, parts: [{ id: 'new-part', type: 'text', text: 'Changed' }] }]);
    await expect(fx.handoff.commit(commit, principal)).rejects.toMatchObject({ staleDraft: true });
    await expect(fixture({ sourceStatus: 'busy' }).handoff.draft(fx.binding, principal)).rejects.toThrow('idle');
    const disconnected = fixture({ targetStatus: 'disconnected' });
    await expect(disconnected.handoff.draft(disconnected.binding, principal)).rejects.toThrow('not connected');
  });

  it('paginates the complete source and confirms null host routing', async () => {
    const sourceMessages = Array.from({ length: 101 }, (_, index) => ({ info: { id: `message-${String(index).padStart(3, '0')}`, role: 'user', time: { created: index } }, parts: [{ id: `part-${index}`, type: 'text', text: `Visible ${index}` }] }));
    const fx = fixture({ sourceMessages });
    const binding = { ...fx.binding, targetWorkspaceID: null };
    const operation = await fx.handoff.draft(binding, principal);
    expect(operation.draft.boundary.count).toBe(101);
    expect(fx.client.session.messages).toHaveBeenCalledTimes(2);
    expect(fx.client.session.messages.mock.calls[1][0].before).toBe('cursor-1');
    const result = await fx.handoff.commit({ ...binding, operationID: operation.operationID, draftID: operation.draft.id, draftRevision: 1, draftHash: operation.draft.hash, text: operation.draft.text }, principal);
    expect(result.state).toBe('completed');
    expect(fx.client.session.create.mock.calls[0][0]).not.toHaveProperty('workspace');
    expect(fx.client.session.prompt.mock.calls[0][0]).not.toHaveProperty('workspace');
  });

  it('rejects a target session returned on the wrong route and cleans only that new target', async () => {
    const fx = fixture({ wrongRouting: true });
    const { commit } = await reviewed(fx);
    await expect(fx.handoff.commit(commit, principal)).rejects.toThrow('incorrect routing');
    expect(fx.client.session.delete).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-target', workspace: 'workspace-wrong' }));
    expect(fx.client.session.delete).not.toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-source' }));
  });

  it('is idempotent for the same body and rejects operation ID reuse with another body', async () => {
    const fx = fixture();
    const { commit } = await reviewed(fx);
    const [first, concurrent] = await Promise.all([fx.handoff.commit(commit, principal), fx.handoff.commit(commit, principal)]);
    expect(concurrent).toEqual(first);
    expect(await fx.handoff.commit(commit, principal)).toEqual(first);
    await expect(fx.handoff.commit({ ...commit, text: `${commit.text}\nchanged` }, principal)).rejects.toThrow('different commit payload');
    expect(fx.client.session.create).toHaveBeenCalledTimes(1);
    expect(fx.client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('recovers create and insert timeouts by authoritative operation IDs without duplicates', async () => {
    const fx = fixture({ createTimeout: true, insertTimeout: true });
    const { commit } = await reviewed(fx);
    const result = await fx.handoff.commit(commit, principal);
    expect(result.state).toBe('completed');
    expect(fx.targetSessions).toHaveLength(1);
    expect(fx.client.session.create).toHaveBeenCalledTimes(1);
    expect(fx.client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('paginates target messages when recovering an insert timeout', async () => {
    const fx = fixture({ insertTimeout: true, targetMessagePadding: 125 });
    const { commit } = await reviewed(fx);
    const result = await fx.handoff.commit(commit, principal);
    const targetReads = fx.client.session.messages.mock.calls.filter(([input]) => input.sessionID === 'session-target');
    expect(result.state).toBe('completed');
    expect(targetReads.some(([input]) => input.before === 'cursor-26')).toBe(true);
    expect(fx.client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it('persists cleanup-required across restart and deletes only the orphan target', async () => {
    const fx = fixture({ insertMissing: true, cleanupFailure: true });
    const { operation, commit } = await reviewed(fx);
    await expect(fx.handoff.commit(commit, principal)).rejects.toMatchObject({ cleanupRequired: true });
    const restarted = fixture({ rootDirectory: fx.rootDirectory });
    const inspected = await restarted.handoff.inspect(operation.operationID, principal);
    expect(inspected.state).toBe('cleanup-required');
    expect(fs.statSync(fx.rootDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(fx.rootDirectory, `${operation.operationID}.json`)).mode & 0o777).toBe(0o600);
  });

  it('does not persist a partial draft when authoritative pagination fails', async () => {
    const fx = fixture({ messagesError: true });
    await expect(fx.handoff.draft(fx.binding, principal)).rejects.toThrow('session.messages failed');
    expect(fs.readdirSync(fx.rootDirectory)).toEqual([]);
  });

  it('treats absence from the OpenCode status map as authoritative idle', async () => {
    const fx = fixture();
    fx.client.session.status.mockResolvedValueOnce({ data: {} });
    await expect(fx.handoff.draft(fx.binding, principal)).resolves.toMatchObject({ state: 'drafted' });
  });

  it('removes legacy text-bearing journals and rejects symlink or non-regular reads', async () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-hardening-'));
    const legacyID = 'legacy-operation-0001';
    fs.writeFileSync(path.join(rootDirectory, `${legacyID}.json`), JSON.stringify({ version: 1, operationID: legacyID, state: 'drafted', draft: { text: 'legacy sensitive transcript' } }), { mode: 0o600 });
    const journal = new WorkspaceHandoffJournal({ rootDirectory });
    expect(fs.existsSync(path.join(rootDirectory, `${legacyID}.json`))).toBe(false);

    const external = path.join(os.tmpdir(), `openchamber-handoff-external-${Date.now()}.json`);
    fs.writeFileSync(external, JSON.stringify({ version: 2 }), { mode: 0o600 });
    const symlinkID = 'symlink-operation-01';
    fs.symlinkSync(external, path.join(rootDirectory, `${symlinkID}.json`));
    expect(() => journal.read(symlinkID)).toThrow('unreadable');

    const directoryID = 'directory-operation1';
    fs.mkdirSync(path.join(rootDirectory, `${directoryID}.json`));
    expect(() => journal.read(directoryID)).toThrow('unreadable');
  });
});
