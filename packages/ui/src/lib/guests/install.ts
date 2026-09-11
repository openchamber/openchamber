import type { GuestCapability } from '@openchamber/sdk';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { z } from 'zod';

import { parseInstalledGuestJson } from './parse.ts';
import type { InstalledGuest } from './types.ts';

const errorSchema = z.object({
  error: z.enum([
    'invalid-path',
    'invalid-url',
    'not-found',
    'invalid-manifest',
    'id-taken',
    'already-installed',
    'missing-build',
    'host-too-old',
    'bundled',
    'clone-failed',
    'extract-failed',
    'too-large',
  ]),
  required: z.string().trim().min(1).max(64).optional(),
  id: z.string().trim().min(1).max(128).optional(),
});

export type InstallGuestErrorCode =
  | 'invalid-path'
  | 'invalid-url'
  | 'not-found'
  | 'invalid-manifest'
  | 'id-taken'
  | 'already-installed'
  | 'missing-build'
  | 'host-too-old'
  | 'bundled'
  | 'clone-failed'
  | 'extract-failed'
  | 'too-large'
  | 'failed';

type InstallGuestResult =
  | { ok: true; guest: InstalledGuest; replaced?: boolean }
  | { ok: false; code: InstallGuestErrorCode; required?: string; id?: string };

type UninstallGuestResult =
  | { ok: true }
  | { ok: false; code: InstallGuestErrorCode };

type InstallGuestRequest = ({ path: string } | { url: string }) & { replace?: boolean };

type ParseInstallInputResult =
  | { ok: true; request: InstallGuestRequest }
  | { ok: false; code: 'invalid-path' | 'invalid-url' };

export const parseInstallInput = (raw: string): ParseInstallInputResult => {
  const value = raw.trim();
  if (!value) {
    return { ok: false, code: 'invalid-path' };
  }
  if (value.slice(0, 8).toLowerCase() === 'https://') {
    return { ok: true, request: { url: value } };
  }
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !windowsPath) {
    return { ok: false, code: 'invalid-url' };
  }
  if (value.startsWith('/') || windowsPath || value.startsWith('\\\\')) {
    return { ok: true, request: { path: value } };
  }
  return { ok: false, code: 'invalid-path' };
};

const readInstallError = async (
  response: Response,
): Promise<{ code: InstallGuestErrorCode; required?: string; id?: string }> => {
  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) {
      return { code: 'failed' };
    }
    if (parsed.data.error === 'host-too-old' && parsed.data.required && parsed.data.id) {
      return { code: 'host-too-old', required: parsed.data.required, id: parsed.data.id };
    }
    if (parsed.data.error === 'host-too-old' && parsed.data.required) {
      return { code: 'host-too-old', required: parsed.data.required };
    }
    if (parsed.data.id) {
      return { code: parsed.data.error, id: parsed.data.id };
    }
    return { code: parsed.data.error };
  } catch {
    return { code: 'failed' };
  }
};

export type InstallGuestOptions = {
  replace?: boolean;
};

const readInstallResponse = async (response: Response): Promise<InstallGuestResult> => {
  if (!response.ok) {
    const error = await readInstallError(response);
    if (error.required && error.id) {
      return { ok: false, code: error.code, required: error.required, id: error.id };
    }
    if (error.required) {
      return { ok: false, code: error.code, required: error.required };
    }
    if (error.id) {
      return { ok: false, code: error.code, id: error.id };
    }
    return { ok: false, code: error.code };
  }
  const guest = parseInstalledGuestJson(await response.text());
  if (!guest) {
    return { ok: false, code: 'failed' };
  }
  return { ok: true, guest, replaced: response.status === 200 };
};

export const installGuest = async (
  input: string,
  options: InstallGuestOptions = {},
): Promise<InstallGuestResult> => {
  const parsed = parseInstallInput(input);
  if (!parsed.ok) {
    return parsed;
  }
  const body = options.replace
    ? { ...parsed.request, replace: true as const }
    : parsed.request;
  try {
    const response = await runtimeFetch('/api/guests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return await readInstallResponse(response);
  } catch {
    return { ok: false, code: 'failed' };
  }
};

/**
 * Send a `.zip` picked or dropped in the browser to the host. Same result
 * shape as `installGuest`, so one flow handles both; the archive travels as a
 * raw octet-stream body over `runtimeFetch`, which is what the files tree
 * upload uses too, so relay and tunnel runtimes carry it unchanged.
 */
export const uploadGuestZip = async (
  file: File,
  options: InstallGuestOptions = {},
): Promise<InstallGuestResult> => {
  try {
    const response = await runtimeFetch('/api/guests/upload', {
      method: 'POST',
      query: {
        replace: options.replace ? 'true' : undefined,
        name: file.name || undefined,
      },
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      body: file,
    });
    return await readInstallResponse(response);
  } catch {
    return { ok: false, code: 'failed' };
  }
};

export const uninstallGuest = async (id: string): Promise<UninstallGuestResult> => {
  try {
    const response = await runtimeFetch(`/api/guests/${id}`, { method: 'DELETE' });
    if (response.status === 204) {
      return { ok: true };
    }
    const error = await readInstallError(response);
    return { ok: false, code: error.code };
  } catch {
    return { ok: false, code: 'failed' };
  }
};

export const setGuestEnabled = async (id: string, enabled: boolean): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/guests/${id}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/** Record the user's answer to the approval dialog. An empty list withdraws approval. */
export const approveGuestCapabilities = async (id: string, granted: readonly GuestCapability[]): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/guests/${id}/capabilities`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted }),
    });
    return response.ok;
  } catch {
    return false;
  }
};
