/**
 * Client for the notification center routes
 * (`packages/web/server/lib/notifications/center-routes.js`). The server keeps
 * every notification it raised; this module speaks HTTP and parses what comes
 * back. Every function throws on failure; a server without the center answers
 * 404, reported as `NotificationCenterUnsupportedError`.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const notificationCenterActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sessions'),
    sessions: z.array(z.object({ sessionId: z.string(), directory: z.string().nullable(), title: z.string().nullable() })),
  }),
  z.object({ type: z.literal('openchamber-update'), version: z.string().nullable() }),
  z.object({ type: z.literal('opencode-update'), version: z.string().nullable() }),
  z.object({ type: z.literal('scheduled-tasks'), projectId: z.string() }),
  z.object({ type: z.literal('bots'), projectId: z.string().min(1), itemId: z.string().min(1) }),
]);

const notificationCenterEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  kind: z.enum([
    'ready', 'error', 'question', 'permission', 'goal', 'browser-help', 'plugin',
    'restart', 'fix-loop', 'restack', 'update', 'opencode-update', 'scheduled-task', 'bot',
  ]),
  priority: z.enum(['high', 'normal', 'low']),
  delivery: z.enum(['delivered', 'focused', 'quiet']),
  verdict: z.enum(['review', 'stopped-midway', 'looks-done', 'trivial']).nullable(),
  title: z.string(),
  body: z.string(),
  sessionId: z.string().nullable(),
  directory: z.string().nullable(),
  sessionName: z.string().nullable(),
  /** What the entry waits on (request, fix loop, restack run, update version); servers before v2 send none. */
  requestId: z.string().nullable().optional().transform((value) => value ?? null),
  /** What a click opens besides the session; servers before v2 send none. */
  action: notificationCenterActionSchema.nullable().optional().transform((value) => value ?? null),
  readAt: z.number().nullable(),
  /** When nothing was left to do about it: the entry is in the history. Servers before v2 send none. */
  resolvedAt: z.number().nullable().optional().transform((value) => value ?? null),
});

export type NotificationCenterEntry = z.infer<typeof notificationCenterEntrySchema>;
export type NotificationCenterKind = NotificationCenterEntry['kind'];
export type NotificationCenterVerdict = NonNullable<NotificationCenterEntry['verdict']>;

/** One change broadcast as `openchamber:notification-center.changed`. */
export const notificationCenterChangeSchema = z.discriminatedUnion('change', [
  z.object({ change: z.literal('added'), entry: notificationCenterEntrySchema }),
  z.object({ change: z.literal('read'), ids: z.array(z.string()), readAt: z.number() }),
  z.object({ change: z.literal('cleared') }),
  z.object({ change: z.literal('resolved'), ids: z.array(z.string()), resolvedAt: z.number() }),
  z.object({ change: z.literal('removed'), ids: z.array(z.string()) }),
]);

export type NotificationCenterChange = z.infer<typeof notificationCenterChangeSchema>;

export type NotificationCenterReadTarget = { ids: string[] } | { sessionId: string } | { all: true };

export class NotificationCenterUnsupportedError extends Error {
  constructor() {
    super('This server has no notification center');
    this.name = 'NotificationCenterUnsupportedError';
  }
}

const failure = async (response: Response, action: string): Promise<Error> => {
  if (response.status === 404) return new NotificationCenterUnsupportedError();
  const text = await response.text().catch(() => '');
  return new Error(`Could not ${action} notifications (${response.status})${text ? `: ${text}` : ''}`);
};

// Entries are parsed one by one: an entry a newer server writes in a shape
// this build does not know is left out, and the rest still show.
const listResponseSchema = z.object({ entries: z.array(z.unknown()) });
const readResponseSchema = z.object({ ids: z.array(z.string()), readAt: z.number() });

/** Every kept notification, newest first. */
export const fetchNotificationCenter = async (): Promise<NotificationCenterEntry[]> => {
  // `version=2` asks for every kind; a server before v2 ignores it.
  const response = await runtimeFetch('/api/notification-center?version=2');
  if (!response.ok) throw await failure(response, 'load');
  return listResponseSchema.parse(await response.json()).entries.flatMap((candidate) => {
    const entry = notificationCenterEntrySchema.safeParse(candidate);
    return entry.success ? [entry.data] : [];
  });
};

export const markNotificationCenterRead = async (
  target: NotificationCenterReadTarget,
): Promise<z.infer<typeof readResponseSchema>> => {
  const response = await runtimeFetch('/api/notification-center/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!response.ok) throw await failure(response, 'mark read');
  return readResponseSchema.parse(await response.json());
};

const removeResponseSchema = z.object({ ids: z.array(z.string()) });

/** Deletes the listed entries; answers with the ids the server had. */
export const removeNotificationCenterEntries = async (ids: string[]): Promise<string[]> => {
  const response = await runtimeFetch('/api/notification-center/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw await failure(response, 'remove');
  return removeResponseSchema.parse(await response.json()).ids;
};

export const clearNotificationCenter = async (): Promise<void> => {
  const response = await runtimeFetch('/api/notification-center', { method: 'DELETE' });
  if (!response.ok) throw await failure(response, 'clear');
};
