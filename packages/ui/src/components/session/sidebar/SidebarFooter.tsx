import React from 'react';
import { RiInformationLine, RiQuestionLine, RiSettings3Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/hooks/useLanguage';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

const footerButtonClassName = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
}: Props): React.ReactNode {
  const { t } = useLanguage();
  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenSettings} className={footerButtonClassName} aria-label="Settings">
                <RiSettings3Line className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>Settings</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenShortcuts} className={footerButtonClassName} aria-label="Shortcuts">
                <RiQuestionLine className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>Shortcuts</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenAbout} className={footerButtonClassName} aria-label="About OpenChamber">
                <RiInformationLine className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>About OpenChamber</p></TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {showUpdateButton ? (
        <Button
          type="button"
          variant="default"
          size="xs"
          className="ml-auto border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:bg-[var(--status-info-background)]/80 hover:text-[var(--status-info)]"
          onClick={onOpenUpdate}
        >
          {t('aboutSettings.update')}
        </Button>
      ) : null}
    </div>
  );
}
