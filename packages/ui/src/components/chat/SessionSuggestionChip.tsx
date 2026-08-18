import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { patchSessionMetadata } from '@/sync/session-actions';
import { useI18n } from '@/lib/i18n';

interface SessionSuggestionChipProps {
  sessionId: string | null;
  directory?: string;
  /** The composer already has content — the suggestion must stay out of the way. */
  hidden: boolean;
  onApply: (text: string) => void;
  className?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// One small-model-suggested follow-up message, styled like the draft starter
// chips. Tapping it fills the composer (no auto-send); the X patches the
// suggestion out of the session metadata so it stays dismissed everywhere.
export const SessionSuggestionChip: React.FC<SessionSuggestionChipProps> = React.memo(({ sessionId, directory, hidden, onApply, className }) => {
  const { suggestion } = useSessionAssistState(sessionId ?? '', directory);
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [dismissing, setDismissing] = React.useState(false);

  const handleDismiss = React.useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!sessionId || dismissing) return;
    setDismissing(true);
    try {
      await patchSessionMetadata(sessionId, undefined, (metadata) => {
        const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
        const assist = isRecord(namespace.assist) ? namespace.assist : {};
        const nextAssist = { ...assist };
        delete nextAssist.suggestion;
        return { ...metadata, openchamber: { ...namespace, assist: nextAssist } };
      });
    } catch (error) {
      console.warn('Failed to dismiss suggestion:', error);
    } finally {
      setDismissing(false);
    }
  }, [sessionId, dismissing]);

  if (!suggestion || hidden) {
    return null;
  }

  const chipStyle: React.CSSProperties = {
    backgroundColor: currentTheme?.colors?.surface?.elevated,
    borderColor: currentTheme?.colors?.interactive?.border,
  };

  return (
    <div className={`flex w-full min-w-0 justify-center ${className ?? ''}`}>
      <div className="relative w-full min-w-0 max-w-full">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onApply(suggestion)}
              onMouseDown={(event) => event.preventDefault()}
              aria-label={t('chat.suggestion.applyAria')}
              className="group flex w-full min-w-0 select-none items-center gap-1.5 rounded-full border py-1.5 pl-3 pr-8 text-sm text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
              style={chipStyle}
            >
              <Icon name="pencil-ai-2" className="h-3.5 w-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
              <span className="truncate">{suggestion}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-wrap">
            {suggestion}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={(event) => void handleDismiss(event)}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={t('chat.suggestion.dismissAria')}
          title={t('chat.suggestion.dismissAria')}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
});

SessionSuggestionChip.displayName = 'SessionSuggestionChip';
