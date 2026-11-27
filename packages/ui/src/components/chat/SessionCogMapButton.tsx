import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCogMapStore } from '@/stores/useCogMapStore';
import { useUIStore } from '@/stores/useUIStore';

interface SessionCogMapButtonProps {
  sessionId: string | null;
  directory?: string;
  draftOpen?: boolean;
  footerIconButtonClass: string;
  iconSizeClass: string;
  withTooltip?: boolean;
}

/**
 * Composer footer toggle for Cognitive Map mode.
 * Supports both active sessions (immediate server sync) and draft sessions (armed until first message).
 * Turning it on also opens the docked Cognitive Map panel so solo or co-created edits stay visible.
 */
export const SessionCogMapButton: React.FC<SessionCogMapButtonProps> = React.memo(({
  sessionId,
  directory,
  draftOpen = false,
  footerIconButtonClass,
  iconSizeClass,
  withTooltip = false,
}) => {
  const { t } = useI18n();
  const sessionState = useCogMapStore((state) => (sessionId ? state.sessions[sessionId] : undefined));
  const draftModeActive = useCogMapStore((state) => state.draftModeActive);
  const draftPacing = useCogMapStore((state) => state.draftPacing);
  const setSessionMode = useCogMapStore((state) => state.setSessionMode);
  const setDraftMode = useCogMapStore((state) => state.setDraftMode);
  const setDraftPacing = useCogMapStore((state) => state.setDraftPacing);
  const openContextSurface = useUIStore((state) => state.openContextSurface);

  if (isVSCodeRuntime() || (!sessionId && !draftOpen)) {
    return null;
  }

  const active = sessionId ? Boolean(sessionState?.modeActive) : draftModeActive;
  const pacing = sessionId ? (sessionState?.pacing ?? 'collab') : draftPacing;

  const label = active ? t('chat.cogmap.button.disableAria') : t('chat.cogmap.button.enableAria');

  const handleToggle = () => {
    const nextActive = !active;
    if (sessionId) {
      void setSessionMode(sessionId, {
        active: nextActive,
        pacing,
        directory: directory || null,
      });
    } else {
      setDraftMode(nextActive, pacing);
    }
    if (nextActive && directory) {
      openContextSurface(directory, 'cogmap');
    }
  };

  const handleCyclePacing = () => {
    const nextPacing = pacing === 'collab' ? 'auto' : 'collab';
    if (sessionId) {
      void setSessionMode(sessionId, {
        active: true,
        pacing: nextPacing,
        directory: directory || null,
      });
    } else {
      setDraftPacing(nextPacing);
    }
  };

  const button = (
    <button
      type="button"
      className={footerIconButtonClass}
      style={active ? { color: 'var(--status-info)' } : undefined}
      onClick={handleToggle}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDownCapture={(event) => {
        if (event.pointerType === 'touch') event.preventDefault();
      }}
      aria-label={label}
      aria-pressed={active}
      {...(withTooltip ? {} : { title: label })}
    >
      <Icon name="brain" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
    </button>
  );

  const pacingLabel = pacing === 'auto' ? t('chat.cogmap.pacing.auto') : t('chat.cogmap.pacing.collab');
  const pacingTooltip = pacing === 'auto'
    ? t('chat.cogmap.pacing.switchToCollab')
    : t('chat.cogmap.pacing.switchToAuto');

  return (
    <div className="inline-flex items-center gap-0.5">
      {withTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
      ) : button}
      {active ? (
        <button
          type="button"
          onClick={handleCyclePacing}
          onMouseDown={(event) => event.preventDefault()}
          title={pacingTooltip}
          aria-label={pacingTooltip}
          className="rounded-md bg-[var(--status-info-background)] px-1.5 py-0.5 typography-micro font-medium text-[var(--status-info)] transition-colors hover:opacity-85"
        >
          {pacingLabel}
        </button>
      ) : null}
    </div>
  );
});

SessionCogMapButton.displayName = 'SessionCogMapButton';
