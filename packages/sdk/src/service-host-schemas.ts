import { z } from 'zod';

import {
  MENTIONS_ITEMS_MAX,
  MENTION_ID_MAX,
  MENTION_TEXT_MAX,
  MENTION_TITLE_MAX,
  SERVICE_EVENT_TOPIC_MAX,
  SERVICE_INSTRUCTIONS_MAX,
  SERVICE_PROMPT_MAX,
  SERVICE_STATUS_MESSAGE_MAX,
} from './service-host.ts';

const prompt = z.string().trim().min(1).max(SERVICE_PROMPT_MAX);
const sessionId = z.string().trim().min(1).max(256);
const shortText = z.string().trim().min(1).max(256);
const directory = z.string().trim().min(1).max(4096);

/** The host's parse of a service call; anything else is refused before it runs. */
export const serviceHostCallSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('sessions.start'),
    input: z.object({
      prompt,
      projectId: shortText.optional(),
      directory: directory.optional(),
      title: shortText.optional(),
      model: shortText.optional(),
      variant: shortText.optional(),
      agent: shortText.optional(),
    }).strict().refine((input) => !(input.projectId && input.directory), { message: 'Give projectId or directory, not both' }),
  }).strict(),
  z.object({ method: z.literal('sessions.send'), input: z.object({ sessionId, prompt }).strict() }).strict(),
  z.object({ method: z.literal('sessions.retry'), input: z.object({ sessionId }).strict() }).strict(),
  z.object({ method: z.literal('sessions.status'), input: z.object({ sessionId }).strict() }).strict(),
  z.object({ method: z.literal('sessions.lastReply'), input: z.object({ sessionId }).strict() }).strict(),
  z.object({
    method: z.literal('instructions.set'),
    input: z.object({ directory: directory.nullable(), text: z.string().max(SERVICE_INSTRUCTIONS_MAX) }).strict(),
  }).strict(),
  z.object({
    method: z.literal('panels.emit'),
    input: z.object({ topic: z.string().trim().min(1).max(SERVICE_EVENT_TOPIC_MAX), data: z.json().optional() }).strict(),
  }).strict(),
  z.object({ method: z.literal('settings.read'), input: z.object({}).strict() }).strict(),
  z.object({
    method: z.literal('status.set'),
    input: z.object({ needsConfiguration: z.string().trim().min(1).max(SERVICE_STATUS_MESSAGE_MAX).nullable() }).strict(),
  }).strict(),
]);

/** The host's parse of a search answer; one that does not parse adds nothing to the menu. */
export const mentionsSearchResultSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(MENTION_ID_MAX),
    title: z.string().trim().min(1).max(MENTION_TITLE_MAX),
    subtitle: z.string().trim().min(1).max(MENTION_TITLE_MAX).optional(),
    url: z.url({ protocol: /^https?$/ }).max(2_048).optional(),
  })).max(MENTIONS_ITEMS_MAX),
});

/** The host's parse of a picked row. */
export const mentionsResolveResultSchema = z.object({ text: z.string().trim().min(1).max(MENTION_TEXT_MAX) });

export type ServiceHostCall = z.output<typeof serviceHostCallSchema>;
