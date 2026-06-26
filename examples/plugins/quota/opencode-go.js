// Example OpenChamber quota plugin for OpenCode Go.
//
// OpenCode Go is a low-cost subscription plan that gives reliable access to
// popular open coding models through OpenCode's gateway:
//   https://opencode.ai/docs/go
//
// What this plugin actually shows
// -------------------------------
//   1.  Whether your OpenCode Go API key is valid (checks against
//       https://opencode.ai/zen/go/v1/models and counts the models).
//   2.  The dashboard usage numbers (rolling 5h / weekly / monthly) for
//       your subscription, if and only if you provide your OpenCode
//       dashboard auth cookie + workspace id.
//
// Why two pieces
// --------------
//   OpenCode Go does NOT publish a public REST endpoint for usage. The
//   live numbers only exist inside the workspace dashboard at
//   https://opencode.ai/workspace/<workspaceId>/go, which is a SolidStart
//   app behind a session cookie. There is no API key path to usage.
//
//   We don't try to probe individual Go models to "infer" usage —
//   probing tells you whether a model is reachable, not whether your
//   subscription is exhausted. Both are useful pieces of information
//   but they are not the same thing, and conflating them just produces
//   a noisy UI that doesn't answer the real question: "how much of my
//   monthly $60 cap is left?"
//
// Set up live usage (one-time, ~30 seconds)
// ----------------------------------------
//
//   1. Sign in to https://opencode.ai in any browser and open the Go
//      usage page once:
//        https://opencode.ai/workspace/<workspaceId>/go
//   2. Copy the workspace id from the URL (the part after /workspace/,
//      it starts with `wrk_`).
//   3. Open DevTools -> Application -> Cookies -> https://opencode.ai
//      and copy the value of the `auth` cookie.
//   4. Save them to ONE of:
//
//        ~/.config/opencode/opencode-quota/opencode-go.json
//        ~/.config/opencode-bar/opencode-go.json
//        ~/.config/openchamber/opencode-go.json
//        $XDG_CONFIG_HOME/opencode/opencode-quota/opencode-go.json
//
//      File shape:
//
//        {
//          "workspaceId": "wrk_XXXXXXXXXXXXXXXXXXXXXXXX",
//          "authCookie":  "<paste-cookie-value-here>"
//        }
//
//   Or use environment variables (preferred for shared machines):
//
//        export OPENCODE_GO_WORKSPACE_ID="wrk_XXXX..."
//        export OPENCODE_GO_AUTH_COOKIE="<cookie-value>"
//
//   The cookie expires with your browser session. When you see usage stop
//   updating, repeat step 3 and update the file/environment variable.
//
// To install:
//   cp examples/plugins/quota/opencode-go.js \
//      ~/.config/openchamber/plugins/quota/opencode-go.js

const MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const DASHBOARD_URL_PREFIX = 'https://opencode.ai/workspace';
const CHECK_TIMEOUT_MS = 15_000;

const WINDOW_LABELS = {
  rollingUsage: '5h',
  weeklyUsage: 'weekly',
  monthlyUsage: 'monthly',
};

const HTML_DECODE = {
  '&quot;': '"',
  '&#34;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '\\"': '"',
  '\\u0022': '"',
};

const PROVIDER_ID = 'opencode-go';
const PROVIDER_NAME = 'OpenCode Go';
const ALIASES = ['opencode-go', 'opencode_zen_go', 'opengogo'];

const DASHBOARD_SETUP_INSTRUCTION = [
  'OpenCode Go usage needs your dashboard auth cookie. To see real numbers:',
  '  1. Sign in at https://opencode.ai and open the Go usage page.',
  '  2. Copy the workspaceId from the URL (starts with wrk_).',
  '  3. Copy the `auth` cookie value from DevTools -> Application -> Cookies.',
  '  4. Save them to ~/.config/opencode/opencode-quota/opencode-go.json',
  '     (or set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE env vars).',
].join('\n');

const isLikelySafePath = (value) => {
  if (typeof value !== 'string') return false;
  return value.length > 0 && !value.includes('\0') && !value.includes('\n');
};

