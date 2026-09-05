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
  ]),
  required: z.string().trim().min(1).max(64).optional(),
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
  | 'failed';

type InstallGuestResult =
  | { ok: true; guest: InstalledGuest }
  | { ok: false; code: InstallGuestErrorCode; required?: string };

type UninstallGuestResult =
  | { ok: true }
  | { ok: false; code: InstallGuestErrorCode };

type InstallGuestRequest = { path: string } | { url: string };

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
): Promise<{ code: InstallGuestErrorCode; required?: string }> => {
  try {
    const parsed = errorSchema.safeParse(JSON.parse(await response.text()));
    if (!parsed.success) {
      return { code: 'failed' };
    }
    if (parsed.data.error === 'host-too-old' && parsed.data.required) {
      return { code: 'host-too-old', required: parsed.data.required };
    }
    return { code: parsed.data.error };
  } catch {
    return { code: 'failed' };
  }
};

export const installGuest = async (input: string): Promise<InstallGuestResult> => {
  const parsed = parseInstallInput(input);
  if (!parsed.ok) {
    return parsed;
  }
  try {
    const response = await runtimeFetch('/api/guests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(parsed.request),
    });
    if (!response.ok) {
      const error = await readInstallError(response);
      return error.required
        ? { ok: false, code: error.code, required: error.required }
        : { ok: false, code: error.code };
    }
    const guest = parseInstalledGuestJson(await response.text());
    if (!guest) {
      return { ok: false, code: 'failed' };
    }
    return { ok: true, guest };
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
