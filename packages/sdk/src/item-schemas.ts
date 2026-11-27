import { z } from 'zod';

import {
  ATTACH_PROVIDER_ID,
  GUEST_ATTACH_AUTHOR_MAX,
  GUEST_ATTACH_BRANCH_MAX,
  GUEST_ATTACH_DATA_MAX,
  GUEST_ATTACH_ID_MAX,
  GUEST_ATTACH_TEXT_MAX,
  GUEST_ATTACH_TITLE_MAX,
  GUEST_ATTACH_URL_MAX,
  GUEST_ITEM_MESSAGE_TEXT_MAX,
  GUEST_ITEM_SESSION_MAX,
} from './contract.ts';

export const attachPayloadSchema = z.object({
  providerId: z.string().trim().regex(ATTACH_PROVIDER_ID),
  id: z.string().trim().min(1).max(GUEST_ATTACH_ID_MAX),
  title: z.string().trim().min(1).max(GUEST_ATTACH_TITLE_MAX),
  url: z.string().trim().min(1).max(GUEST_ATTACH_URL_MAX),
  text: z.string().trim().min(1).max(GUEST_ATTACH_TEXT_MAX).optional(),
  kind: z.enum(['issue', 'pull']).optional(),
  author: z.string().trim().min(1).max(GUEST_ATTACH_AUTHOR_MAX).optional(),
  branches: z.object({
    head: z.string().trim().min(1).max(GUEST_ATTACH_BRANCH_MAX),
    base: z.string().trim().min(1).max(GUEST_ATTACH_BRANCH_MAX),
  }).optional(),
  data: z.json().refine((value) => JSON.stringify(value).length <= GUEST_ATTACH_DATA_MAX).optional(),
});

const guestItemRoleSchema = z.enum(['user', 'assistant']);

const messageItemSchema = z.object({
  kind: z.literal('message'),
  action: z.string().trim().min(1).max(64),
  sessionId: z.string().min(1),
  sessionTitle: z.string(),
  directory: z.string().nullable(),
  messageId: z.string().min(1),
  role: guestItemRoleSchema,
  text: z.string().max(GUEST_ITEM_MESSAGE_TEXT_MAX),
});

const sessionItemSchema = z.object({
  kind: z.literal('session'),
  action: z.string().trim().min(1).max(64),
  sessionId: z.string().min(1),
  sessionTitle: z.string(),
  directory: z.string().nullable(),
  messages: z.array(z.object({
    id: z.string().min(1),
    role: guestItemRoleSchema,
    text: z.string().max(GUEST_ITEM_MESSAGE_TEXT_MAX),
    createdAt: z.number().int().min(0),
  })).optional(),
  truncated: z.boolean().optional(),
}).refine((value) => JSON.stringify(value).length <= GUEST_ITEM_SESSION_MAX);

const selectionItemSchema = z.object({
  kind: z.literal('selection'),
  action: z.string().trim().min(1).max(64),
  sessionId: z.string().min(1),
  directory: z.string().nullable(),
  messageId: z.string().min(1),
  text: z.string().max(GUEST_ITEM_MESSAGE_TEXT_MAX),
});

const fileItemSchema = z.object({
  kind: z.literal('file'),
  action: z.string().trim().min(1).max(64),
  directory: z.string().nullable(),
  path: z.string().min(1),
  isDirectory: z.boolean(),
});

const diffItemSchema = z.object({
  kind: z.literal('diff'),
  action: z.string().trim().min(1).max(64),
  directory: z.string().nullable(),
  path: z.string().min(1),
  startLine: z.number().int().min(0),
  endLine: z.number().int().min(0),
  side: z.enum(['additions', 'deletions']).optional(),
});

const linkItemSchema = z.object({
  kind: z.literal('link'),
  identifier: z.string().trim().min(1).max(GUEST_ATTACH_ID_MAX),
  url: z.string().trim().min(1).max(GUEST_ATTACH_URL_MAX).optional(),
}).strict();

export const guestActionItemSchema = z.union([messageItemSchema, sessionItemSchema, selectionItemSchema, fileItemSchema, diffItemSchema]);

export const guestItemSchema = z.union([guestActionItemSchema, linkItemSchema, attachPayloadSchema]).nullable();
