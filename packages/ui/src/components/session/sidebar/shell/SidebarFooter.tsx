import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { DesktopInstanceMenu } from '@/components/desktop/DesktopInstanceMenu';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  onOpenSettings: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

const footerButtonClassName = 'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Settings, an available update and the instance switcher. Usage, shortcuts
 * and About live in the header's More menu.
 */
export function SidebarFooter({
  onOpenSettings,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  // On a remote host the button updates this app, not the server it shows.
  const isDesktopRemote = useDesktopRemoteHostActive();

  if (!showRuntimeButtons && !showUpdateButton) {
    return null;
  }

  const updateLabel = isDesktopRemote ? t('sessions.sidebar.footer.actions.updateApp') : t('sessions.sidebar.footer.actions.update');

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={onOpenSettings} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.settings')}>
              <Icon name="settings-3" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><TooltipLabelWithShortcut label={t('sessions.sidebar.footer.actions.settings')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('open_settings', shortcutOverrides), '')} /></TooltipContent>
        </Tooltip>
      ) : null}
      {showUpdateButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenUpdate}
              className={cn(footerButtonClassName, 'text-[var(--status-info)] hover:bg-[var(--status-info-background)] hover:text-[var(--status-info)]')}
              aria-label={updateLabel}
            >
              <Icon name="download" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><p>{updateLabel}</p></TooltipContent>
        </Tooltip>
      ) : null}
      {showRuntimeButtons ? (
        <DesktopInstanceMenu className="ms-auto inline-flex h-6 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      ) : null}
    </div>
  );
}
