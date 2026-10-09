import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

const footerButtonClassName = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const pressedFooterButtonClassName = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';

export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
}: Props): React.ReactNode {
  const { t } = useI18n();
  // On a remote host the button updates this app, not the server it shows.
  const isDesktopRemote = useDesktopRemoteHostActive();
  // Usage is a page in the main area: the button stays pressed while it is open and closes it again.
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);

  if (!showRuntimeButtons && !showUpdateButton) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenSettings} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.settings')}>
                <Icon name="settings-3" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.settings')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => useUIStore.getState().setUsageStatsPageOpen(!isUsageOpen)}
                className={cn(footerButtonClassName, isUsageOpen && pressedFooterButtonClassName)}
                aria-label={t('usageStats.openAction')}
                aria-pressed={isUsageOpen}
              >
                <Icon name="bar-chart" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('usageStats.openAction')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenShortcuts} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.shortcuts')}>
                <Icon name="command" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.shortcuts')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenAbout} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.aboutOpenChamber')}>
                <Icon name="information" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.aboutOpenChamber')}</p></TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {showUpdateButton ? (
        <Button
          type="button"
          variant="default"
          size="xs"
          className="ml-auto border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:bg-[var(--status-info-background)]/80 hover:text-[var(--status-info)] dark:border-[var(--status-info-border)] dark:bg-[var(--status-info-background)] dark:hover:bg-[var(--status-info-background)]/80"
          onClick={onOpenUpdate}
        >
          {isDesktopRemote ? t('sessions.sidebar.footer.actions.updateApp') : t('sessions.sidebar.footer.actions.update')}
        </Button>
      ) : null}
    </div>
  );
}
