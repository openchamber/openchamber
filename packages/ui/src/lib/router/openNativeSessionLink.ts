import { z } from 'zod';
import { openHostSession } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { botsRouteTargetSchema } from './types';
import { openBotsFromRoute } from './openBotsFromRoute';
import { openGuestPanelFromRoute } from './openGuestPanelFromRoute';
import { openSessionLink } from './openSessionFromRoute';

const text = z.string().trim().nullish();
const nativeSessionLinkSchema = z.object({
  sessionId: text, directory: text, guestId: text, messageId: text, runtimeKey: text,
  botTarget: botsRouteTargetSchema.optional(),
});

/** Native click/deep-link boundary. Foreign targets never apply to the active runtime. */
export async function openNativeSessionLink(event: CustomEvent<unknown>): Promise<void> {
  const parsed = nativeSessionLinkSchema.safeParse(event.detail);
  if (!parsed.success) return;
  const { sessionId, directory, guestId, messageId, runtimeKey, botTarget } = parsed.data;
  if (!sessionId && !botTarget) return;
  if (runtimeKey && runtimeKey !== getRuntimeKey()) {
    openHostSession(runtimeKey, sessionId ?? null, botTarget);
    return;
  }
  if (botTarget) {
    openBotsFromRoute(botTarget);
    return;
  }
  if (!sessionId) return;
  if (!directory) {
    await openSessionLink(sessionId, messageId ?? null);
    return;
  }
  useSessionUIStore.getState().setCurrentSession(sessionId, directory);
  if (guestId) await openGuestPanelFromRoute(directory, guestId);
}