const configPathCandidates = () => {
  const home = (typeof process !== 'undefined' && process.env && process.env.HOME) || '';
  const xdg = (typeof process !== 'undefined' && process.env && process.env.XDG_CONFIG_HOME) || '';
  const explicit = (typeof process !== 'undefined' && process.env && process.env.OPENCODE_GO_CONFIG_FILE) || '';
  const list = [];
  if (explicit) list.push(explicit);
  if (xdg) {
    list.push(`${xdg}/opencode/opencode-quota/opencode-go.json`);
    list.push(`${xdg}/opencode-bar/opencode-go.json`);
    list.push(`${xdg}/openchamber/opencode-go.json`);
  }
  if (home) {
    list.push(`${home}/.config/opencode/opencode-quota/opencode-go.json`);
    list.push(`${home}/.config/opencode-bar/opencode-go.json`);
    list.push(`${home}/.config/openchamber/opencode-go.json`);
  }
  return list.filter(isLikelySafePath);
};

const loadDashboardConfig = async () => {
  const env = (typeof process !== 'undefined' && process.env) || {};
  const envWorkspace = env.OPENCODE_GO_WORKSPACE_ID && env.OPENCODE_GO_WORKSPACE_ID.trim();
  const envCookie = env.OPENCODE_GO_AUTH_COOKIE && env.OPENCODE_GO_AUTH_COOKIE.trim();
  if (envWorkspace || envCookie) {
    if (envWorkspace && envCookie) {
      return { workspaceId: envWorkspace, authCookie: envCookie, source: 'env' };
    }
    return { error: 'OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE must both be set.' };
  }

  for (const path of configPathCandidates()) {
    try {
      let raw;
      if (typeof Bun !== 'undefined' && Bun.file) {
        const file = Bun.file(path);
        if (!(await file.exists())) continue;
        raw = await file.text();
      } else {
        const fs = await import('node:fs/promises');
        try {
          await fs.access(path);
        } catch {
          continue;
        }
        raw = await fs.readFile(path, 'utf-8');
      }
      const parsed = JSON.parse(raw);
      const workspaceId = typeof parsed.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
      const authCookie = typeof parsed.authCookie === 'string' ? parsed.authCookie.trim() : '';
      if (workspaceId && authCookie) {
        return { workspaceId, authCookie, source: path };
      }
      if (workspaceId || authCookie) {
        return { error: `${path} needs both workspaceId and authCookie.` };
      }
    } catch {}
  }

  return null;
};

const normalizeHtml = (html) => {
  let text = html;
  for (const [encoded, decoded] of Object.entries(HTML_DECODE)) {
    text = text.split(encoded).join(decoded);
  }
  return text;
};

