import { describe, expect, it, vi } from 'vitest';

import {
  MessengerValidationError,
  buildDiscordMessage,
  buildSlackMessage,
  createMessengersRuntime,
  describeMessengerSettings,
  isValidMessengerWebhookUrl,
  mergeMessengerSettingsUpdate,
  sanitizeMessengerSettings,
} from './messengers-runtime.js';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';
const DISCORD_URL = 'https://discord.com/api/webhooks/123456/token-abc';

const okResponse = () => ({ ok: true, status: 200 });

const createRuntime = ({ settings = {}, fetchImpl = vi.fn(async () => okResponse()), writeSettingsToDisk = vi.fn(async () => {}) } = {}) => {
  const runtime = createMessengersRuntime({
    readSettingsFromDiskMigrated: async () => settings,
    writeSettingsToDisk,
    fetchImpl,
  });
  return { runtime, fetchImpl, writeSettingsToDisk };
};

describe('isValidMessengerWebhookUrl', () => {
  it('accepts official webhook hosts only', () => {
    expect(isValidMessengerWebhookUrl('slack', SLACK_URL)).toBe(true);
    expect(isValidMessengerWebhookUrl('discord', DISCORD_URL)).toBe(true);
    expect(isValidMessengerWebhookUrl('discord', 'https://discordapp.com/api/webhooks/1/t')).toBe(true);
  });

  it('rejects non-https, wrong hosts, wrong paths, and junk', () => {
    expect(isValidMessengerWebhookUrl('slack', 'http://hooks.slack.com/services/T/B/X')).toBe(false);
    expect(isValidMessengerWebhookUrl('slack', 'https://evil.com/services/T/B/X')).toBe(false);
    expect(isValidMessengerWebhookUrl('slack', 'https://hooks.slack.com.evil.com/services/T/B/X')).toBe(false);
    expect(isValidMessengerWebhookUrl('slack', 'https://hooks.slack.com/other/T/B/X')).toBe(false);
    expect(isValidMessengerWebhookUrl('discord', 'https://discord.com/channels/1/2')).toBe(false);
    expect(isValidMessengerWebhookUrl('discord', 'https://user:pass@discord.com/api/webhooks/1/t')).toBe(false);
    expect(isValidMessengerWebhookUrl('slack', '')).toBe(false);
    expect(isValidMessengerWebhookUrl('slack', 'not a url')).toBe(false);
    expect(isValidMessengerWebhookUrl('telegram', SLACK_URL)).toBe(false);
  });
});

