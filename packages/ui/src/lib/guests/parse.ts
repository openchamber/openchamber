import { GUEST_ACTIONS_MAX, GUEST_CAPABILITIES, GUEST_COMMANDS_MAX, GUEST_COMMAND_NAME } from '@openchamber/sdk';
import { z } from 'zod';

import type { InstalledGuest } from './types.ts';

const PANEL_ID = /^[a-z][a-z0-9-]*$/;

const publicIntegrationSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  auth: z.enum(['oauth', 'token', 'host']).default('oauth'),
  token: z.object({
    scheme: z.enum(['raw', 'bearer', 'basic']),
    usernameLabel: z.string().trim().min(1).optional(),
  }).optional(),
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

const publicServiceSchema = z.object({
  runtime: z.literal('host'),
  granted: z.boolean(),
  permissions: z.object({
    sockets: z.array(z.string().trim().min(1)).optional(),
    exec: z.array(z.string().trim().min(1)).optional(),
  }).optional(),
  socketBindings: z.array(publicSocketBindingSchema).optional(),
});

const guestActionSchema = z.object({
  id: z.string().regex(PANEL_ID),
  label: z.string().trim().min(1),
  icon: z.string().trim().min(1).optional(),
  where: z.enum(['message', 'session']),
  roles: z.array(z.enum(['user', 'assistant'])).optional(),
  payload: z.array(z.enum(['messages'])).optional(),
});

const guestCommandSchema = z.object({
  name: z.string().regex(GUEST_COMMAND_NAME),
  description: z.string().trim().min(1).optional(),
});

export const guestUpdateSchema = z.object({
  version: z.string().trim().min(1).max(64),
});

const installedGuestSchema = z.object({
  id: z.string().regex(PANEL_ID),
  name: z.string().trim().min(1),
  icon: z.string().trim().min(1),
  entry: z.string().trim().min(1),
  version: z.string().trim().min(1).max(64).optional(),
  attach: z.union([z.boolean(), z.enum(['panel', 'dialog'])]).optional(),
  attachEntry: z.string().trim().min(1).optional(),
  integration: publicIntegrationSchema.optional(),
  filesystem: z.array(z.string().trim().min(1)).optional(),
  service: publicServiceSchema.optional(),
  actions: z.array(guestActionSchema).max(GUEST_ACTIONS_MAX).optional(),
  commands: z.array(guestCommandSchema).max(GUEST_COMMANDS_MAX).optional(),
  capabilities: z.object({
    requested: z.array(z.enum(GUEST_CAPABILITIES)),
    granted: z.array(z.enum(GUEST_CAPABILITIES)),
  }),
  source: z.enum(['bundled', 'path', 'zip', 'git']).optional(),
  path: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  origin: z.object({
    url: z.string().trim().min(1),
    ref: z.string().trim().min(1).optional(),
  }).optional(),
  update: guestUpdateSchema.optional(),
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
