import React from 'react';

import { Button } from '@/components/ui/button';
import { WorkStatusSectionList } from '@/components/chat/work-status/WorkStatusSectionList';
import { WorkStatusSectionsDialog } from '@/components/chat/work-status/WorkStatusSectionsDialog';
import { WorkStatusTouchContext } from '@/components/chat/work-status/touchContext';
import { LeaveWorkStatusContext } from '@/components/chat/work-status/leaveWorkStatus';
import { WorkStatusPresenceProvider } from '@/components/chat/work-status/presence';
import { useWorkStatusSectionLayout } from '@/components/chat/work-status/useWorkStatusSectionLayout';
import { useLoadSessionTodos } from '@/components/chat/work-status/useLoadSessionTodos';
import { isWorkStatusSectionVisible } from '@/components/chat/work-status/sections';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

export const MobileStatusPane: React.FC<{
  visible: boolean;
  onLeave: () => void;
  sectionsDialogOpen: boolean;
  onSectionsDialogOpenChange: (open: boolean) => void;
}> = ({ visible, onLeave, sectionsDialogOpen, onSectionsDialogOpenChange }) => {
  const { t } = useI18n();
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const directory = useEffectiveDirectory() ?? null;
  const layout = useWorkStatusSectionLayout();
  useLoadSessionTodos(sessionId, directory, visible && isWorkStatusSectionVisible(layout.hiddenSections, 'tasks'));
  const [renderedSections, setRenderedSections] = React.useState(1);
  React.useEffect(() => {
    if (visible) setRenderedSections((count) => Math.max(count, 1));
  }, [visible]);
  const showNothing = !layout.allSectionsHidden && renderedSections === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {visible && !layout.allSectionsHidden ? (
        <LeaveWorkStatusContext.Provider value={onLeave}>
          <WorkStatusTouchContext.Provider value>
            <WorkStatusPresenceProvider onChange={setRenderedSections}>
              <ScrollableOverlay
                useScrollShadow
                scrollShadowSize={24}
                outerClassName="min-h-0 flex-1"
                className="px-3 pb-4 pt-2"
                disableHorizontal
              >
                <WorkStatusSectionList
                  sessionId={sessionId}
                  directory={directory}
                  repositoryEnabled={!isChatDirectoryPath(directory)}
                  layout={layout}
                />
              </ScrollableOverlay>
            </WorkStatusPresenceProvider>
          </WorkStatusTouchContext.Provider>
        </LeaveWorkStatusContext.Provider>
      ) : null}

      {layout.allSectionsHidden || showNothing ? (
        <div className="absolute inset-x-0 top-16 flex flex-col items-center px-6 text-center">
          <span className="typography-ui-label text-muted-foreground">
            {layout.allSectionsHidden ? t('chat.workStatus.sections.allHidden') : t('chat.workStatus.mobileEmpty')}
          </span>
          {layout.allSectionsHidden ? (
            <Button variant="link" size="sm" onClick={() => onSectionsDialogOpenChange(true)} className="mt-2 normal-case text-muted-foreground hover:text-foreground">
              {t('chat.workStatus.sections.open')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={onSectionsDialogOpenChange} />
    </div>
  );
};
