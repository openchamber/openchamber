import express from 'express';
import { z } from 'zod';
import type { Application } from '../shared/http-contracts.js';
import { toPublicGuest } from './catalog.js';
import type { findInstalledGuest } from './catalog.js';
import type { GuestGitAccounts } from './clone.js';
import { checkAllGuestUpdates, updateGuest, withGuestUpdate } from './updates.js';

const json16 = express.json({ limit: '16kb' });

const updateCheckBodySchema = z.object({
  force: z.boolean().optional(),
});

export type GuestUpdateErrorResponse = { error: string; required?: string };

export const registerGuestUpdateRoutes = (app: Application, {
  persistPath,
  openchamberVersion,
  resolveGitBinaryForSpawn,
  gitAccounts,
  loadGuest,
  packageChanged,
}: {
  persistPath: string;
  openchamberVersion: string | undefined;
  resolveGitBinaryForSpawn: () => string;
  gitAccounts: GuestGitAccounts | undefined;
  loadGuest: (id: string | undefined) => ReturnType<typeof findInstalledGuest>;
  packageChanged: (guestId: string) => Promise<void>;
}) => {
  app.post('/api/guests/updates/check', json16, async (req, res) => {
    try {
      const parsed = updateCheckBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid-request' });
      }
      const updates = await checkAllGuestUpdates({
        persistPath,
        force: Boolean(parsed.data.force),
        gitBinary: resolveGitBinaryForSpawn(),
        gitAccounts,
      });
      res.json({ updates });
    } catch (error) {
      console.error('Failed to check guest updates:', error);
      res.status(500).json({ error: 'Failed to check guest updates' });
    }
  });

  app.post('/api/guests/:id/update', async (req, res) => {
    try {
      const guest = await loadGuest(req.params.id);
      if (!guest) {
        return res.status(404).json({ error: 'not-found' });
      }
      const result = await updateGuest({
        guest,
        origin: guest.gitOrigin,
        persistPath,
        openchamberVersion,
        gitBinary: resolveGitBinaryForSpawn(),
        gitAccounts,
      });
      if (!result.ok) {
        const body: GuestUpdateErrorResponse = { error: result.code };
        if (result.code === 'host-too-old' && result.required) {
          body.required = result.required;
        }
        return res.status(400).json(body);
      }
      await packageChanged(guest.id);
      const next = await loadGuest(guest.id);
      if (!next) {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ guest: toPublicGuest(withGuestUpdate(next, persistPath)) });
    } catch (error) {
      console.error('Failed to update guest:', error);
      res.status(500).json({ error: 'Failed to update guest' });
    }
  });
};