const captureObjectBody = (fieldName, text) => {
  // Matches both shapes seen in the wild:
  //   1. JSON-in-__next_f:    "rollingUsage":{...}
  //   2. SolidStart inline:   rollingUsage:$R[1]={...}
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`,
    's',
  );
  const match = pattern.exec(text);
  return match ? match[1] : null;
};

const captureNumber = (fieldName, text) => {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`["']?${escaped}["']?\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`);
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const parseWindow = (fieldName, text, now) => {
  const body = captureObjectBody(fieldName, text);
  if (!body) return null;
  const usagePercent = captureNumber('usagePercent', body);
  const resetInSec = captureNumber('resetInSec', body);
  if (usagePercent === null || resetInSec === null) return null;
  const used = Math.max(0, Math.min(100, usagePercent));
  const resetAtMs = now + Math.max(0, Math.round(resetInSec)) * 1000;
  return {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetAt: new Date(resetAtMs).toISOString(),
    resetAfterSeconds: Math.max(0, Math.round(resetInSec)),
  };
};

const parseDashboardUsage = (html) => {
  const text = normalizeHtml(html);
  const now = Date.now();
  const windows = {};
  for (const [field, label] of Object.entries(WINDOW_LABELS)) {
    const parsed = parseWindow(field, text, now);
    if (parsed) windows[label] = parsed;
  }
  return Object.keys(windows).length > 0 ? windows : null;
};

const fetchDashboardUsage = async ({ workspaceId, authCookie }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${DASHBOARD_URL_PREFIX}/${encodeURIComponent(workspaceId)}/go`,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          Cookie: authCookie.includes('auth=') ? authCookie : `auth=${authCookie}`,
          'User-Agent': 'openchamber-quota-plugin (https://opencode.ai)',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Auth cookie expired or invalid — re-copy it from DevTools.');
      }
      throw new Error(`OpenCode Go dashboard returned HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDashboardUsage(html);
  } finally {
    clearTimeout(timeout);
  }
};

const checkApiKey = async (apiKey) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Invalid OpenCode Go API key.');
      throw new Error(`OpenCode Go key check failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data && typeof data === 'object') {
      if (Array.isArray(data.data)) return data.data.length;
      if (Array.isArray(data.models)) return data.models.length;
      if (Array.isArray(data)) return data.length;
      return Object.keys(data).length;
    }
    return 0;
  } finally {
    clearTimeout(timeout);
  }
};

const buildWindows = (parsed) => {
  const windows = {};
  for (const [label, info] of Object.entries(parsed || {})) {
    windows[label] = {
      usedPercent: info.usedPercent,
      remainingPercent: info.remainingPercent,
      windowSeconds: null,
      resetAt: info.resetAt,
      resetAtFormatted: null,
      resetAfterSeconds: info.resetAfterSeconds,
      resetAfterFormatted: info.resetAfterSeconds > 0
        ? `${Math.round(info.resetAfterSeconds / 60)} min`
        : null,
      valueLabel: `${info.usedPercent.toFixed(0)}% used`,
    };
  }
  return windows;
};

const buildSetupWindow = (modelCount) => ({
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel: `Active (${modelCount} models) — see error below for setup`,
});

export default ({
  buildResult,
  readAuthFile,
  getAuthEntry,
  normalizeAuthEntry,
}) => {
  const getApiKey = () => {
    const auth = readAuthFile();
    const entry = normalizeAuthEntry(getAuthEntry(auth, ALIASES));
    return entry?.key || entry?.token || null;
  };

  return {
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    aliases: ALIASES,

    isConfigured: () => Boolean(getApiKey()),

    fetchQuota: async () => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: false,
          configured: false,
          error: 'Not configured. Run /connect in OpenCode and pick OpenCode Go to store the API key.',
        });
      }

      let modelCount = 0;
      try {
        modelCount = await checkApiKey(apiKey);
      } catch (error) {
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: false,
          configured: true,
          error: error instanceof Error ? error.message : 'OpenCode Go key check failed',
        });
      }

      const dashboardConfig = await loadDashboardConfig();
      if (dashboardConfig && dashboardConfig.error) {
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: true,
          configured: true,
          usage: { windows: { Subscription: buildSetupWindow(modelCount) } },
          error: dashboardConfig.error,
        });
      }
      if (!dashboardConfig) {
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: true,
          configured: true,
          usage: { windows: { Subscription: buildSetupWindow(modelCount) } },
          error: DASHBOARD_SETUP_INSTRUCTION,
        });
      }

      try {
        const parsed = await fetchDashboardUsage(dashboardConfig);
        if (!parsed) {
          return buildResult({
            providerId: PROVIDER_ID,
            providerName: PROVIDER_NAME,
            ok: true,
            configured: true,
            usage: { windows: { Subscription: buildSetupWindow(modelCount) } },
            error: `Dashboard loaded from ${dashboardConfig.source} but no usage windows were found. The page layout may have changed; please report.`,
          });
        }
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: true,
          configured: true,
          usage: { windows: buildWindows(parsed) },
        });
      } catch (error) {
        return buildResult({
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME,
          ok: true,
          configured: true,
          usage: { windows: { Subscription: buildSetupWindow(modelCount) } },
          error: error instanceof Error ? error.message : 'Dashboard fetch failed',
        });
      }
    },
  };
};
