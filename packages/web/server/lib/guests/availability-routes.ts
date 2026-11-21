import os from 'node:os';

import express from 'express';
import { z } from 'zod';

import type { Application, QueryValue, Response } from '../shared/http-contracts.js';
import { isRecord } from '../shared/object-guards.js';
import { toPublicGuest, type InstalledGuest } from './catalog.js';
import { resolveGuestFolders } from './files.js';
import { setGuestFolders } from './persist.js';
import type { JsonValue } from './contracts.js';
import type { GuestDeactivation } from './routes.js';
import { setGuestEnabled } from './service.js';

const json16 = express.json({ limit: '16kb' });

const enabledBodySchema = z.object({
  enabled: z.boolean(),
});

const foldersSchema = z.array(z.string().trim().min(1).max(512).refine((value) => !value.includes('\0'))).max(16);

type AvailabilityRoutesOptions = {
  persistPath: string;
  loadGuest: (id: string | undefined) => Promise<InstalledGuest | null>;
  activated: (guestId: string) => Promise<void>;
  deactivated: (event: GuestDeactivation) => Promise<void>;
  announce: () => void;
};

const readGuestFolders = (value: JsonValue | undefined): string[] | null => {
  const parsed = foldersSchema.safeParse(value);
  return parsed.success ? resolveGuestFolders(parsed.data, os.homedir()) : null;
};

export const readInstallFolders = (value: JsonValue | undefined): string[] | null | undefined => (
  value === undefined ? undefined : readGuestFolders(value)
);

export const readUploadFolders = (value: QueryValue | undefined): string[] | null | undefined => {
  if (value === undefined) return undefined;
  const raw = z.string().safeParse(value);
  if (!raw.success) return null;
  try {
    const parsed: JsonValue = JSON.parse(raw.data);
    return readGuestFolders(parsed);
  } catch {
    return null;
  }
};

export const registerGuestAvailabilityRoutes = (app: Application, { persistPath, loadGuest, activated, deactivated, announce }: AvailabilityRoutesOptions) => {
  const answerGuest = async (res: Response, id: string) => {
    const next = await loadGuest(id);
    if (!next) {
      return res.status(404).json({ error: 'not-found' });
    }
    return res.json({ guest: toPublicGuest(next) });
  };

  app.put('/api/guests/:id/enabled', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const parsed = enabledBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      await setGuestEnabled(guest.id, persistPath, parsed.data.enabled);
      if (parsed.data.enabled) {
        await activated(guest.id);
      } else {
        await deactivated({ guestId: guest.id, guestName: guest.name });
      }
      return await answerGuest(res, guest.id);
    } catch (error) {
      console.error('Failed to update guest enabled state:', error);
      return res.status(500).json({ error: 'Failed to update guest enabled state' });
    }
  });

  app.put<JsonValue | undefined>('/api/guests/:id/folders', json16, async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const folders = readGuestFolders(isRecord(req.body) ? req.body.folders : undefined);
      if (!folders) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      await setGuestFolders(guest.id, persistPath, folders);
      announce();
      return await answerGuest(res, guest.id);
    } catch (error) {
      console.error('Failed to update guest folders:', error);
      return res.status(500).json({ error: 'Failed to update guest folders' });
    }
  });
};
