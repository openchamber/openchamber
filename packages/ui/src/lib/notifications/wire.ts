import { z } from 'zod';

export interface NotificationPayload {
  title?: string;
  body?: string;
  tag?: string;
  kind?: string;
  sessionId?: string;
  messageId?: string;
  directory?: string;
  runtimeKey?: string;
  requireHidden?: boolean;
  showWhenFocused?: boolean;
  toastOnly?: boolean;
}

export type OpenchamberNotification = Omit<NotificationPayload, 'runtimeKey'> & {
  desktopNotificationDelivered?: boolean;
  desktopStdoutActive?: boolean;
};

export const openchamberNotificationSchema = z.object({
  type: z.literal('openchamber:notification'),
  properties: z
    .object({
      kind: z.string(),
      sessionId: z.string(),
      messageId: z.string(),
      directory: z.string(),
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
