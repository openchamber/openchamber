import { z } from 'zod';
import type { SettingsDocument } from './settings-helpers.js';

const sessionWorkSettingsSchema = z.object({
  sessionWorkEnabled: z.boolean().optional().catch(undefined),
  sessionWorkIncludesPinned: z.boolean().optional().catch(undefined),
});

type SessionWorkSettings = z.infer<typeof sessionWorkSettingsSchema>;

export const sanitizeSessionWorkSettings = (candidate: SettingsDocument): SessionWorkSettings => {
  const { sessionWorkEnabled, sessionWorkIncludesPinned } = sessionWorkSettingsSchema.parse(candidate);
  const result: SessionWorkSettings = {};
  if (sessionWorkEnabled !== undefined) result.sessionWorkEnabled = sessionWorkEnabled;
  if (sessionWorkIncludesPinned !== undefined) result.sessionWorkIncludesPinned = sessionWorkIncludesPinned;
  return result;
};

export const sessionWorkResponseFields = ({ sessionWorkIncludesPinned }: SessionWorkSettings) => ({
  sessionWorkIncludesPinned: sessionWorkIncludesPinned ?? false,
});
