import { z } from 'zod';

import type { InstalledGuest } from './types.ts';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;

const publicIntegrationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  auth: z.enum(['oauth', 'token', 'host']).default('oauth'),
  settings: z.array(z.object({
    id: z.string().regex(PANEL_ID),
    label: z.string().trim().min(1),
  })).optional(),
});

const publicSocketBindingSchema = z.object({
  id: z.string().trim().min(1),
  candidates: z.array(z.string()),
  resolved: z.string().nullable(),
  override: z.string().nullable(),
});

const publicAgentSchema = z.object({
  runtime: z.literal('host'),
  granted: z.boolean(),
  permissions: z.object({
    sockets: z.array(z.string().trim().min(1)).optional(),
    exec: z.array(z.string().trim().min(1)).optional(),
  }).optional(),
  socketBindings: z.array(publicSocketBindingSchema).optional(),
});

const installedGuestSchema = z.object({
  id: z.string().regex(PANEL_ID),
  name: z.string().trim().min(1),
  icon: z.string().trim().min(1),
  entry: z.string().trim().min(1),
  version: z.string().trim().min(1).max(64).optional(),
  attach: z.union([z.boolean(), z.enum(['panel', 'dialog'])]).optional(),
  integration: publicIntegrationSchema.optional(),
  agent: publicAgentSchema.optional(),
  source: z.enum(['bundled', 'path', 'zip', 'git']).optional(),
  path: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const catalogSchema = z.object({
  guests: z.array(installedGuestSchema),
});

export const parseGuestCatalogJson = (json: string): InstalledGuest[] | null => {
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.guests : null;
  } catch {
    return null;
  }
};

export const parseInstalledGuestJson = (json: string): InstalledGuest | null => {
  try {
    const parsed = z.object({ guest: installedGuestSchema }).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.guest : null;
  } catch {
    return null;
  }
};
