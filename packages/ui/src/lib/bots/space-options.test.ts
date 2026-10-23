import { describe, expect, test } from 'bun:test';
import { botDefinitionSchema, botSpaceSchema } from './config';
import { configuredBot } from './bots.fixture';

const grant = { kind: 'model', provider: 'openai', upstream: 'https://models.example.com/v1', secret: { kind: 'env', name: 'BOT_MODEL_KEY' } } as const;
const space = { placeId: 'docker-ssh', network: { mode: 'allowlist', domains: ['registry.npmjs.org'] }, grants: [grant, { kind: 'custom', provider: 'local' }, { kind: 'login', provider: 'github-copilot' }] } as const;

describe('bot space configuration', () => {
  test('preserves exact references when a definition round-trips with isolation disabled', () => {
    // Given retained options while isolation is off.
    const definition = { ...configuredBot(), isolated: false, space };

    // When the public definition crosses JSON persistence.
    const parsed = botDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)));

    // Then turning isolation off has erased no choices.
    expect(parsed.space).toEqual(space);
  });

  test('keeps old definitions grant-free when space options are absent', () => {
    // Given a definition from before space options existed.
    const definition = configuredBot();

    // When the client parses it.
    const parsed = botDefinitionSchema.parse(definition);

    // Then no implicit access is added.
    expect(parsed.space).toBeUndefined();
  });

  test('defaults the network to closed when only selected access is supplied', () => {
    // Given one explicitly selected environment reference.
    const configured = { grants: [grant] };

    // When space options are parsed.
    const parsed = botSpaceSchema.parse(configured);

    // Then no additional domain is opened.
    expect(parsed.network).toEqual({ mode: 'allowlist', domains: [] });
  });

  const unsafeGrants = [
    { ...grant, secret: { kind: 'typed', value: 'rejected-secret' } },
    { ...grant, secret: { ...grant.secret, value: 'rejected-secret' } },
    { ...grant, upstream: 'https://user:secret@models.example.com' },
    { ...grant, upstream: 'https://models.example.com?key=secret' },
    { ...grant, upstream: 'file:///private/key' },
    { kind: 'custom', provider: 'local', token: 'rejected-secret' },
  ];
  for (const [index, unsafe] of unsafeGrants.entries()) test(`rejects secret-bearing or unsupported grant input ${index}`, () => {
    // Given a grant that carries more authority than a reference.
    const definition = { ...configuredBot(), space: { ...space, grants: [unsafe] } };

    // When the edit is parsed before sending.
    const parsed = botDefinitionSchema.safeParse(definition);

    // Then no secret-bearing request can be submitted.
    expect(parsed.success).toBe(false);
  });
});
