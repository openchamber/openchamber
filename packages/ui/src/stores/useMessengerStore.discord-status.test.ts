import { describe, expect, test } from 'bun:test';
import { deriveDiscordDisplayStatus } from './useMessengerStore';

describe('deriveDiscordDisplayStatus', () => {
  test('prefers a live gateway over persisted disconnected verify status', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        discordListenerRunning: true,
        discordListenerConnected: true,
      }),
    ).toBe('connected');
  });

  test('shows connecting while the gateway is running but not yet READY', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        discordListenerRunning: true,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  test('shows connecting when a token exists but live state is not reconciled yet', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        botToken: 'tok',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  test('keeps an in-flight token verify as connecting', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'connecting',
        botToken: 'tok',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  test('falls back to the last token-verify result when the listener is off', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'connected',
        botToken: 'tok',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connected');
    expect(
      deriveDiscordDisplayStatus({
        status: 'error',
        botToken: 'tok',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('error');
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        botToken: undefined,
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('disconnected');
  });
});
