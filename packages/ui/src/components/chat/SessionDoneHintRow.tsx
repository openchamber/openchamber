import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { isDoneSuggested } from '@/lib/sessionWorkMetadata';
import { setSessionWorkState } from '@/sync/session-actions';
import { settleRunningOperatorChildren } from '@/sync/operator-children-done';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';

interface SessionDoneHintRowProps {
  sessionId: string | null;
  directory?: string;
}

export const SessionDoneHintRow: React.FC<SessionDoneHintRowProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory);
  const status = useSessionStatus(sessionId ?? '', directory);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const [pending, setPending] = React.useState(false);
  const isIdle = !status || status.type === 'idle';

  if (!sessionId || !session || !sessionWorkEnabled || !isIdle || !isDoneSuggested(session)) return null;

  const handleMarkDone = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (!await settleRunningOperatorChildren([sessionId])) return;
      await setSessionWorkState(sessionId, directory, 'done');
      leaveFinishedSessions([sessionId]);
    } catch {
      toast.error(t('sessions.sidebar.session.work.updateFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex oc-composer-row items-center gap-2 border-b border-edge ps-3 pe-1.5">
      <Icon name="check" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{t('chat.work.doneHint.text')}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => { void handleMarkDone(); }}
              onMouseDown={(event) => event.preventDefault()}
              className="shrink-0 text-status-success/80 hover:bg-transparent hover:text-status-success"
            >
              {t('chat.work.doneHint.action')}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>{t('contextTooltips.chat.markDone')}</TooltipContent>
      </Tooltip>
    </div>
  );
});

SessionDoneHintRow.displayName = 'SessionDoneHintRow';
