import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createBotsConfig, parseConfigEdit } from './config.js';
import { botSpaceSchema, readBotSpaceOptions } from './space-options.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const definition = (space) => ({ id: 'bot', name: 'Bot', mission: 'Check changes', isolated: true, space });
const grant = { kind: 'model', provider: 'openai', upstream: 'https://models.example.com/v1', secret: { kind: 'env', name: 'BOT_MODEL_KEY' } };
const space = { placeId: 'docker-ssh', network: { mode: 'allowlist', domains: ['registry.npmjs.org'] }, grants: [grant, { kind: 'custom', provider: 'local-model' }, { kind: 'login', provider: 'github-copilot' }] };

it('persists exact space references when a bot configuration is saved and reopened', async () => {
  // Given real project persistence and explicit grants, unrelated to host defaults.
  const directory = await fs.mkdtemp('/tmp/opencode/bot-space-config-');
  directories.push(directory);
  const runtime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory });
  const config = createBotsConfig({ projectConfigRuntime: runtime });

  // When the bot is saved and another config owner reads it.
  await config.update('project', { definitions: [definition(space)] });
  const reopened = await createBotsConfig({ projectConfigRuntime: runtime }).read('project');

  // Then all selected references survive without resolving any credential.
  expect(reopened.definitions[0].space).toEqual(space);
});

it.each([
  { ...space, token: 'never-store-this' },
  { ...space, setupCommands: ['echo unexpected'] },
  { ...space, network: { ...space.network, token: 'never-store-this' } },
  { ...space, grants: [{ ...grant, secret: { kind: 'typed', value: 'never-store-this' } }] },
  { ...space, grants: [{ ...grant, secret: { kind: 'env', name: 'BOT_MODEL_KEY', value: 'never-store-this' } }] },
  { ...space, grants: [{ ...grant, apiKey: 'never-store-this' }] },
  { ...space, grants: [{ kind: 'login', provider: 'openai', token: 'never-store-this' }] },
  { ...space, grants: [{ kind: 'custom', provider: 'local-model', headers: { Authorization: 'never-store-this' } }] },
  { ...space, grants: [{ ...grant, upstream: 'https://user:password@models.example.com/v1' }] },
  { ...space, grants: [{ ...grant, upstream: 'https://models.example.com/v1?api_key=secret' }] },
  { ...space, grants: [{ ...grant, upstream: 'https://models.example.com/v1#secret' }] },
])('rejects secret-bearing or out-of-scope input when editing space options %#', (unsafe) => {
  // Given an otherwise valid bot with a secret-bearing or unsupported space field.
  const input = { definitions: [definition(unsafe)] };

  // When it crosses the persisted configuration boundary.
  const save = () => parseConfigEdit(input);

  // Then the entire edit is refused, never silently stripped into a valid grant.
  expect(save).toThrow();
});

it.each(space.grants)('projects only the selected provider when resolving a stage %#', (selected) => {
  // Given several independently approved provider references.
  const selection = { providerID: selected.provider, modelID: 'selected-model' };

  // When the host resolves this stage's options.
  const options = readBotSpaceOptions(space, selection);

  // Then another provider gains no access as a side effect.
  expect(options).toEqual({ placeId: 'docker-ssh', network: space.network, setupCommands: [], grants: [selected] });
});

it('uses an empty network allowlist when only explicit model access is configured', () => {
  // Given a bot with no requested extra network access or place override.
  const configured = { grants: [grant] };

  // When its selected provider is resolved.
  const options = readBotSpaceOptions(configured, { providerID: 'openai' });

  // Then the host receives no setup commands or implicit network domains.
  expect(options).toEqual({ network: { mode: 'allowlist', domains: [] }, setupCommands: [], grants: [grant] });
});

it.each([undefined, {}, space])('requires attention when the selected provider has no explicit grant %#', (configured) => {
  // Given an absent or unrelated provider selection.
  const selection = { providerID: 'unselected-provider' };

  // When its isolated options are requested.
  const resolve = () => readBotSpaceOptions(configured, selection);

  // Then resolution stops before any host fallback or credential lookup.
  expect(resolve).toThrow(expect.objectContaining({ code: 'BOT_ISOLATED_MODEL_GRANT_REQUIRED', state: 'needs-you' }));
});

it('preserves hidden space configuration when isolation is turned off', () => {
  // Given configured isolated execution.
  const bot = definition(space);

  // When the user disables isolation and saves the definition.
  const saved = parseConfigEdit({ definitions: [{ ...bot, isolated: false }] });

  // Then the references remain available for a later explicit re-enable.
  expect(saved.definitions[0].space).toEqual(space);
});

it.each(['https://example.com', '*.example.com', '127.0.0.1', 'example.com:443', 'localhost', 'auth.openai.com?token=value'])('rejects an invalid allowlist entry %s', (domain) => {
  // Given something the corridor does not accept as an exact domain name.
  const network = { mode: 'allowlist', domains: [domain] };

  // When it crosses the bot configuration boundary.
  const result = botSpaceSchema.safeParse({ ...space, network });

  // Then the invalid network cannot persist.
  expect(result.success).toBe(false);
});

it.each([
  { ...space, grants: [grant, { kind: 'login', provider: grant.provider }] },
  { ...space, grants: [{ ...grant, secret: { kind: 'env', name: 'KEY=value' } }] },
  { ...space, grants: [{ kind: 'domain', upstream: 'https://example.com' }] },
  { ...space, grants: Array.from({ length: 17 }, (_, index) => ({ kind: 'custom', provider: `custom-${index}` })) },
  { ...space, network: { mode: 'allowlist', domains: Array.from({ length: 201 }, (_, index) => `registry-${index}.example.com`) } },
  null,
])('refuses ambiguous, malformed or oversized space configuration %#', (configured) => {
  // Given a configuration outside the Spaces creation contract.
  const input = { definitions: [definition(configured)] };

  // When an edit is parsed.
  const save = () => parseConfigEdit(input);

  // Then no partial grant or network policy is accepted.
  expect(save).toThrow();
});

it('retains saved options when a later secret-bearing write fails', async () => {
  // Given previously persisted safe options.
  const directory = await fs.mkdtemp('/tmp/opencode/bot-space-config-');
  directories.push(directory);
  const runtime = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: directory });
  const config = createBotsConfig({ projectConfigRuntime: runtime });
  await config.update('project', { definitions: [definition(space)] });

  // When a later write tries to persist a literal secret.
  const write = config.update('project', { definitions: [definition({ ...space, grants: [{ ...grant, secret: { kind: 'typed', value: 'rejected-secret' } }] })] });

  // Then it fails and the saved references remain intact.
  await expect(write).rejects.toThrow();
  expect((await config.read('project')).definitions[0].space).toEqual(space);
});
