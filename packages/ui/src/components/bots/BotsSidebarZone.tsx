import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { botSessionOwner } from '@/lib/bots/sessionMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useNotificationCenterStore } from '@/stores/useNotificationCenterStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useMobileAppActions } from '@/apps/mobileAppContext';

function PendingBotSession({ sessionId, onLeave }: { readonly sessionId: string; readonly onLeave?: () => void }) {
  const title = useGlobalSessionsStore((state) => state.entityById.get(sessionId)?.title ?? sessionId);
  const { t } = useI18n();
  return <Button variant="ghost" size="sm" className="w-full min-w-0 justify-start text-start" title={title} onClick={() => {
    const directory = useGlobalBlockingRequestsStore.getState().bySession.get(sessionId)?.directory ?? null;
    useSessionUIStore.getState().setCurrentSession(sessionId, directory);
    useUIStore.getState().closeMainSurfaces();
    onLeave?.();
  }}><Icon name="question" className="size-3.5 text-[var(--status-warning-text)]" /><span className="truncate oc-ui-start-align" dir="auto">{title}</span><span className="sr-only">{t('bots.attention')}</span></Button>;
}

export function BotsSidebarZone({ onLeave, query = '' }: { readonly onLeave?: () => void; readonly query?: string }) {
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const pending = useGlobalBlockingRequestsStore((state) => state.bySession);
  const sessionIds = useGlobalSessionsStore(useShallow((state) => isVSCodeRuntime() ? [] : [...pending.keys()].filter((id) => {
    const session = state.entityById.get(id);
    return botSessionOwner(id, state.entityById) && (!query || session?.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  })));
  const entries = useNotificationCenterStore((state) => state.entries);
  const items = entries.filter((entry) => entry.kind === 'bot' && entry.resolvedAt === null && entry.action?.type === 'bots' && (!entry.sessionId || !sessionIds.includes(entry.sessionId)) && (!query || entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  if (isVSCodeRuntime() || sessionIds.length + items.length === 0) return null;
  return <section aria-label={t('bots.title')} className="py-1">
    <h2 className="flex items-center gap-1.5 px-3 py-1.5 typography-ui-label"><Icon name="robot-2" className="size-3.5" />{t('bots.title')}</h2>
    {sessionIds.map((id) => <PendingBotSession key={id} sessionId={id} onLeave={onLeave} />)}
    {items.map((entry) => <Button key={entry.id} variant="ghost" size="sm" className="w-full min-w-0 justify-start text-start" title={entry.body} onClick={() => {
      if (entry.action?.type !== 'bots') return;
      useUIStore.getState().setBotsPageTarget({ projectId: entry.action.projectId, itemId: entry.action.itemId });
      if (mobile) mobile.openBots(); else useUIStore.getState().setBotsPageOpen(true);
      onLeave?.();
    }}><Icon name="error-warning" className="size-3.5 text-[var(--status-warning-text)]" /><span className="truncate oc-ui-start-align" dir="auto">{entry.title}</span></Button>)}
  </section>;
}
