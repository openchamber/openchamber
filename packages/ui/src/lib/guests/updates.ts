import { runtimeFetch } from '@/lib/runtime-fetch';
import { z } from 'zod';

import { guestUpdateSchema, parseInstalledGuestJson } from './parse.ts';
import type { GuestUpdate, InstalledGuest } from './types.ts';

const checkResponseSchema = z.object({
  updates: z.record(z.string().min(1), guestUpdateSchema),
});

export type UpdateGuestErrorCode =
  | 'not-git'
  | 'clone-failed'
  | 'invalid-manifest'
  | 'missing-build'
  | 'host-too-old'
  | 'swap-failed'
  | 'not-found'
  | 'failed';

const updateErrorSchema = z.object({
  error: z.enum(['not-git', 'clone-failed', 'invalid-manifest', 'missing-build', 'host-too-old', 'swap-failed', 'not-found']),
  required: z.string().trim().min(1).max(64).optional(),
});

type CheckGuestUpdatesResult =
  | { ok: true; updates: Record<string, GuestUpdate> }
  | { ok: false };

type UpdateGuestResult =
  | { ok: true; guest: InstalledGuest }
  | { ok: false; code: UpdateGuestErrorCode; required?: string };

/**
 * Ask the server to compare every git install with its origin. The server
 * answers from a one-hour cache unless `force`. Failure is distinct from
 * "nothing to update" so the page never clears badges on a network error.
 */
export const checkGuestUpdates = async (force: boolean): Promise<CheckGuestUpdatesResult> => {
  try {
    const response = await runtimeFetch('/api/guests/updates/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!response.ok) {
      return { ok: false };
    }
    const parsed = checkResponseSchema.safeParse(JSON.parse(await response.text()));
    return parsed.success ? { ok: true, updates: parsed.data.updates } : { ok: false };
  } catch {
    return { ok: false };
  }
};

const readUpdateError = async (response: Response): Promise<{ code: UpdateGuestErrorCode; required?: string }> => {
  try {
    const parsed = updateErrorSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) {
      return { code: 'failed' };
    }
    return parsed.data.required
      ? { code: parsed.data.error, required: parsed.data.required }
      : { code: parsed.data.error };
  } catch {
    return { code: 'failed' };
  }
};

/** Replace the installed git copy with a fresh clone of its origin. Returns the refreshed catalog row. */
export const updateGuest = async (id: string): Promise<UpdateGuestResult> => {
  try {
    const response = await runtimeFetch(`/api/guests/${id}/update`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = await readUpdateError(response);
      return error.required
        ? { ok: false, code: error.code, required: error.required }
        : { ok: false, code: error.code };
    }
    const guest = parseInstalledGuestJson(await response.text());
    return guest ? { ok: true, guest } : { ok: false, code: 'failed' };
  } catch {
    return { ok: false, code: 'failed' };
  }
};
