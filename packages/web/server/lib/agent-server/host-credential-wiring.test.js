import fs from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpacesHost } from '../spaces/host.js';
import { createSpaceRecords } from '../spaces/space-records.js';
import { createMemoryPlace } from '../spaces/places/memory-place.js';
import { hashProjectDirectory } from '../spaces/labels.js';
import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { createAgentHostCredentials } from './host-credentials.js';
import { createAgentCredentialSource } from './credential-source.js';
import { frontDoorRequestGate } from './front-door.js';
import express from 'express';
import request from 'supertest';

const addGrant = vi.fn(async () => {});
// The channels into the space: the gatekeeper records each grant, the space's OpenCode takes any write.
const makeGatekeeperChannel = () => ({ addGrant, readPolicy: async () => ({ grants: [] }) });
const makeSpaceOpenCode = () => ({ writeProviderConfig: async () => {}, writeLogin: async () => {}, removeLogin: async () => {} });
const ID = 'abcdef123456';
const PROJECT = '/agent/project';
const cleanups = [];
afterEach(async () => {
  configureOpenCodeCredentials(null);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});
const setup = async (adapters = true) => {
  const root = fs.mkdtempSync('/tmp/opencode/d2b-wiring-');
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const place = createMemoryPlace();
  await place.create({ id: ID, name: 'Fixture', project: hashProjectDirectory(PROJECT), created: new Date().toISOString() });
  cleanups.push(() => place.remove(ID));
  const records = createSpaceRecords({ dataDir: root });
  records.write(ID, { placeId: place.id, name: 'Fixture', network: { mode: 'open', domains: [] }, repository: PROJECT, spacePath: `/spaces/${ID}/project` });
  const definition = { id: 'gateway', name: 'Gateway', package: 'aisdk:@ai-sdk/openai-compatible',
    baseURL: 'https://gateway.example/v1', headers: {}, models: {}, key: 'agent-custom-key' };
  const rows = ['openai', 'github-copilot'].map((provider) => ({ id: `cred_${provider}`, integrationID: provider, label: 'default', active: true,
    value: { type: 'oauth', methodID: provider === 'openai' ? 'chatgpt-browser' : 'device', access: `agent-${provider}`, refresh: '', expires: 9_999_999_999_999, metadata: {} } }));
  const upstream = {
    origin: 'http://localhost:12345',
    fetch: async () => Response.json({ data: rows }),
    request: async ({ path: route }) => Object.assign(Readable.from([Buffer.from(JSON.stringify(route.includes('/secret?') ? { value: 'agent-env-key' } : definition))]), { statusCode: 200, complete: true }),
  };
  configureOpenCodeCredentials(createAgentCredentialSource(upstream));
  const credentials = adapters ? createAgentHostCredentials(upstream) : null;
  const host = createSpacesHost({ frontDoor: true, dataDir: root, place, hostEnvironment: { MODEL_KEY: 'front-door-decoy' },
    hostProviders: credentials?.hostProviders, readHostSecret: credentials?.readHostSecret, makeGatekeeperChannel, makeSpaceOpenCode,
    listProjectDirectories: async () => [PROJECT], logger: { warn() {}, info() {} } });
  cleanups.push(() => host.close());
  return { host, records, root };
};

describe('front-door Space grant wiring', () => {
  it.each([
    [{ kind: 'custom', provider: 'gateway' }, 'agent-custom-key'],
    [{ kind: 'model', provider: 'openai', upstream: 'https://api.openai.com/v1', secret: { kind: 'env', name: 'MODEL_KEY' } }, 'agent-env-key'],
    [{ kind: 'login', provider: 'openai' }, 'agent-openai'],
    [{ kind: 'login', provider: 'github-copilot' }, 'agent-github-copilot'],
  ])('delivers the agent credential for %j to the gatekeeper', async (grant, secret) => {
    // Given a front-door host, agent credential adapters and an existing running space.
    const { host, root } = await setup();
    // When the owner grants model access.
    await host.journey.grantAccess(ID, grant);
    // Then the gatekeeper receives the agent value and the persisted record contains no value.
    expect(addGrant).toHaveBeenCalledWith(ID, expect.objectContaining({ id: grant.provider, secret }));
    const record = fs.readFileSync(path.join(root, 'spaces/records', `${ID}.json`), 'utf8');
    expect(record).not.toContain(secret);
    expect(record).not.toContain('front-door-decoy');
  });
  it('awaits the agent env read when restoring grants after a host restart', async () => {
    // Given a persisted environment grant and a gatekeeper that forgot it.
    const { host, records } = await setup();
    records.update(ID, { grants: [{ kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'MODEL_KEY' } }] });
    // When the host restores lost grants. Then the asynchronous agent value reaches the gatekeeper.
    await host.journey.restoreLostGrants();
    expect(addGrant).toHaveBeenCalledWith(ID, expect.objectContaining({ secret: 'agent-env-key' }));
  });
  it.each([
    { kind: 'custom', provider: 'gateway' },
    { kind: 'model', provider: 'openai', upstream: 'https://api.openai.com/v1', secret: { kind: 'env', name: 'MODEL_KEY' } },
  ])('refuses %j when the agent adapter is missing', async (grant) => {
    // Given a front door with owner decoy credentials and no agent reader.
    const { host } = await setup(false);
    // When a grant needs that reader. Then no owner credential reaches the gatekeeper.
    await expect(host.journey.grantAccess(ID, grant)).rejects.toMatchObject({ code: 'agent_host_credential_unavailable' });
    expect(addGrant).not.toHaveBeenCalled();
  });
  it('allows custom-provider discovery through the front-door gate', async () => {
    // Given the real front-door gate ahead of a local Spaces handler.
    const app = express();
    app.use(frontDoorRequestGate);
    app.get('/api/openchamber/spaces/custom-providers', (_req, res) => res.json({ providers: ['agent-provider'] }));
    // When discovery is requested. Then the local handler remains reachable.
    expect((await request(app).get('/api/openchamber/spaces/custom-providers?directory=/agent/project')).body).toEqual({ providers: ['agent-provider'] });
  });
  it.each(['/api/openchamber/host-credentials/credentials', '/API/openchamber/host-credentials/secret?name=MODEL_KEY'])('keeps private credential reads off the owner client API at %s', async (route) => {
    // Given the front-door gate ahead of forwarding.
    const app = express();
    app.use(frontDoorRequestGate);
    app.use((_req, res) => res.json({ value: 'must-not-reach' }));
    // When a UI client requests the agent-only namespace. Then it cannot receive credential bodies.
    expect((await request(app).get(route)).body).toEqual({ code: 'front_door_refused' });
  });
});
