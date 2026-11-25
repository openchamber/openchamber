import { z } from 'zod';
import type { SanitizedSettings, SettingsDocument } from './settings-helpers.js';

const activityRenderModeSchema = z.string().trim().pipe(z.enum(['collapsed', 'text', 'grouped', 'summary']));

export const sanitizeChatActivitySettings = (candidate: SettingsDocument, result: SanitizedSettings) => {
  const mode = activityRenderModeSchema.safeParse(candidate.activityRenderMode);
  if (mode.success) result.activityRenderMode = mode.data === 'text' ? 'grouped' : mode.data;
  if (mode.success && mode.data === 'text' && candidate.chatRenderMode !== 'sorted') result.keepEarlierReplies = true;
  const keepEarlierReplies = z.boolean().safeParse(candidate.keepEarlierReplies);
  if (keepEarlierReplies.success) result.keepEarlierReplies = keepEarlierReplies.data;
};
