import { describe, expect, test } from 'bun:test';
import { configuredBot } from './bots.fixture';
import { botDefinitionSchema } from './config';

describe('bot Discord configuration', () => {
  test('preserves exact channel IDs when a definition round-trips through JSON', () => {
    // Given IDs larger than JavaScript can represent as safe integers.
    const channels = [{ guildId: '123456789012345678', channelId: '987654321098765432' }];
    const definition = { ...configuredBot(), discord: { channels } };

    // When the persisted definition is parsed.
    const result = botDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)));

    // Then both IDs survive without numeric conversion or discarded channels.
    expect(result.discord).toEqual({ channels });
  });

  for (const discord of [undefined, {}]) test(`defaults to no channels when an older definition has discord=${JSON.stringify(discord)}`, () => {
    // Given a definition written before channels were configurable.
    const definition = { ...configuredBot(), discord };

    // When it loads through the public config boundary.
    const result = botDefinitionSchema.parse(definition);

    // Then no implicit global channel is selected.
    expect(result.discord).toEqual({ channels: [] });
  });

  for (const guildId of ['', '12345', '0123456', 'guild-id', '1'.repeat(26), 123456789]) test(`rejects an invalid Discord ID ${JSON.stringify(guildId)}`, () => {
    // Given an invalid guild ID in an otherwise valid definition.
    const definition = { ...configuredBot(), discord: { channels: [{ guildId, channelId: '123456789012345678' }] } };

    // When the definition is submitted.
    const result = botDefinitionSchema.safeParse(definition);

    // Then the invalid destination cannot become configuration.
    expect(result.success).toBe(false);
  });

  test('rejects duplicate channel pairs when the same destination is entered twice', () => {
    // Given the same exact destination twice.
    const channel = { guildId: '123456789012345678', channelId: '987654321098765432' };

    // When the definition is parsed.
    const result = botDefinitionSchema.safeParse({ ...configuredBot(), discord: { channels: [channel, channel] } });

    // Then the duplicate list is rejected like the server contract.
    expect(result.success).toBe(false);
  });

  test('rejects more than 100 channels when the destination list exceeds the server limit', () => {
    // Given 101 distinct destinations.
    const channels = Array.from({ length: 101 }, (_, index) => ({ guildId: '123456789012345678', channelId: `${100000 + index}` }));

    // When the definition is submitted.
    const result = botDefinitionSchema.safeParse({ ...configuredBot(), discord: { channels } });

    // Then oversized configuration is rejected before sending.
    expect(result.success).toBe(false);
  });
});
