import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { AGENT_PROTECTED_MCP_ROUTE as route, registerAgentProtectedMcpRoutes, readAgentProjectIdentity, readAgentOrdinaryMcpNames } from './protected-mcp.js';
import { readSelectionMirror } from '../protected-mcp/selection-mirror-documents.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(agentServer = true) {
  const root = await fs.mkdtemp('/tmp/opencode/mcp-agent-routes-');
  roots.push(root);
  const directory = path.join(root, 'project');
  await fs.mkdir(directory);
  const app = express();
  registerAgentProtectedMcpRoutes(app, { agentServer, dataDir: root, listProjectDirectories: async () => [directory] });
  return { root, directory, http: request(app) };
}

it('returns the same git-common identity used by the plugin for a registered project', async () => {
  // Given a registered worktree pointing at a common git directory.
  const f = await fixture();
  const common = path.join(f.root, 'common');
  const worktree = path.join(common, 'worktrees', 'one');
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, 'commondir'), '../..');
  await fs.writeFile(path.join(f.directory, '.git'), `gitdir: ${worktree}\n`);
  // When identity is requested through the agent route.
  const result = await f.http.get(`${route}/identity`).query({ directory: f.directory });
  // Then the shared common directory keys the protected project file.
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ identity: `git:${common}` });
});

it('returns directory identity for a registered non-git project', async () => {
  // Given a registered ordinary directory.
  const f = await fixture();
  // When the identity route reads it.
  const result = await f.http.get(`${route}/identity`).query({ directory: f.directory });
  // Then it has the plugin directory identity.
  expect(result.body).toEqual({ identity: `directory:${f.directory}` });
});

it.each(['identity', 'names'])('refuses unregistered directories on %s', async (suffix) => {
  // Given an agent with a registered project.
  const f = await fixture();
  // When a caller names a different directory.
  const result = await f.http.get(`${route}/${suffix}`).query({ directory: f.root });
  // Then the route refuses project reads.
  expect(result.status).toBe(403);
});

it.each(['identity', 'names'])('bounds and validates query input on %s', async (suffix) => {
  // Given a running agent route.
  const f = await fixture();
  // When malformed, duplicate, oversized or extra query fields arrive.
  const inputs = ['', '?directory=relative', '?directory=%2Fx%00', `?directory=/${'a'.repeat(4096)}`, '?directory=/a&directory=/b', '?directory=/a&extra=1'];
  const results = await Promise.all(inputs.map((query) => f.http.get(`${route}/${suffix}${query}`)));
  // Then every request fails at the input boundary.
  expect(results.map((result) => result.status)).toEqual(inputs.map(() => 400));
});

it('lists ordinary project and personal MCP entries from the agent configuration', async () => {
  // Given file-backed and personal project configuration on the agent.
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'opencode.json'), JSON.stringify({ mcp: { ordinary: { type: 'local', command: ['/synthetic'] } } }));
  // When names are requested.
  const result = await f.http.get(`${route}/names`).query({ directory: f.directory });
  // Then the ordinary file entry is available for conflict detection.
  expect(result.status).toBe(200);
  expect(result.body.names).toContain('ordinary');
});

it.each([
  { ['bad/name']: { type: 'local', command: ['/synthetic'] } },
  Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`server${n}`, { type: 'local', command: ['/synthetic'] }])),
])('refuses invalid or oversized ordinary-name answers %#', async (mcp) => {
  // Given invalid agent-side configuration.
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'opencode.json'), JSON.stringify({ mcp }));
  // When ordinary names are read.
  const result = await f.http.get(`${route}/names`).query({ directory: f.directory });
  // Then the reply cannot be treated as a valid empty list.
  expect(result.status).toBe(502);
});

it('mirrors a complete validated snapshot through the agent endpoint', async () => {
  // Given an agent with no protected selections.
  const f = await fixture();
  const snapshot = { version: 1, documents: [{ version: 1, identity: `directory:${f.directory}`, servers: { selected: { connection: 'pmcp_0123456789abcdef' } } }] };
  // When the front door sends its snapshot.
  const result = await f.http.put(`${route}/selections`).send(snapshot);
  // Then the plugin document is persisted on the agent.
  expect(result.status).toBe(200);
  expect(await readSelectionMirror(f.root)).toEqual(snapshot);
});

it.each([{}, { version: 1, documents: [{ version: 1, identity: 'git:relative', servers: {} }] }])('refuses malformed mirror input %#', async (body) => {
  // Given an agent mirror endpoint.
  const f = await fixture();
  // When invalid selection documents arrive.
  const result = await f.http.put(`${route}/selections`).send(body);
  // Then nothing is mirrored.
  expect(result.status).toBe(400);
  expect(await readSelectionMirror(f.root)).toEqual({ version: 1, documents: [] });
});

it('rejects an oversized mirror HTTP body', async () => {
  // Given an agent mirror endpoint.
  const f = await fixture();
  // When the request exceeds the body limit.
  const result = await f.http.put(`${route}/selections`).send({ value: 'x'.repeat(1024 * 1024) });
  // Then it refuses the body before writing.
  expect(result.status).toBe(413);
});

it.each(['identity', 'names', 'selections'])('does not mount %s outside agent-server mode', async (suffix) => {
  // Given the ordinary single-account composition.
  const f = await fixture(false);
  // When an internal route is called.
  const result = suffix === 'selections' ? await f.http.put(`${route}/${suffix}`).send({}) : await f.http.get(`${route}/${suffix}`);
  // Then that capability is absent.
  expect(result.status).toBe(404);
});

it.each(['git:relative', 'directory:/bad\npath', 'directory:/bad\u0085path', 'other:/project', `git:/${'a'.repeat(4096)}`])('rejects an untrusted identity answer %#', async (identity) => {
  // Given an agent-controlled invalid reply.
  const upstream = { json: async () => ({ identity }) };
  // When the front door reads it.
  const result = readAgentProjectIdentity(upstream, '/registered');
  // Then no invalid project target reaches persistence.
  await expect(result).rejects.toThrow();
});

it('rejects untrusted names before reporting conflicts', async () => {
  // Given an invalid name from the agent.
  const upstream = { json: async () => ({ names: ['bad/name'] }) };
  // When the front door reads ordinary names.
  const result = readAgentOrdinaryMcpNames(upstream, '/registered');
  // Then this read fails rather than returning authoritative empty success.
  await expect(result).rejects.toThrow();
});
