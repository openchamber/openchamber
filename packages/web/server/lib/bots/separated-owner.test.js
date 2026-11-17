import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { readRepositoryPolicy, readRepositoryPolicyFiles, parseRepositoryPolicyFiles } from './repository-policy.js';
import { createBotHostTools } from './host-tools.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { isRecord } from '../shared/guards.js';

const cleanups = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const temporary = async () => {
  const directory = await fs.mkdtemp('/tmp/opencode/bot-separated-owner-');
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const area = '---\nname: Core\npaths: [src/**]\nlevel: judgment\nowners: [lead]\n---\nReview\n';

it('hashes exact delegated policy bytes on the owner and keeps missing, unreadable and changed policy blocking', async () => {
  const root = await temporary();
  await fs.mkdir(path.join(root, '.agents/areas'), { recursive: true });
  await fs.mkdir(path.join(root, '.openchamber'));
  await fs.writeFile(path.join(root, '.agents/areas/core.md'), area);
  await fs.writeFile(path.join(root, '.openchamber/people.json'), JSON.stringify([{ id: 'lead', name: 'Lead', roles: [], jira: 'jira-lead' }]));
  const original = await readRepositoryPolicy(root);
  const approvals = Object.fromEntries([...original.areas, original.people].map(({ file, fingerprint }) => [file, fingerprint]));
  const bytes = await readRepositoryPolicyFiles(root, { files: Object.keys(approvals) });
  expect(parseRepositoryPolicyFiles(bytes, approvals)).toEqual(await readRepositoryPolicy(root, approvals));
  const changed = structuredClone(bytes);
  changed.files.find((entry) => entry.file.endsWith('core.md')).raw += 'Changed\n';
  expect(parseRepositoryPolicyFiles(changed, approvals).areas[0].status).toBe('changed');
  expect(() => parseRepositoryPolicyFiles({ ...bytes, approved: true }, approvals)).toThrow();
  expect(() => parseRepositoryPolicyFiles({ ...bytes, files: [...bytes.files, bytes.files[0]] }, approvals)).toThrow();
  expect(parseRepositoryPolicyFiles({ ...bytes, files: [] }, approvals).issues).toHaveLength(1);
  expect(parseRepositoryPolicyFiles({ directory: 'unreadable', files: [] }).issues).toHaveLength(1);
  expect(() => parseRepositoryPolicyFiles({ directory: 'present', files: [{ file: '../outside.md', status: 'present', raw: area }] })).toThrow();
  expect(() => parseRepositoryPolicyFiles({ directory: 'present', files: [{ file: '.agents/areas/a.md', status: 'present', raw: 'é'.repeat(600_000) }] })).toThrow();

  // This executable mutation proves the approval check, independently of the reader.
  const moduleFile = path.join(root, 'policy.mjs');
  const source = await fs.readFile(new URL('./repository-policy.js', import.meta.url), 'utf8');
  await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
  const mutation = source.replace("status: approvals[file] === fingerprint ? 'approved'", "status: true ? 'approved'");
  expect(mutation).not.toBe(source);
  await fs.writeFile(moduleFile, mutation);
  const probe = `import {parseRepositoryPolicyFiles} from ${JSON.stringify(pathToFileURL(moduleFile).href)};
    import assert from 'node:assert/strict';
    assert.equal(parseRepositoryPolicyFiles(${JSON.stringify(changed)},${JSON.stringify(approvals)}).areas[0].status,'changed','owner hash must reject changed bytes');`;
  const red = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  expect(red.status).toBe(1);
  expect(red.stderr).toContain('owner hash must reject changed bytes');
});

it('retains owner tool receipts across lost settlement and refuses borrowing another fixing session', async () => {
  const dataDir = await temporary();
  const entry = { projectId: 'p', botId: 'b', itemId: 'i', sessionId: 'ses_fixed', directory: '/opaque/checkout', isolated: false, stage: 'fixing' };
  const request = { sessionId: entry.sessionId, callId: 'call', action: 'jira.comment', input: { operationId: 'same', body: 'reply' } };
  const pending = { id: digestMutationInput({ sessionId: entry.sessionId, callId: request.callId }), request };
  let executions = 0; let failSettlement = true; const settlements = [];
  const execution = {
    readSession: async () => ({ id: entry.sessionId, directory: entry.directory, metadata: { openchamber: { automation: {
      source: 'bot', projectId: entry.projectId, botId: entry.botId, itemId: entry.itemId, stage: 'fixing' } } } }),
    pullTools: async () => ({ requests: [pending] }),
    settleTool: async (_entry, value) => { settlements.push(value); if (failSettlement) throw new Error('lost receipt'); return { settled: true }; },
  };
  const create = () => createBotHostTools({ dataDir, execution, handleTool: async () => { executions++; return { receipt: { id: 'comment' } }; } });
  await expect(create().forward(entry)).rejects.toThrow('lost receipt');
  failSettlement = false;
  expect(await create().forward(entry)).toEqual({ forwarded: 1 });
  expect(executions).toBe(1);
  expect(settlements[0]).toEqual(settlements[1]);
  await expect(create().forward({ ...entry, sessionId: 'ses_other' })).rejects.toMatchObject({ code: 'BOT_FIXING_SESSION_REQUIRED' });
  await expect(create().forward({ ...entry, itemId: 'other' })).rejects.toMatchObject({ code: 'BOT_FIXING_SESSION_REQUIRED' });
});

it('delivers dedicated host notices through bounded operations after owner revalidation, without any HTTP fallback', async () => {
  const dataDir = await temporary();
  vi.useFakeTimers();
  const calls = []; let permitted = true;
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: 'p', itemId: 'i', eventId: 'reply' };
  const ids = botNoticeIds(notice);
  const queue = createMessageQueueRuntime({ dataDir,
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    buildOpenCodeUrl: () => { throw new Error('Owner must not address project HTTP'); }, getOpenCodeAuthHeaders: () => ({}),
    assertBotDispatch: async () => { calls.push('authority'); if (!permitted) throw new Error('owner revoked'); return { includeMemorySaveRule: true }; },
    sessionKnowledgeRuntime: { sync: async () => { calls.push('knowledge'); } }, broadcastGlobalUiEvent: () => {},
    botTransport: { isIdle: async () => true, deliverNotice: async (input) => { calls.push(input); } },
  });
  cleanups.unshift(async () => { queue.stop(); await queue.flush(); });
  await queue.load(); queue.start();
  await queue.enqueue('ses_fixed', '/opaque/checkout', { id: ids.itemId, messageId: ids.messageId, content: 'reply', text: 'reply', origin: { kind: 'bot', id: 'i' }, notice });
  await vi.advanceTimersByTimeAsync(501);
  await vi.waitFor(() => expect(calls.some(isRecord)).toBe(true));
  expect(calls.filter(isRecord)).toEqual([{ sessionId: 'ses_fixed', directory: '/opaque/checkout', id: ids.messageId, text: 'reply', description: 'reply', notice }]);
  expect(calls.filter((call) => call === 'authority').length).toBeGreaterThanOrEqual(3);
  permitted = false;
  await expect(queue.enqueue('ses_fixed', '/opaque/checkout', { content: 'reply', text: 'reply', origin: { kind: 'bot', id: 'i' }, notice })).rejects.toThrow('owner revoked');
});
