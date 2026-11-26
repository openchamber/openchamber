import { z } from 'zod';
import { openSession } from '@/lib/router/openSessionFromRoute';

export const vscodeSessionNavigationSchema = z.object({
  sessionId: z.string().trim().min(1),
  messageId: z.string().trim().min(1).optional(),
});

export const applyVSCodeSessionNavigation = (navigation: z.infer<typeof vscodeSessionNavigationSchema>): void => {
  void openSession(navigation.sessionId, { messageId: navigation.messageId ?? null });
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
};
