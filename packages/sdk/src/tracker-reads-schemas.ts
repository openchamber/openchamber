import { z } from 'zod';

import { TRACKER_PROVIDER_LIST_MAX } from './service-providers.ts';
import {
  GUEST_TRACKER_CONTAINER_ID_MAX,
  GUEST_TRACKER_CURSOR_MAX,
  GUEST_TRACKER_ID_MAX,
  GUEST_TRACKER_QUERY_MAX,
  GUEST_TRACKER_STATE_MAX,
} from './contract.ts';
import type {
  GuestTrackerComment,
  GuestTrackerFilterOptions,
  GuestTrackerItem,
  GuestTrackerItemResult,
  GuestTrackerItemSummary,
  GuestTrackerListResult,
  GuestTrackerRequest,
  GuestTrackerResult,
} from './tracker-reads.ts';

const trackerText = z.string().min(1).max(1_024);
const trackerUrl = z.string().min(1).max(2_048).refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), { message: 'must be an http(s) URL' });
const trackerCategory = z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
const trackerPriority = z.enum(['none', 'urgent', 'high', 'medium', 'low']);
const trackerPerson = z.object({ name: z.string().max(256).nullable(), avatarUrl: z.string().max(2_048).nullable() }).strict();
const trackerContainer = z.object({ id: trackerText, key: z.string().max(64).nullable(), name: z.string().min(1).max(256) }).strict();
const trackerState = z.object({ id: trackerText.nullable(), name: z.string().max(256), category: trackerCategory.nullable() }).strict();
const trackerLabel = z.object({ id: trackerText, name: z.string().min(1).max(256), color: z.string().max(32).nullable() }).strict();
const trackerProgress = z.object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative(), more: z.boolean() }).strict();

const itemFields = {
  provider: z.string().min(1).max(256),
  id: trackerText,
  identifier: z.string().min(1).max(128),
  title: z.string().max(4_096),
  url: trackerUrl,
  state: trackerState.nullable(),
  priority: trackerPriority.nullable().optional(),
  labels: z.array(trackerLabel).max(TRACKER_PROVIDER_LIST_MAX).optional(),
  assignee: trackerPerson.nullable().optional(),
  container: trackerContainer.nullable().optional(),
  progress: trackerProgress.nullable().optional(),
  updatedAt: z.string().max(64).nullable().optional(),
};

const itemSummarySchema: z.ZodType<GuestTrackerItemSummary> = z.lazy(() => z.object({
  ...itemFields,
  parent: itemSummarySchema.nullable().optional(),
}).strict());

const commentSchema: z.ZodType<GuestTrackerComment> = z.object({
  id: trackerText,
  body: z.string().max(65_536),
  createdAt: z.string().max(64).nullable(),
  author: trackerPerson.nullable(),
}).strict();

const itemSchema: z.ZodType<GuestTrackerItem> = z.lazy(() => z.object({
  ...itemFields,
  parent: itemSummarySchema.nullable().optional(),
  description: z.string().max(262_144).nullable().optional(),
  comments: z.array(commentSchema).max(TRACKER_PROVIDER_LIST_MAX).optional(),
  children: z.array(itemSummarySchema).max(TRACKER_PROVIDER_LIST_MAX).optional(),
  childrenMore: z.boolean().optional(),
}).strict());

const listOptionsSchema = z.object({
  query: z.string().trim().min(1).max(GUEST_TRACKER_QUERY_MAX).optional(),
  cursor: z.string().trim().min(1).max(GUEST_TRACKER_CURSOR_MAX).optional(),
  state: z.string().trim().min(1).max(GUEST_TRACKER_STATE_MAX).optional(),
  people: z.enum(['any', 'me', 'created']).optional(),
  priority: z.enum(['all', 'none', 'urgent', 'high', 'medium', 'low']).optional(),
  containerId: z.string().trim().min(1).max(GUEST_TRACKER_CONTAINER_ID_MAX).nullable().optional(),
}).strict();

export const guestTrackerRequestSchema: z.ZodType<GuestTrackerRequest> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), options: listOptionsSchema.optional() }).strict(),
  z.object({ op: z.literal('get'), id: z.string().trim().min(1).max(GUEST_TRACKER_ID_MAX) }).strict(),
  z.object({ op: z.literal('filters') }).strict(),
]);

const listResultSchema: z.ZodType<GuestTrackerListResult> = z.union([
  z.object({ connected: z.literal(false) }).strict(),
  z.object({
    connected: z.literal(true),
    items: z.array(itemSummarySchema).max(TRACKER_PROVIDER_LIST_MAX),
    cursor: z.string().max(GUEST_TRACKER_CURSOR_MAX).nullable(),
    hasMore: z.boolean(),
  }).strict(),
]);

const itemResultSchema: z.ZodType<GuestTrackerItemResult> = z.union([
  z.object({ connected: z.literal(false) }).strict(),
  z.object({ connected: z.literal(true), item: itemSchema.nullable() }).strict(),
]);

const filterOptionsSchema: z.ZodType<GuestTrackerFilterOptions> = z.object({
  name: z.string().min(1).max(256),
  stateFilters: z.array(z.string().min(1).max(GUEST_TRACKER_STATE_MAX)).max(GUEST_TRACKER_STATE_MAX),
  people: z.boolean(),
  priority: z.boolean(),
}).strict();

export const guestTrackerResultSchema: z.ZodType<GuestTrackerResult> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), result: listResultSchema }).strict(),
  z.object({ op: z.literal('get'), result: itemResultSchema }).strict(),
  z.object({ op: z.literal('filters'), result: filterOptionsSchema }).strict(),
]);
