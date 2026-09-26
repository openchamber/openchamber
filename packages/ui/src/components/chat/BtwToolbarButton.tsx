import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useBtwStore } from '@/stores/useBtwStore';
import { useInputStore } from '@/sync/input-store';
import { focusChatInput } from './composer/editor/dom';
import { cn } from '@/lib/utils';

interface BtwToolbarButtonProps {
  sessionId: string | null;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
  onExitBtw: () => void;
  /** True while the composer talks to a live btw fork (not mere pending). */
  isBtwActive?: boolean;
}

// Toolbar entry point for a temporary (`/btw`) question, beside the
// SessionGoalButton. One tap enters pending btw mode (the next sent message
// forks into a temporary session; `/btw` keeps working as before) and a
// second tap while pending exits it. While pending the button stays lit,
// mirroring the armed goal target.
export const BtwToolbarButton: React.FC<BtwToolbarButtonProps> = React.memo(({
  sessionId,
  footerIconButtonClass,
  iconSizeClass,
  withTooltip = false,
  onExitBtw,
  isBtwActive = false,
}) => {
  const { t } = useI18n();
  const pending = useBtwStore((state) => (sessionId ? state.byParent[sessionId]?.pending === true : false));
  const requestBtwComposer = useInputStore((state) => state.requestBtwComposer);

  if (!sessionId) {
    return null;
  }
  // Inside a live btw fork the entry is meaningless (exit lives on the panel).
  // While merely pending the button stays mounted and lit so the mode has a
  // visible, clickable indicator.
  if (isBtwActive && !pending) {
    return null;
  }

  const label = pending ? t('chat.btw.cancelAria') : t('chat.btw.toolbar.askAria');

  const handleClick = () => {
    if (pending) {
      onExitBtw();
      return;
    }
    requestBtwComposer({ parentSessionId: sessionId, text: '' });
    queueMicrotask(() => focusChatInput());
  };

  const button = (
    <button
      type="button"
      className={cn(footerIconButtonClass)}
      style={pending ? { color: 'var(--status-info)' } : undefined}
      onClick={handleClick}
      // Same guard as SessionGoalButton: entering pending mode happens
      // mid-typing, so the tap must not dismiss the soft keyboard.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onPointerDownCapture={(event) => {
        if (event.pointerType === 'touch') {
          event.preventDefault();
        }
      }}
      aria-label={label}
      aria-pressed={pending}
      {...(withTooltip ? {} : { title: label })}
    >
      <Icon name="question" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
    </button>
  );

  if (!withTooltip) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
});

BtwToolbarButton.displayName = 'BtwToolbarButton';
