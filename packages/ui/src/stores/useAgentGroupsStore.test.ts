import { afterAll, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import http from 'node:http';
import { z } from 'zod';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { opencodeClient } from '@/lib/opencode/client';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { useDirectoryStore } from './useDirectoryStore';
import { useProjectsStore } from './useProjectsStore';
import { useAgentGroupsStore } from './useAgentGroupsStore';

const makeSession = (id: string, groupId: string): Session => ({
  id, slug: id, projectID: 'p', directory: '/group-test', title: 'Renamed freely', version: '1', time: { created: 1, updated: 1 },
  metadata: withMultiRunMembership({}, {
    version: 1, sessionID: id, group: { kind: 'id', id: groupId }, groupSlug: 'same-name',
    role: 'run', providerID: 'openrouter', modelID: 'vendor/model',
  }),
});
let sessions = [
  makeSession('first', '9f512893-6e63-4e49-a534-5de733ca103e'),
  makeSession('second', '5fdf22b1-d21e-4324-b2df-01747396c704'),
];
sessions.push({ ...sessions[0], id: 'fork' });
let failList = false;
const deleted: string[] = [];
const unexpected: string[] = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (pathname === '/api/git/check') { res.end(JSON.stringify({ isGitRepository: false })); return; }
  if (pathname === '/api/experimental/session') {
    if (failList) { res.writeHead(503).end(JSON.stringify({ message: 'offline' })); return; }
    res.end(JSON.stringify(sessions));
    return;
  }
  const match = /^\/api\/session\/([^/]+)$/.exec(pathname);
  if (match && req.method === 'GET') {
    const session = sessions.find((item) => item.id === match[1]);
    if (session) res.end(JSON.stringify(session));
    else res.writeHead(404).end();
    return;
  }
  if (match && req.method === 'DELETE') {
    deleted.push(match[1]);
    sessions = sessions.filter((item) => item.id !== match[1]);
    res.end('true');
    return;
  }
  unexpected.push(`${req.method} ${pathname}`);
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = z.object({ port: z.number() }).parse(server.address());
configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}` });
opencodeClient.reconnectToRuntimeBaseUrl();
useProjectsStore.setState({ projects: [], activeProjectId: null });
useDirectoryStore.setState({ currentDirectory: '/group-test' });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('Agent Manager keeps same-label runs separate and deletes only the selected ID group', async () => {
  await useAgentGroupsStore.getState().loadGroups();
  const groups = useAgentGroupsStore.getState().groups;
  expect(groups).toHaveLength(2);
  expect(groups.every((group) => group.name === 'same-name')).toBe(true);
  const first = groups.find((group) => group.sessions.some((session) => session.id === 'first'));
  if (!first) throw new Error('Missing first group');
  useAgentGroupsStore.getState().selectGroup(first.id);
  expect(useAgentGroupsStore.getState().selectedSessionId).toBe('first');

  failList = true;
  await useAgentGroupsStore.getState().loadGroups();
  expect(useAgentGroupsStore.getState().groups).toHaveLength(2);
  expect(useAgentGroupsStore.getState().error).not.toBeNull();
  failList = false;

  const result = await useAgentGroupsStore.getState().deleteGroupSessions(first.sessions, { removeWorktrees: true });
  await useAgentGroupsStore.getState().loadGroups();
  expect(result.failedIds).toEqual([]);
  expect(deleted).toEqual(['first']);
  expect(sessions.map((session) => session.id)).toEqual(['second', 'fork']);
  expect(useAgentGroupsStore.getState().groups).toHaveLength(1);
  expect(useAgentGroupsStore.getState().selectedGroupId).toBeNull();
  expect(unexpected).toEqual([]);
}, 15000);
