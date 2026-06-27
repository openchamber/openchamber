import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow
} from '../utils/index.js';

const providerId = 'openai';
const providerName = 'OpenAI';
const aliases = ['openai', 'codex', 'chatgpt'];

const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;

    const windows = {};
    if (primary) {
      windows['5h'] = toUsageWindow({
        usedPercent: primary.used_percent ?? null,
        windowSeconds: primary.limit_window_seconds ?? null,
        resetAt: primary.reset_after_seconds != null ? Date.now() + primary.reset_after_seconds * 1000 : null,
        suffix: 'primary',
        trendKey: 'openai:5h'
      });
    }
    if (secondary) {
      windows['weekly'] = toUsageWindow({
        usedPercent: secondary.used_percent ?? null,
        windowSeconds: secondary.limit_window_seconds ?? null,
        resetAt: secondary.reset_after_seconds != null ? Date.now() + secondary.reset_after_seconds * 1000 : null,
        suffix: 'weekly cap',
        trendKey: 'openai:weekly'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows, subtitle: 'ChatGPT subscription' }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
