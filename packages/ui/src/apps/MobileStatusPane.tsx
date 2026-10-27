import React from 'react';

import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { WorkStatusSectionList } from '@/components/chat/work-status/WorkStatusSectionList';
import { WorkStatusSectionsDialog } from '@/components/chat/work-status/WorkStatusSectionsDialog';
import { WorkStatusTouchContext } from '@/components/chat/work-status/touchContext';
import { LeaveWorkStatusContext } from '@/components/chat/work-status/leaveWorkStatus';
import { WorkStatusPresenceProvider } from '@/components/chat/work-status/presence';
import { useWorkStatusSectionLayout } from '@/components/chat/work-status/useWorkStatusSectionLayout';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * The workspace drawer's Status tab: the desktop Work Status sections for the
 * session on screen, in the phone's grouped look (`WorkStatusTouchContext`).
 * Its hidden list is the phone's own (Subagents starts hidden); Usage is left
 * out, since the phone has a Usage page. Sections mount only while the tab is
 * on screen, so a closed drawer holds no subscriptions. The sections dialog
 * opens from the drawer's tab row, which owns its state.
 */
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
  // Optimistic until sections report, as on the desktop card, so the empty
  // line does not flash before they do.
  const [renderedSections, setRenderedSections] = React.useState(1);
  // Sections left the count when the tab was hidden; optimistic again on return.
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
              <ScrollShadow
                size={24}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4 pt-2"
              >
                <WorkStatusSectionList
                  sessionId={sessionId}
                  directory={directory}
                  repositoryEnabled={!isChatDirectoryPath(directory)}
                  layout={layout}
                />
              </ScrollShadow>
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
