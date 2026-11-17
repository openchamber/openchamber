import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  isOpenCodeUpgradeSupported,
  resolveOpenCodeUpgradeStatusVersion,
} from './openCodeUpdateDedup';


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
  currentVersion: string | null;
  availableVersion: string | null;
  supported: boolean;
};

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
