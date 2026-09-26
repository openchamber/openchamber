import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo, shortcutRegistry } from '@/lib/shortcuts';
import { sessionHistory } from '@/lib/sessionNavigationHistory';

const actions = [
  { id: 'navigate_session_back', icon: 'arrow-left', availability: 'canGoBack',
    label: 'settings.openchamber.keyboardShortcuts.action.navigate_session_back.label' },
  { id: 'navigate_session_forward', icon: 'arrow-right', availability: 'canGoForward',
    label: 'settings.openchamber.keyboardShortcuts.action.navigate_session_forward.label' },
] as const;

export const SessionHistoryControls: React.FC<{ touch?: boolean }> = ({ touch = false }) => {
  const { t } = useI18n();
  const overrides = useUIStore((state) => state.shortcutOverrides);
  const state = React.useSyncExternalStore(
    sessionHistory.subscribe, sessionHistory.getSnapshot, sessionHistory.getSnapshot,
  );
  return (
    <div className="app-region-no-drag flex shrink-0 items-center gap-0.5">
      {actions.map((action) => {
        const label = t(action.label);
        const combo = getEffectiveShortcutCombo(action.id, overrides);
        const hint = combo ? formatShortcutForDisplay(combo) : '';
        const enabled = state[action.availability];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger asChild>
              {/* The stable wrapper owns the trigger so the button keeps its DOM
                  identity across availability changes; hover and keyboard focus
                  delegate to it, and a disabled Button stops taking pointers. */}
              <span className="inline-flex">
                <Button
                  type="button" variant="ghost" size="icon"
                  className={cn('shrink-0', touch ? 'h-11 w-11' : 'h-8 w-8')}
                  style={{ touchAction: 'manipulation' }}
                  aria-label={label}
                  disabled={!enabled}
                  data-focus-ring="accent"
                  onClick={() => { shortcutRegistry.invoke(action.id); }}
                >
                  <Icon name={action.icon} className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent><span>{label}{hint ? ` (${hint})` : ''}</span></TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};
