import { describe, expect, it } from 'vitest';
import {
  evaluateDiscordAccess,
  normalizeTrustedBotIds,
} from './discord-access.js';

describe('discord access control', () => {
  it('allows guild owner, administrator, manage-guild and OpenChamber role', () => {
    expect(evaluateDiscordAccess({ userId: 'u1', guildId: 'g1', guildOwnerId: 'u1' })).toMatchObject({
      allowed: true,
      reason: 'guild-owner',
    });
    expect(evaluateDiscordAccess({ userId: 'u2', guildId: 'g1', permissions: '8' })).toMatchObject({
      allowed: true,
      reason: 'administrator',
    });
    expect(evaluateDiscordAccess({ userId: 'u3', guildId: 'g1', permissions: '32' })).toMatchObject({
      allowed: true,
      reason: 'manage-guild',
    });
    expect(evaluateDiscordAccess({ userId: 'u4', guildId: 'g1', roleNames: ['openchamber'] })).toMatchObject({
      allowed: true,
      reason: 'allow-role',
    });
  });

  it('blocks no-openchamber even for otherwise privileged users', () => {
    expect(
      evaluateDiscordAccess({
        userId: 'owner',
        guildId: 'g1',
        guildOwnerId: 'owner',
        permissions: '8',
        roleNames: ['no-openchamber', 'OpenChamber'],
      }),
    ).toMatchObject({ allowed: false, reason: 'blocked-role' });
  });

  it('denies unprivileged humans and guild-less humans', () => {
    expect(evaluateDiscordAccess({ userId: 'u1', guildId: 'g1' })).toMatchObject({
      allowed: false,
      reason: 'not-privileged',
    });
    expect(evaluateDiscordAccess({ userId: 'u1', guildId: null })).toMatchObject({
      allowed: false,
      reason: 'no-guild',
    });
  });

  it('ignores bots by default but allows trusted bots or bots with the role', () => {
    expect(evaluateDiscordAccess({ userId: 'b1', isBot: true, guildId: 'g1' })).toMatchObject({
      allowed: false,
      reason: 'bot-not-trusted',
    });
    expect(
      evaluateDiscordAccess({
        userId: 'b1',
        isBot: true,
        guildId: 'g1',
        trustedBotIds: ['b1'],
      }),
    ).toMatchObject({ allowed: true, reason: 'trusted-bot' });
    expect(
      evaluateDiscordAccess({
        userId: 'b2',
        isBot: true,
        guildId: 'g1',
        roleNames: ['OpenChamber'],
      }),
    ).toMatchObject({ allowed: true, reason: 'bot-allow-role' });
  });

  it('normalizes trusted bot IDs from text or arrays', () => {
    expect(normalizeTrustedBotIds('1, 2\n3 2')).toEqual(['1', '2', '3']);
    expect(normalizeTrustedBotIds(['4', '', '4', '5'])).toEqual(['4', '5']);
  });
});
