import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { bringContextPanelBack, showContextPanelWindow } from '@/lib/contextWindow/owner';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const RailButton: React.FC<{ icon: IconName; label: string; pressed?: boolean; onClick: () => void }> = ({ icon, label, pressed, onClick }) => (
  <Tooltip delayDuration={150}>
    <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          pressed ? 'oc-selected text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon name={icon} className="h-[17px] w-[17px]" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="left" sideOffset={8}>{label}</TooltipContent>
  </Tooltip>
);

export const DetachedPanelRail: React.FC = () => {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t('contextRail.aria.rail')}
      className="flex h-full w-11 flex-shrink-0 flex-col items-center justify-between bg-background pb-2 pt-2"
    >
      <RailButton icon="external-link" label={t('contextPanel.window.show')} pressed onClick={showContextPanelWindow} />
      <RailButton icon="picture-in-picture-2" label={t('contextPanel.window.returnHere')} onClick={bringContextPanelBack} />
    </nav>
  );
};
