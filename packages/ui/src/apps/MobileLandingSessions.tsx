import type { Session } from '@opencode-ai/sdk/v2';
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  refreshGlobalSessions,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { MobileRecentSessionsList } from './MobileRecentSessionsList';

const LANDING_SESSIONS_LIMIT = 30;

/** Opt-in landing surface (#2565): when no session is open, show the
    cross-project recents list instead of the auto-drafted new session. */
export const MobileLandingSessions: React.FC<{ onStartNewSession: () => void }> = ({
  onStartNewSession,
}) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const globalHasLoaded = useGlobalSessionsStore((state) => state.hasLoaded);

  React.useEffect(() => {
    // Fresh authoritative snapshot on mount, same as the switcher popover.
    void refreshGlobalSessions();
  }, []);

  const handleSelect = React.useCallback(
    (session: Session, projectId: string | null) => {
      if (projectId) setActiveProjectIdOnly(projectId);
      void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    },
    [setActiveProjectIdOnly, setCurrentSession],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <h2 className="typography-micro uppercase tracking-wide text-muted-foreground">
          {t('mobile.landing.recents.title')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-lg px-2 py-1 normal-case typography-ui-label text-primary active:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-primary"
          onClick={onStartNewSession}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="add" className="size-4" />
          {t('mobile.sessions.newChat')}
        </Button>
      </div>
      <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-[calc(var(--oc-safe-area-bottom,0px)+12px)]">
        {globalHasLoaded ? (
          <MobileRecentSessionsList
            enabled
            limit={LANDING_SESSIONS_LIMIT}
            currentSessionId={currentSessionId}
            emptyLabel={t('sessions.switcher.empty')}
            onSelectSession={handleSelect}
          />
        ) : (
          <div className="flex items-center justify-center py-8">
            <Icon aria-hidden name="loader-4" className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
};
