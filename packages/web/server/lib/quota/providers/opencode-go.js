import { readAuthFile } from '../../opencode/auth.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
} from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go'];
const OPENCHAMBER_SETTINGS_FILE = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

const getApiKey = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return entry?.key ?? entry?.token ?? entry?.access ?? null;
};

const normalizeSessionCookie = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Users will often paste the raw auth cookie token from the browser.
  // The dashboard expects it as `auth=<token>`.
  if (!trimmed.includes('=')) {
    return `auth=${trimmed}`;
  }

  return trimmed;
};

const readOpenChamberSettings = () => {
  try {
    if (!fs.existsSync(OPENCHAMBER_SETTINGS_FILE)) {
      return null;
    }
    const content = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8').trim();
    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const getDashboardAccess = (settings) => {
  const workspaceFromSettings = typeof settings?.opencodeGoWorkspaceId === 'string'
    ? settings.opencodeGoWorkspaceId.trim()
    : '';
  const cookieFromSettings = typeof settings?.opencodeGoSessionCookie === 'string'
    ? settings.opencodeGoSessionCookie.trim()
    : '';
  const workspaceFromEnv = typeof process?.env?.OPENCODE_GO_WORKSPACE_ID === 'string'
    ? process.env.OPENCODE_GO_WORKSPACE_ID.trim()
    : '';
  const cookieFromEnv = typeof process?.env?.OPENCODE_GO_SESSION_COOKIE === 'string'
    ? process.env.OPENCODE_GO_SESSION_COOKIE.trim()
    : '';

  return {
    workspaceId: workspaceFromSettings || workspaceFromEnv || null,
    sessionCookie: cookieFromSettings || cookieFromEnv || null,
  };
};

const toResetAt = (seconds) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Date.now() + seconds * 1000;
};

const parseResetDurationSeconds = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim().toLowerCase();
  if (!text) {
    return null;
  }

  if (text.includes('few seconds')) {
    return 15;
  }

  const matches = Array.from(text.matchAll(/(\d+)\s+(day|days|hour|hours|minute|minutes)/g));
  if (matches.length === 0) {
    return null;
  }

  let total = 0;
  for (const match of matches) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    if (!Number.isFinite(amount)) {
      continue;
    }
    if (unit.startsWith('day')) {
      total += amount * 24 * 60 * 60;
    } else if (unit.startsWith('hour')) {
      total += amount * 60 * 60;
    } else if (unit.startsWith('minute')) {
      total += amount * 60;
    }
  }

  return total > 0 ? total : null;
};

const stripHtmlComments = (value) => value.replace(/<!--[^]*?-->/g, '');

const normalizeText = (value) => value.replace(/\s+/g, ' ').trim();

const parseSubscriptionFromDashboardHtml = (html) => {
  if (typeof html !== 'string' || !html.includes('You are subscribed to OpenCode Go.')) {
    return null;
  }

  const sanitizedHtml = stripHtmlComments(html);
  const sectionMatch = sanitizedHtml.match(/<div data-slot="usage">([\s\S]*?)<\/div><form action=/);
  const section = sectionMatch?.[1] ?? null;
  if (!section) {
    return null;
  }

  const usageByKey = {};
  const usageMatches = Array.from(section.matchAll(
    /<div data-slot="usage-item">[\s\S]*?<span data-slot="usage-label">([^<]+)<\/span><span data-slot="usage-value">(\d+)%<\/span>[\s\S]*?<span data-slot="reset-time">\s*Resets in\s*([^<]+)<\/span>[\s\S]*?<\/div>/g
  ));

  for (const match of usageMatches) {
    const label = normalizeText(match?.[1] ?? '').toLowerCase();

    let key = null;
    if (label === 'rolling usage') key = 'rollingUsage';
    if (label === 'weekly usage') key = 'weeklyUsage';
    if (label === 'monthly usage') key = 'monthlyUsage';
    if (!key) {
      continue;
    }

    const usedPercent = Number.parseInt(match[2], 10);
    const resetSeconds = parseResetDurationSeconds(normalizeText(match[3] ?? ''));
    usageByKey[key] = {
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      resetAt: toResetAt(resetSeconds),
    };
  }

  if (!usageByKey.rollingUsage || !usageByKey.weeklyUsage || !usageByKey.monthlyUsage) {
    return null;
  }

  return usageByKey;
};

const buildUsageFromSubscription = (subscription) => {
  const rollingUsage = subscription?.rollingUsage;
  const weeklyUsage = subscription?.weeklyUsage;
  const monthlyUsage = subscription?.monthlyUsage;

  if (!rollingUsage || !weeklyUsage || !monthlyUsage) {
    return null;
  }

  return {
    windows: {
      rolling: toUsageWindow({
        usedPercent: typeof rollingUsage.usedPercent === 'number' ? rollingUsage.usedPercent : null,
        resetAt: rollingUsage.resetAt ?? null,
        windowSeconds: null,
      }),
      weekly: toUsageWindow({
        usedPercent: typeof weeklyUsage.usedPercent === 'number' ? weeklyUsage.usedPercent : null,
        resetAt: weeklyUsage.resetAt ?? null,
        windowSeconds: 7 * 24 * 60 * 60,
      }),
      monthly: toUsageWindow({
        usedPercent: typeof monthlyUsage.usedPercent === 'number' ? monthlyUsage.usedPercent : null,
        resetAt: monthlyUsage.resetAt ?? null,
        windowSeconds: 30 * 24 * 60 * 60,
      }),
    }
  };
};

const fetchSubscriptionViaDashboardSession = async (workspaceId, sessionCookie) => {
  const normalizedCookie = normalizeSessionCookie(sessionCookie);
  if (!normalizedCookie) {
    throw new Error('Missing dashboard session cookie');
  }

  const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: normalizedCookie,
    },
  });

  const payload = await response.text().catch(() => null);

  if (!response.ok) {
    const message = typeof payload === 'string' && payload.includes('/auth/authorize')
      ? 'Dashboard session is not authorized for this workspace'
      : `Dashboard API error: ${response.status}`;
    throw new Error(message);
  }

  const subscription = parseSubscriptionFromDashboardHtml(payload);
  if (!subscription) {
    throw new Error('Failed to parse OpenCode Go subscription usage from dashboard page');
  }

  return subscription;
};

export const isConfigured = () => {
  return Boolean(getApiKey());
};

export const fetchQuota = async () => {
  const apiKey = getApiKey();

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    // We can validate the OpenCode Go key against the published models API,
    // but the subscription usage endpoint is not exposed in a stable public API.
    const response = await fetch('https://opencode.ai/zen/go/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
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

    const settings = readOpenChamberSettings();
    const { workspaceId, sessionCookie } = getDashboardAccess(settings);

    if (workspaceId && sessionCookie) {
      const subscription = await fetchSubscriptionViaDashboardSession(workspaceId, sessionCookie);
      const usage = buildUsageFromSubscription(subscription);

      if (usage) {
        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage,
        });
      }
    }

    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'OpenCode Go is configured, but its subscription usage needs dashboard access details saved in OpenCode Go usage settings.'
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
