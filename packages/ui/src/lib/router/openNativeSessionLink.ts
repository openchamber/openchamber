import { z } from 'zod';
import { openSessionInOwningHostWindow } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { botsRouteTargetSchema } from './types';
import { openBotsFromRoute } from './openBotsFromRoute';
import { openGuestPanelFromRoute } from './openGuestPanelFromRoute';
import { openSession } from './openSessionFromRoute';

const text = z.string().trim().nullish();
const nativeSessionLinkSchema = z.object({
  sessionId: text, directory: text, guestId: text, messageId: text, runtimeKey: text,
  botTarget: botsRouteTargetSchema.optional(),
  requireKnownSession: z.boolean().optional(),
});

/** Native click/deep-link boundary. Foreign Bots targets never apply to the active runtime. */
export async function openNativeSessionLink(event: CustomEvent<unknown>): Promise<void> {
  const parsed = nativeSessionLinkSchema.safeParse(event.detail);
  if (!parsed.success) return;
  const { sessionId, directory, guestId, messageId, runtimeKey, botTarget, requireKnownSession } = parsed.data;
  if (!sessionId && !botTarget) return;
  if (runtimeKey && runtimeKey !== getRuntimeKey()) {
    const forwarded = openSessionInOwningHostWindow(sessionId ?? null, runtimeKey, messageId ?? null, botTarget);
    if (forwarded || botTarget) return;
  }
  if (botTarget) {
    openBotsFromRoute(botTarget);
    return;
  }
  if (!sessionId) return;
  const runtime = getBotsRuntime();
  await openSession(sessionId, { directory, messageId, requireKnownSession, signal: runtime.signal });
  if (runtime.signal.aborted) return;
  if (guestId && directory) await openGuestPanelFromRoute(directory, guestId);
}
