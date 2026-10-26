import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  isOpenCodeUpgradeSupported,
  resolveOpenCodeUpgradeStatusVersion,
} from './openCodeUpdateDedup';

/**
 * Transport for the OpenCode upgrade the update toast and About share. The
 * server owns the decision (`/api/opencode/upgrade-status`) and the install
 * (`/api/opencode/upgrade`); this module only parses their answers.
 */

const upgradeStatusResponse = z.object({
  available: z.boolean().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
  upgrade: z.object({ supported: z.boolean().nullable().optional() }).nullable().optional(),
});

const upgradeResponse = z.object({
  success: z.boolean().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

export type OpenCodeUpgradeStatus = {
  /** Installed OpenCode version, or null when the server could not read it. */
  currentVersion: string | null;
  /** Newer version to announce, or null when there is nothing to announce. */
  availableVersion: string | null;
  /** True only when the server can run the upgrade itself. */
  supported: boolean;
};

/** Throws on failure so a failed check never reads as "no update". */
export async function fetchOpenCodeUpgradeStatus(): Promise<OpenCodeUpgradeStatus> {
  const response = await runtimeFetch('/api/opencode/upgrade-status', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.statusText || 'OpenCode upgrade status check failed');
  const parsed = upgradeStatusResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('OpenCode upgrade status check failed');
  const status = parsed.data;
  const currentVersion = status.currentVersion?.trim() || null;
  const availableVersion = resolveOpenCodeUpgradeStatusVersion(status) || null;
  return { currentVersion, availableVersion, supported: isOpenCodeUpgradeSupported(status) };
}

/**
 * Installs the latest OpenCode on the server. Resolves with the installed
 * version when the server reports one; throws with the server's reason, or
 * with `fallbackError` when it gives none.
 */
export async function runOpenCodeUpgrade(fallbackError: string): Promise<string | null> {
  const response = await runtimeFetch('/api/opencode/upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  const parsed = upgradeResponse.safeParse(await response.json().catch(() => null));
  const payload = parsed.success ? parsed.data : null;
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || response.statusText || fallbackError);
  }
  return payload?.version ?? null;
}
