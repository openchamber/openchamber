import { describe, expect, test } from 'bun:test';
import { deriveDiscordDisplayStatus, deriveDiscordViewState } from './useMessengerStore';

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
        discordServerConfigured: false,
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('disconnected');
  });

  test('server-configured without a local token shows connecting (not disconnected)', () => {
    // When the server reports configured but the local store lost the token,
    // the badge must say "connecting" — never "disconnected" — so the user
    // knows the bot is configured server-side.
    expect(
      deriveDiscordDisplayStatus({
        status: 'disconnected',
        botToken: undefined,
        discordServerConfigured: true,
        discordListenerRunning: false,
        discordListenerConnected: false,
      }),
    ).toBe('connecting');
  });
});

describe('deriveDiscordViewState', () => {
  test('fresh state (no token, no wizard) shows the square connect card', () => {
    expect(
      deriveDiscordViewState({ hasToken: false, serverConfigured: false, wizardActive: false }),
    ).toBe('connect-card');
  });

  test('a stale persisted connection without a token still shows the connect card', () => {
    // Regression: an unfinished onboarding persisted an empty discord
    // connection while onboardingStep was lost, hiding the connect card and
    // flashing a bare token field instead.
    expect(
      deriveDiscordViewState({ hasToken: false, serverConfigured: false, wizardActive: false }),
    ).toBe('connect-card');
  });

  test('active onboarding shows the wizard, with or without a token', () => {
    expect(
      deriveDiscordViewState({ hasToken: false, serverConfigured: false, wizardActive: true }),
    ).toBe('wizard');
    expect(
      deriveDiscordViewState({ hasToken: true, serverConfigured: false, wizardActive: true }),
    ).toBe('wizard');
  });

  test('a saved token without active onboarding shows the configured view', () => {
    // Persistent appearance: after reload the wizard state is gone but the
    // token persists — the configured view must be stable regardless of the
    // transient verify/listener status.
    expect(
      deriveDiscordViewState({ hasToken: true, serverConfigured: false, wizardActive: false }),
    ).toBe('configured');
  });

  test('server-configured without a local token shows the configured view', () => {
    // Recovery from localStorage loss: the server has a working bot configured,
    // but the local store doesn't have the token.  Must show the full
    // connection card, not the connect tile.
    expect(
      deriveDiscordViewState({ hasToken: false, serverConfigured: true, wizardActive: false }),
    ).toBe('configured');
  });

  test('neither token nor server-configured shows the connect card', () => {
    expect(
      deriveDiscordViewState({ hasToken: false, serverConfigured: false, wizardActive: false }),
    ).toBe('connect-card');
  });
});
