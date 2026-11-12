import { z } from 'zod';
import { openSession } from '@/lib/router/openSessionFromRoute';

export const vscodeSessionNavigationSchema = z.object({ sessionId: z.string().trim().min(1) });

export const applyVSCodeSessionNavigation = (navigation: z.infer<typeof vscodeSessionNavigationSchema>): void => {
  void openSession(navigation.sessionId);
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
};
