import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useSessionAssistState } from '@/hooks/useSessionAssist';
import { patchSessionMetadata } from '@/sync/session-actions';
import { useI18n } from '@/lib/i18n';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';

interface SessionSuggestionChipProps {
  sessionId: string | null;
  directory?: string;
  /** The composer already has content — the suggestion must stay out of the way. */
  hidden: boolean;
  onApply: (text: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A suggested follow-up docked above the composer, like the BTW panel.
// Tapping it fills the composer (no auto-send); the X patches the
// suggestion out of the session metadata so it stays dismissed everywhere.
export const SessionSuggestionChip: React.FC<SessionSuggestionChipProps> = React.memo(({ sessionId, directory, hidden, onApply }) => {
  const { suggestion } = useSessionAssistState(sessionId ?? '', directory);
  const { t } = useI18n();
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

  return (
    <ComposerFloatingPanel compact header={<>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onApply(suggestion)}
              onMouseDown={(event) => event.preventDefault()}
              aria-label={t('chat.suggestion.applyAria')}
              className="min-w-0 flex-1 shrink justify-start px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
            >
              <Icon name="pencil-ai-2" className="size-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
              <span className="truncate">{suggestion}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-wrap">
            {suggestion}
          </TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={(event) => void handleDismiss(event)}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={t('chat.suggestion.dismissAria')}
          title={t('chat.suggestion.dismissAria')}
          className="size-7 shrink-0 rounded-lg text-muted-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent"
        >
          <Icon name="close" className="size-4" />
        </Button>
    </>} />
  );
});

SessionSuggestionChip.displayName = 'SessionSuggestionChip';
