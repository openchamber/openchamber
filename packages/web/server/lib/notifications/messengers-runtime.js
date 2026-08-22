// Messenger notification channel: posts notification fanout payloads to
// user-configured Slack / Discord incoming webhooks. Webhook URLs are secrets:
// they are persisted in settings.json under `messengerNotifications`, never
// returned to clients (only a `webhookConfigured` flag), and never logged.

const MESSENGER_PROVIDERS = ['slack', 'discord'];

const WEBHOOK_URL_MAX_LENGTH = 1024;
const SLACK_TEXT_MAX_LENGTH = 3000;
const DISCORD_CONTENT_MAX_LENGTH = 2000;
const MESSENGER_SEND_TIMEOUT_MS = 8000;

const SLACK_WEBHOOK_HOSTS = new Set(['hooks.slack.com']);
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com',
]);

// Strict host allowlists: the server posts to these URLs itself, so accepting
// arbitrary origins would turn the settings endpoint into an SSRF primitive.
export const isValidMessengerWebhookUrl = (provider, url) => {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > WEBHOOK_URL_MAX_LENGTH) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;

  if (provider === 'slack') {
    return SLACK_WEBHOOK_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith('/services/');
  }
  if (provider === 'discord') {
    return DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith('/api/webhooks/');
  }
  return false;
};

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

const truncateText = (text, maxLength) => (
  text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text
);

// Slack mrkdwn requires &, <, > to be entity-escaped in message text.
const escapeSlackText = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const buildSlackMessage = ({ title, body, linkUrl }) => {
  const safeTitle = escapeSlackText(normalizeText(title));
  const safeBody = escapeSlackText(normalizeText(body));
  const lines = [];
  if (safeTitle) lines.push(`*${safeTitle}*`);
  if (safeBody) lines.push(safeBody);
  if (typeof linkUrl === 'string' && linkUrl.length > 0) {
    lines.push(`<${linkUrl}|Open session>`);
  }
  return { text: truncateText(lines.join('\n'), SLACK_TEXT_MAX_LENGTH) };
};

export const buildDiscordMessage = ({ title, body, linkUrl }) => {
  const safeTitle = normalizeText(title);
  const safeBody = normalizeText(body);
  const lines = [];
  if (safeTitle) lines.push(`**${safeTitle}**`);
  if (safeBody) lines.push(safeBody);
  if (typeof linkUrl === 'string' && linkUrl.length > 0) {
    // <> suppresses Discord's automatic link-preview embed.
    lines.push(`<${linkUrl}>`);
  }
  return {
    content: truncateText(lines.join('\n'), DISCORD_CONTENT_MAX_LENGTH),
    // Notification text is derived from session content; never let it ping
    // @everyone / roles / users in the target channel.
    allowed_mentions: { parse: [] },
  };
};

const sanitizeMessengerEntry = (raw) => {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const webhookUrl = typeof entry.webhookUrl === 'string' ? entry.webhookUrl.trim() : '';
  return {
    enabled: entry.enabled === true,
    webhookUrl: webhookUrl.length <= WEBHOOK_URL_MAX_LENGTH ? webhookUrl : '',
  };
};

export const sanitizeMessengerSettings = (raw) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const provider of MESSENGER_PROVIDERS) {
    result[provider] = sanitizeMessengerEntry(source[provider]);
  }
  return result;
};

export class MessengerValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MessengerValidationError';
    this.code = code;
  }
}

// Deep-merges a partial client update into the stored messenger settings.
// Webhook URLs are write-only on the client, so an update that omits
// `webhookUrl` must preserve the stored one; `null` or '' clears it.
export const mergeMessengerSettingsUpdate = (current, update) => {
  const base = sanitizeMessengerSettings(current);
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return base;
  }

  for (const provider of MESSENGER_PROVIDERS) {
    const patch = update[provider];
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;

    if (typeof patch.enabled === 'boolean') {
      base[provider].enabled = patch.enabled;
    }
    if (patch.webhookUrl === null) {
      base[provider].webhookUrl = '';
    } else if (typeof patch.webhookUrl === 'string') {
      const trimmed = patch.webhookUrl.trim();
      if (trimmed.length === 0) {
        base[provider].webhookUrl = '';
      } else if (isValidMessengerWebhookUrl(provider, trimmed)) {
        base[provider].webhookUrl = trimmed;
      } else {
        throw new MessengerValidationError(
          `Invalid ${provider} webhook URL`,
          'invalid-webhook-url',
        );
      }
    }
  }

  return base;
};

