import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

import type { InstalledGuest, OpenCodePlugins } from './types.ts';

/**
 * What an extension's detail screen says about its OpenCode plugin, from the
 * listing's delivery state and the extension's own state. One cell per case:
 * the line the button wrote (`added`), the entry the user's global config
 * already lists, an OpenCode on another machine, and the two cases that offer
 * the button. A managed OpenCode reading our file (`file`) shows nothing: the
 * plugin is simply loaded. An extension that is off, waiting for approval or
 * refused by enterprise mode offers nothing either, since its plugin is not
 * meant to load; the entry it already has in the global config is still named,
 * because that entry stays whatever the extension's state.
 */
export type OpenCodePluginNotice =
  | { kind: 'added'; path: string }
  | { kind: 'inGlobalConfig'; path: string }
  | { kind: 'remote' }
  | { kind: 'offer'; delivery: 'none' | 'restart' };

export const openCodePluginNotice = ({ guest, plugins, active, added }: {
  guest: InstalledGuest;
  plugins: OpenCodePlugins | null;
  active: boolean;
  added: string | null;
}): OpenCodePluginNotice | null => {
  if (!guest.opencodePlugin || !plugins) return null;
  if (added) return { kind: 'added', path: added };
  if (plugins.inGlobalConfig.includes(guest.id) && plugins.globalConfigPath) return { kind: 'inGlobalConfig', path: plugins.globalConfigPath };
  if (!active) return null;
  if (plugins.delivery === 'remote') return { kind: 'remote' };
  if (plugins.delivery === 'file') return null;
  return { kind: 'offer', delivery: plugins.delivery };
};

const addedSchema = z.object({ path: z.string().min(1) });
const failureSchema = z.object({ error: z.string(), message: z.string().optional() });

type AddPluginToGlobalConfigResult =
  | { ok: true; path: string }
  /** `reason` is the server's own words when it has them (an unreadable config file, a failed write). */
  | { ok: false; reason: string | null };

/** "Add to global config": the server writes the plugin folder into the user's global OpenCode config and answers the file it wrote. */
export const addGuestPluginToGlobalConfig = async (guest: InstalledGuest): Promise<AddPluginToGlobalConfigResult> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guest.id}/opencode-plugin/global-config`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = addedSchema.safeParse(body);
      return parsed.success ? { ok: true, path: parsed.data.path } : { ok: false, reason: null };
    }
    const failure = failureSchema.safeParse(body);
    return { ok: false, reason: failure.success ? failure.data.message ?? null : null };
  } catch {
    return { ok: false, reason: null };
  }
};
