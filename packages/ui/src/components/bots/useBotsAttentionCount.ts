import { useShallow } from 'zustand/react/shallow';
import { isVSCodeRuntime } from '@/lib/desktop';
import { botSessionOwner } from '@/lib/bots/sessionMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useNotificationCenterStore } from '@/stores/useNotificationCenterStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

export function useBotsAttentionCount(enabled = true): number {
  const pending = useGlobalBlockingRequestsStore((state) => state.bySession);
  // Only pending IDs are looked up. Token-frequency session updates keep this shallow leaf selection unchanged.
  const sessionIds = useGlobalSessionsStore(useShallow((state) => !enabled || isVSCodeRuntime() ? [] : [...pending.keys()].filter((id) => botSessionOwner(id, state.entityById))));
  const entries = useNotificationCenterStore((state) => state.entries);
  return enabled && !isVSCodeRuntime() ? sessionIds.length + entries.filter((entry) => entry.kind === 'bot' && entry.resolvedAt === null && entry.action?.type === 'bots' && (!entry.sessionId || !sessionIds.includes(entry.sessionId))).length : 0;
}
