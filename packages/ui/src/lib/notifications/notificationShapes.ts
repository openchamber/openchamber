import { z } from 'zod';

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
  kind?: string;
  sessionId?: string;
  directory?: string;
  itemUrl?: string;
  runtimeKey?: string;
  requireHidden?: boolean;
  showWhenFocused?: boolean;
}

export type OpenchamberNotification = {
  kind?: string
  sessionId?: string
  directory?: string
  itemUrl?: string
  title?: string
  body?: string
  tag?: string
  requireHidden?: boolean
  showWhenFocused?: boolean
  toastOnly?: boolean
  desktopNotificationDelivered?: boolean
  desktopStdoutActive?: boolean
};

export const openchamberNotificationSchema = z.object({
  type: z.literal('openchamber:notification'),
  properties: z
    .object({
      kind: z.string(),
      sessionId: z.string(),
      directory: z.string(),
      itemUrl: z.string(),
      title: z.string(),
      body: z.string(),
      tag: z.string(),
      requireHidden: z.boolean(),
      showWhenFocused: z.boolean(),
      toastOnly: z.boolean(),
      desktopNotificationDelivered: z.boolean(),
      desktopStdoutActive: z.boolean(),
    })
    .partial(),
});

export const notificationPropertiesSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tag: z.string().optional(),
  kind: z.string().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  itemUrl: z.string().optional(),
  requireHidden: z.boolean().optional(),
  showWhenFocused: z.boolean().optional(),
  toastOnly: z.boolean().optional(),
});
