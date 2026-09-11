type UpgradeCapability = {
  supported: boolean;
  manager: 'opencode' | 'external' | 'openchamber' | null;
  reason: 'external' | 'unavailable' | 'windows-arm64-workaround' | null;
};

export type OpenCodeUpgradeManager = {
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getDebugInfo(): { mode: 'managed' | 'external' };
  restart(): Promise<void>;
};

type UpgradeResult = { status: number; body: Record<string, unknown> };

let openCodeUpgradePromise: Promise<UpgradeResult> | null = null;

// TEMPORARY WORKAROUND — Windows ARM64: native opencode.exe fails with a Bun
// FFI/TinyCC dlopen error (https://github.com/anomalyco/opencode/issues/19130).
// Disable OpenCode self-upgrade on ARM64 so it can't overwrite the working x64
// binary with the broken ARM64 build. Remove when the upstream issue is resolved.
const isWindowsArm64 = (): boolean => process.platform === 'win32' && process.arch === 'arm64';

const parseVersion = (value: unknown): { parts: number[]; prerelease: boolean } => {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  return {
    parts: core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseIndex >= 0,
  };
};

const compareVersions = (left: unknown, right: unknown): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (difference !== 0) return difference;
  }
  return a.prerelease === b.prerelease ? 0 : (a.prerelease ? -1 : 1);
};

const getCapability = (manager?: OpenCodeUpgradeManager): UpgradeCapability => {
  if (isWindowsArm64()) return { supported: false, manager: 'openchamber', reason: 'windows-arm64-workaround' };
  if (!manager) return { supported: false, manager: null, reason: 'unavailable' };
  if (manager.getDebugInfo().mode !== 'managed') return { supported: false, manager: 'external', reason: 'external' };
  if (!manager.getApiUrl()) return { supported: false, manager: null, reason: 'unavailable' };
  return { supported: true, manager: 'opencode', reason: null };
};

const getApiUrl = (manager?: OpenCodeUpgradeManager): string | null => {
  const apiUrl = manager?.getApiUrl();
  return apiUrl ? `${apiUrl.replace(/\/+$/, '')}/` : null;
};

const fetchLatestVersion = async (): Promise<string> => {
  const results = await Promise.allSettled([
    fetch('https://registry.npmjs.org/opencode-ai/latest', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`OpenCode npm registry responded with ${response.status}`);
        const payload = await response.json() as { version?: unknown };
        return typeof payload.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
      }),
    fetch('https://api.github.com/repos/anomalyco/opencode/releases/latest', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`OpenCode releases responded with ${response.status}`);
        const payload = await response.json() as { tag_name?: unknown };
        return typeof payload.tag_name === 'string' ? payload.tag_name.trim().replace(/^v/, '') : '';
      }),
  ]);
  const versions = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
  if (versions.length === 0) throw new Error('Failed to resolve latest OpenCode version');
  return versions.sort((left, right) => compareVersions(right, left))[0];
};

// OpenCode reports a rejected upgrade as `{ name, data: { message, kind } }`,
// which carries no `error` field. Reading only `error` left the user with the
// bare HTTP status text ("Bad Request") and nothing to act on.
const readUpgradeErrorMessage = (
  payload: { error?: unknown; message?: unknown; data?: { message?: unknown } } | null,
  response: Response,
): string => {
  for (const candidate of [payload?.error, payload?.data?.message, payload?.message]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return response.statusText || 'Failed to upgrade OpenCode';
};

export const getOpenCodeUpgradeStatus = async (manager?: OpenCodeUpgradeManager): Promise<Record<string, unknown>> => {
  const upgrade = getCapability(manager);
  const apiUrl = getApiUrl(manager);
  if (!upgrade.supported || !apiUrl || !manager) return { available: false, currentVersion: null, latestVersion: null, upgrade };
  try {
    const [healthResponse, latestVersion] = await Promise.all([
      fetch(new URL('global/health', apiUrl).toString(), { method: 'GET', headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() } }),
      fetchLatestVersion(),
    ]);
    const health = await healthResponse.json().catch(() => null) as { version?: unknown; error?: unknown } | null;
    if (!healthResponse.ok) {
      const error = typeof health?.error === 'string' ? health.error : healthResponse.statusText || 'Failed to read OpenCode version';
      return { available: null, error, upgrade };
    }
    const currentVersion = typeof health?.version === 'string' && health.version.trim() ? health.version.trim().replace(/^v/, '') : null;
    return { available: currentVersion ? compareVersions(latestVersion, currentVersion) > 0 : null, currentVersion, latestVersion, upgrade };
  } catch (error) {
    return { available: null, error: error instanceof Error ? error.message : String(error), upgrade };
  }
};

export const upgradeManagedOpenCode = async (manager: OpenCodeUpgradeManager | undefined, target?: unknown): Promise<UpgradeResult> => {
  const upgrade = getCapability(manager);
  const apiUrl = getApiUrl(manager);
  if (!upgrade.supported || !apiUrl || !manager) {
    return { status: 409, body: { success: false, code: 'OPENCODE_UPGRADE_UNSUPPORTED', error: 'This OpenCode runtime cannot be upgraded by OpenChamber.' } };
  }
  if (openCodeUpgradePromise) {
    return { status: 409, body: { success: false, code: 'OPENCODE_UPGRADE_IN_PROGRESS', error: 'An OpenCode upgrade is already in progress.' } };
  }
  const requestedTarget = typeof target === 'string' ? target.trim() : '';
  const operation = (async (): Promise<UpgradeResult> => {
    // The lookup runs inside the operation so the in-flight lock above already
    // holds while the release version is resolved.
    let targetVersion = requestedTarget;
    if (!targetVersion) {
      try {
        targetVersion = await fetchLatestVersion();
      } catch (error) {
        return {
          status: 502,
          body: {
            success: false,
            code: 'OPENCODE_UPGRADE_TARGET_UNRESOLVED',
            error: `Could not determine which OpenCode version to install: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }
    try {
      const response = await fetch(new URL('global/upgrade', apiUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() },
        body: JSON.stringify({ target: targetVersion }),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown; data?: { message?: unknown } } | null;
      if (!response.ok) return { status: response.status, body: { success: false, error: readUpgradeErrorMessage(payload, response) } };
      try {
        await manager.restart();
      } catch (error) {
        return { status: 500, body: { success: false, upgraded: true, error: error instanceof Error ? `OpenCode upgraded, but restart failed: ${error.message}` : 'OpenCode upgraded, but restart failed' } };
      }
      return { status: 200, body: { ...(payload && typeof payload === 'object' ? payload : { success: true }), restarted: true } };
    } catch (error) {
      return { status: 500, body: { success: false, error: error instanceof Error ? error.message : 'Failed to upgrade OpenCode' } };
    }
  })();
  openCodeUpgradePromise = operation;
  try {
    return await operation;
  } finally {
    if (openCodeUpgradePromise === operation) openCodeUpgradePromise = null;
  }
};
