import { describe, expect, it } from 'vitest';
import { deriveDiscordDisplayStatus } from './useMessengerStore';

describe('deriveDiscordDisplayStatus', () => {
  it('prefers a live gateway over persisted disconnected verify status', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        discordListenerRunning: true,
        discordListenerConnected: true,
      }),
    ).toBe('connected');
  });

  it('shows connecting while the gateway is running but not yet READY', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        discordListenerRunning: true,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  it('keeps an in-flight token verify as connecting', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'connecting',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });

  it('falls back to the last token-verify result when the listener is off', () => {
    expect(
      deriveDiscordDisplayStatus({
        status: 'connected',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connected');
    expect(
      deriveDiscordDisplayStatus({
        status: 'error',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('error');
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('disconnected');
  });
});
