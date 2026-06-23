import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from './useHeaderState';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  Icon: IconName;
  iconClassName?: string;
  pressed?: boolean;
};

export const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon: iconName,
  iconClassName,
  pressed = false,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          aria-pressed={pressed}
          className={cn(
            className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS,
            pressed && 'bg-interactive-selection text-interactive-selection-foreground'
          )}
        >
          <Icon name={iconName} className={iconClassName ?? 'h-[18px] w-[18px]'} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
});