describe('message builders', () => {
  it('builds Slack mrkdwn with escaped entities', () => {
    const message = buildSlackMessage({ title: 'Agent <ready> & done', body: 'line' });
    expect(message.text).toBe('*Agent &lt;ready&gt; &amp; done*\nline');
  });

  it('builds Discord content with mention pings disabled', () => {
    const message = buildDiscordMessage({ title: 'Done', body: '@everyone hi' });
    expect(message.content).toBe('**Done**\n@everyone hi');
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it('truncates Discord content to its 2000-char limit', () => {
    const message = buildDiscordMessage({ title: 'T', body: 'x'.repeat(3000) });
    expect(message.content.length).toBeLessThanOrEqual(2000);
    expect(message.content.endsWith('…')).toBe(true);
  });

  it('appends a session link when provided', () => {
    expect(buildSlackMessage({ title: 'T', body: 'B', linkUrl: 'https://x.dev/?session=1' }).text)
      .toContain('<https://x.dev/?session=1|Open session>');
    expect(buildDiscordMessage({ title: 'T', body: 'B', linkUrl: 'https://x.dev/?session=1' }).content)
      .toContain('<https://x.dev/?session=1>');
  });
});

describe('sanitize / merge / describe', () => {
  it('normalizes missing or malformed stored settings', () => {
    expect(sanitizeMessengerSettings(undefined)).toEqual({
      slack: { enabled: false, webhookUrl: '' },
      discord: { enabled: false, webhookUrl: '' },
    });
    expect(sanitizeMessengerSettings({ slack: 'junk', discord: { enabled: 'yes', webhookUrl: 42 } })).toEqual({
      slack: { enabled: false, webhookUrl: '' },
      discord: { enabled: false, webhookUrl: '' },
    });
  });

  it('preserves the stored webhook URL when an update omits it', () => {
    const current = { slack: { enabled: false, webhookUrl: SLACK_URL } };
    const next = mergeMessengerSettingsUpdate(current, { slack: { enabled: true } });
    expect(next.slack).toEqual({ enabled: true, webhookUrl: SLACK_URL });
  });

  it('clears the webhook URL on null or empty string', () => {
    const current = { discord: { enabled: true, webhookUrl: DISCORD_URL } };
    expect(mergeMessengerSettingsUpdate(current, { discord: { webhookUrl: null } }).discord.webhookUrl).toBe('');
    expect(mergeMessengerSettingsUpdate(current, { discord: { webhookUrl: '  ' } }).discord.webhookUrl).toBe('');
  });

  it('throws MessengerValidationError for an invalid webhook URL', () => {
    expect(() => mergeMessengerSettingsUpdate({}, { slack: { webhookUrl: 'https://evil.com/services/x' } }))
      .toThrow(MessengerValidationError);
  });

  it('ignores unknown providers and non-object patches', () => {
    const next = mergeMessengerSettingsUpdate({}, { telegram: { enabled: true }, slack: 'junk' });
    expect(next).toEqual({
      slack: { enabled: false, webhookUrl: '' },
      discord: { enabled: false, webhookUrl: '' },
    });
  });

  it('never exposes webhook URLs in the public shape', () => {
    const described = describeMessengerSettings({
      slack: { enabled: true, webhookUrl: SLACK_URL },
      discord: { enabled: false, webhookUrl: '' },
    });
    expect(described).toEqual({
      slack: { enabled: true, webhookConfigured: true },
      discord: { enabled: false, webhookConfigured: false },
    });
    expect(JSON.stringify(described)).not.toContain('hooks.slack.com');
  });
});

describe('sendMessengerNotification', () => {
  const payload = { title: 'Agent is ready', body: 'Task complete', data: { url: '/?session=abc', type: 'ready' } };

  it('does nothing when no messenger is enabled', async () => {
    const { runtime, fetchImpl } = createRuntime({
      settings: { messengerNotifications: { slack: { enabled: false, webhookUrl: SLACK_URL } } },
    });
    await runtime.sendMessengerNotification(payload);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips an enabled provider whose stored URL is invalid', async () => {
    const { runtime, fetchImpl } = createRuntime({
      settings: { messengerNotifications: { slack: { enabled: true, webhookUrl: 'https://evil.com/services/x' } } },
    });
    await runtime.sendMessengerNotification(payload);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts provider-specific payloads to every enabled messenger', async () => {
    const { runtime, fetchImpl } = createRuntime({
      settings: {
        publicOrigin: 'https://my.openchamber.dev',
        messengerNotifications: {
          slack: { enabled: true, webhookUrl: SLACK_URL },
          discord: { enabled: true, webhookUrl: DISCORD_URL },
        },
      },
    });

    await runtime.sendMessengerNotification(payload);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = new Map(fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]));
    expect(calls.get(SLACK_URL).text).toContain('*Agent is ready*');
    expect(calls.get(SLACK_URL).text).toContain('<https://my.openchamber.dev/?session=abc|Open session>');
    expect(calls.get(DISCORD_URL).content).toContain('**Agent is ready**');
    expect(calls.get(DISCORD_URL).allowed_mentions).toEqual({ parse: [] });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
    }
  });

  it('omits the session link when no publicOrigin is configured', async () => {
    const { runtime, fetchImpl } = createRuntime({
      settings: { messengerNotifications: { slack: { enabled: true, webhookUrl: SLACK_URL } } },
    });
    await runtime.sendMessengerNotification(payload);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).text).not.toContain('Open session');
  });

  it('one failing provider does not block the other and never throws', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === SLACK_URL) throw new Error('network down');
      return okResponse();
    });
    const { runtime } = createRuntime({
      settings: {
        messengerNotifications: {
          slack: { enabled: true, webhookUrl: SLACK_URL },
          discord: { enabled: true, webhookUrl: DISCORD_URL },
        },
      },
      fetchImpl,
    });

    await expect(runtime.sendMessengerNotification(payload)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never throws when settings cannot be read', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const runtime = createMessengersRuntime({
      readSettingsFromDiskMigrated: async () => {
        throw new Error('disk error');
      },
      writeSettingsToDisk: vi.fn(),
      fetchImpl,
    });
    await expect(runtime.sendMessengerNotification(payload)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('updateMessengerSettings', () => {
  it('persists merged settings and returns the public shape', async () => {
    const writeSettingsToDisk = vi.fn(async () => {});
    const { runtime } = createRuntime({
      settings: {
        themeId: 'keep-me',
        messengerNotifications: { slack: { enabled: false, webhookUrl: SLACK_URL } },
      },
      writeSettingsToDisk,
    });

    const result = await runtime.updateMessengerSettings({
      slack: { enabled: true },
      discord: { enabled: true, webhookUrl: DISCORD_URL },
    });

    expect(result).toEqual({
      slack: { enabled: true, webhookConfigured: true },
      discord: { enabled: true, webhookConfigured: true },
    });
    const persisted = writeSettingsToDisk.mock.calls[0][0];
    expect(persisted.themeId).toBe('keep-me');
    expect(persisted.messengerNotifications).toEqual({
      slack: { enabled: true, webhookUrl: SLACK_URL },
      discord: { enabled: true, webhookUrl: DISCORD_URL },
    });
  });

  it('rejects an invalid webhook URL without persisting anything', async () => {
    const writeSettingsToDisk = vi.fn(async () => {});
    const { runtime } = createRuntime({ writeSettingsToDisk });

    await expect(runtime.updateMessengerSettings({ slack: { webhookUrl: 'https://evil.com/x' } }))
      .rejects.toMatchObject({ code: 'invalid-webhook-url' });
    expect(writeSettingsToDisk).not.toHaveBeenCalled();
  });
});

describe('sendMessengerTest', () => {
  it('rejects unknown providers', async () => {
    const { runtime, fetchImpl } = createRuntime();
    expect(await runtime.sendMessengerTest({ provider: 'telegram' })).toEqual({ ok: false, error: 'invalid-provider' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports not-configured when there is no stored or override URL', async () => {
    const { runtime } = createRuntime();
    expect(await runtime.sendMessengerTest({ provider: 'slack' })).toEqual({ ok: false, error: 'not-configured' });
  });

  it('validates an override URL before sending', async () => {
    const { runtime, fetchImpl } = createRuntime();
    expect(await runtime.sendMessengerTest({ provider: 'slack', webhookUrl: 'https://evil.com/services/x' }))
      .toEqual({ ok: false, error: 'invalid-webhook-url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a test message to the override URL', async () => {
    const { runtime, fetchImpl } = createRuntime();
    expect(await runtime.sendMessengerTest({ provider: 'discord', webhookUrl: DISCORD_URL })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(DISCORD_URL);
  });

  it('falls back to the stored URL and reports delivery failures', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
    const { runtime } = createRuntime({
      settings: { messengerNotifications: { slack: { enabled: true, webhookUrl: SLACK_URL } } },
      fetchImpl,
    });
    expect(await runtime.sendMessengerTest({ provider: 'slack' })).toEqual({ ok: false, error: 'delivery-failed' });
    expect(fetchImpl.mock.calls[0][0]).toBe(SLACK_URL);
  });
});
