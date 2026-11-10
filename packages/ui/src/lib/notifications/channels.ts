import { z } from 'zod';

import { publicNotificationsSchema } from '@/lib/guests/parse';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The account card of an extension notification channel talks to
 * `/api/notifications/channels` (`packages/web/server/lib/notifications/channel-routes.js`).
 * Answers are parsed here; a token never comes back from the server.
 */

const accountSchema = z.object({
  id: z.string().min(1).max(256),
  login: z.string().min(1).max(256).nullable(),
  name: z.string().min(1).max(256).optional(),
  connectedAt: z.number().int().nonnegative(),
  status: z.enum(['valid', 'invalid']),
  invalidReason: z.string().min(1).max(256).optional(),
});

const channelAccountSchema = z.object({
  instance: z.string().min(1).max(2_048),
  account: accountSchema,
});

const channelSchema = z.object({
  providerId: z.string().min(1).max(64),
  guestId: z.string().min(1).max(128),
  name: z.string().min(1),
  channel: publicNotificationsSchema,
  account: channelAccountSchema.nullable(),
});

const listSchema = z.object({ channels: z.array(z.unknown()) });

const failureSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1).max(64).optional(),
});

type NotificationChannelAccount = z.infer<typeof channelAccountSchema>;
export type NotificationChannel = z.infer<typeof channelSchema>;

export type ConnectChannelFailureCode =
  | 'CHANNEL_UNKNOWN'
  | 'TOKEN_REQUIRED'
  | 'USERNAME_REQUIRED'
  | 'USERNAME_INVALID'
  | 'INSTANCE_REQUIRED'
  | 'UNSUPPORTED_INSTANCE'
  | 'TOKEN_REFUSED'
  | 'CHANNEL_UNAVAILABLE'
  | 'failed';

type ConnectChannelResult =
  | { ok: true; account: NotificationChannelAccount }
  | { ok: false; code: ConnectChannelFailureCode; message: string | null };

/** What the card sends to connect: the token, the username a `basic` channel needs, the instance a user-typed one needs. */
export type ConnectChannelInput = { token: string; username?: string; instance?: string };

/** The channels the server lists, one row at a time: a row this build cannot read is left out, the rest stay. `null` is a body that is not a list. */
export const parseNotificationChannelsJson = (json: string): NotificationChannel[] | null => {
  let body: z.input<typeof listSchema>;
  try {
    body = JSON.parse(json);
  } catch {
    return null;
  }
  const list = listSchema.safeParse(body);
  if (!list.success) return null;
  const channels: NotificationChannel[] = [];
  for (const raw of list.data.channels) {
    const parsed = channelSchema.safeParse(raw);
    if (parsed.success) channels.push(parsed.data);
  }
  return channels;
};

/** `null` is a failed load, never an empty list. */
export const loadNotificationChannels = async (): Promise<NotificationChannel[] | null> => {
  try {
    const response = await runtimeFetch('/api/notifications/channels');
    if (!response.ok) return null;
    return parseNotificationChannelsJson(await response.text());
  } catch {
    return null;
  }
};

const KNOWN_FAILURES = ['CHANNEL_UNKNOWN', 'TOKEN_REQUIRED', 'USERNAME_REQUIRED', 'USERNAME_INVALID', 'INSTANCE_REQUIRED', 'UNSUPPORTED_INSTANCE', 'TOKEN_REFUSED', 'CHANNEL_UNAVAILABLE'] as const;
const knownFailureSchema = z.enum(KNOWN_FAILURES);

const readFailure = async (response: Response): Promise<ConnectChannelResult> => {
  const parsed = failureSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, code: 'failed', message: null };
  const known = knownFailureSchema.safeParse(parsed.data.code);
  return { ok: false, code: known.success ? known.data : 'failed', message: parsed.data.error };
};

export const connectNotificationChannel = async (providerId: string, input: ConnectChannelInput): Promise<ConnectChannelResult> => {
  try {
    const response = await runtimeFetch(`/api/notifications/channels/${encodeURIComponent(providerId)}/account`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) return readFailure(response);
    const parsed = z.object({ channel: channelAccountSchema }).safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, account: parsed.data.channel } : { ok: false, code: 'failed', message: null };
  } catch {
    return { ok: false, code: 'failed', message: null };
  }
};

export const disconnectNotificationChannel = async (providerId: string): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/notifications/channels/${encodeURIComponent(providerId)}/account`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
};