// Client-facing shape: enabled flags plus configured-state only, never the URL.
export const describeMessengerSettings = (settings) => {
  const sanitized = sanitizeMessengerSettings(settings);
  const result = {};
  for (const provider of MESSENGER_PROVIDERS) {
    result[provider] = {
      enabled: sanitized[provider].enabled,
      webhookConfigured: sanitized[provider].webhookUrl.length > 0,
    };
  }
  return result;
};

const resolveSessionLinkUrl = (settings, payload) => {
  const relative = typeof payload?.data?.url === 'string' ? payload.data.url : '';
  const publicOrigin = typeof settings?.publicOrigin === 'string' ? settings.publicOrigin.trim() : '';
  if (!relative || !publicOrigin) return undefined;
  try {
    return new URL(relative, publicOrigin).toString();
  } catch {
    return undefined;
  }
};

export const createMessengersRuntime = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    fetchImpl = fetch,
  } = dependencies;

  const deliver = async (provider, webhookUrl, message) => {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(MESSENGER_SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${provider} webhook responded with ${response.status}`);
    }
  };

  const buildMessageForProvider = (provider, payload, linkUrl) => {
    const parts = { title: payload?.title, body: payload?.body, linkUrl };
    return provider === 'slack' ? buildSlackMessage(parts) : buildDiscordMessage(parts);
  };

  const getMessengerSettingsPublic = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return describeMessengerSettings(settings?.messengerNotifications);
  };

  const updateMessengerSettings = async (update) => {
    const settings = await readSettingsFromDiskMigrated();
    const next = mergeMessengerSettingsUpdate(settings?.messengerNotifications, update);
    await writeSettingsToDisk({ ...settings, messengerNotifications: next });
    return describeMessengerSettings(next);
  };

  // Fanout channel: one messenger failing (or being misconfigured) must not
  // block the other, and delivery failures never propagate to the trigger path.
  const sendMessengerNotification = async (payload) => {
    let settings;
    try {
      settings = await readSettingsFromDiskMigrated();
    } catch (error) {
      console.warn('[Messengers] settings read failed:', error?.message ?? error);
      return;
    }

    const config = sanitizeMessengerSettings(settings?.messengerNotifications);
    const linkUrl = resolveSessionLinkUrl(settings, payload);

    await Promise.all(MESSENGER_PROVIDERS.map(async (provider) => {
      const entry = config[provider];
      if (!entry.enabled || !isValidMessengerWebhookUrl(provider, entry.webhookUrl)) {
        return;
      }
      try {
        await deliver(provider, entry.webhookUrl, buildMessageForProvider(provider, payload, linkUrl));
      } catch (error) {
        console.warn(`[Messengers] ${provider} delivery failed:`, error?.message ?? error);
      }
    }));
  };

  // Settings-page test action. `webhookUrl` lets the user verify a pasted URL
  // before saving it; otherwise the stored URL is used.
  const sendMessengerTest = async ({ provider, webhookUrl } = {}) => {
    if (!MESSENGER_PROVIDERS.includes(provider)) {
      return { ok: false, error: 'invalid-provider' };
    }

    let target = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
    if (!target) {
      const settings = await readSettingsFromDiskMigrated();
      target = sanitizeMessengerSettings(settings?.messengerNotifications)[provider].webhookUrl;
    }
    if (!target) {
      return { ok: false, error: 'not-configured' };
    }
    if (!isValidMessengerWebhookUrl(provider, target)) {
      return { ok: false, error: 'invalid-webhook-url' };
    }

    try {
      await deliver(provider, target, buildMessageForProvider(provider, {
        title: 'OpenChamber test notification',
        body: 'Messenger notifications are working.',
      }));
      return { ok: true };
    } catch (error) {
      console.warn(`[Messengers] ${provider} test delivery failed:`, error?.message ?? error);
      return { ok: false, error: 'delivery-failed' };
    }
  };

  return {
    getMessengerSettingsPublic,
    updateMessengerSettings,
    sendMessengerNotification,
    sendMessengerTest,
  };
};
