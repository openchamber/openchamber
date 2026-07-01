import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useBrowserController } from './useBrowserController';
import { useBrowserSharingStore } from '@/stores/useBrowserSharingStore';
import type { BrowserBackend } from '@/lib/api/types';
import type { BrowserExecutorCallbacks } from '@/lib/browser/executor';

interface BrowserAgentControlBarProps {
  backend: BrowserBackend;
  controllerId: string;
  /** Directory that owns the persisted share/stop preference. */
  directory: string;
  /** Reactive current URL of the pane (drives navigation sync). */
  url: string;
  title?: string;
  /** Latest pane executor callbacks (read lazily; never re-registers). */
  getCallbacks: () => BrowserExecutorCallbacks;
  /** Notifies the pane so it can highlight while the agent is acting. */
  onActiveChange?: (active: boolean) => void;
  onPopOut?: () => void;
  canPopOut?: boolean;
  /** When rendered inside the pop-out window: dock the browser back into the panel. */
  onDock?: () => void;
}

// How long the "controlling" state lingers after the last agent command.
const ACTIVE_LINGER_MS = 2500;

/**
 * Toolbar cluster for agent browser control. Owns the controller registration
 * (via useBrowserController) so activity re-renders stay isolated to this small
 * component. Renders: a live status pill (idle "shared" vs pulsing "controlling"),
 * a hand-off/stop toggle, and an optional pop-out button.
 */
export const BrowserAgentControlBar: React.FC<BrowserAgentControlBarProps> = ({
  backend,
  controllerId,
  directory,
  url,
  title,
  getCallbacks,
  onActiveChange,
  onPopOut,
  canPopOut,
  onDock,
}) => {
  const { t } = useI18n();
  // Persisted per-directory: stopping agent control sticks across close/reopen.
  const shared = useBrowserSharingStore((state) => !state.stopped[directory]);
  const setSharedPref = useBrowserSharingStore((state) => state.setShared);
  const [active, setActive] = React.useState(false);
  const [lastOp, setLastOp] = React.useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActiveChangeRef = React.useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const handleCommand = React.useCallback((primitive: string) => {
    setLastOp(primitive);
    setActive(true);
    onActiveChangeRef.current?.(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(false);
      onActiveChangeRef.current?.(false);
    }, ACTIVE_LINGER_MS);
  }, []);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Stopping the hand-off immediately clears the "controlling" highlight.
  React.useEffect(() => {
    if (!shared && active) {
      setActive(false);
      onActiveChangeRef.current?.(false);
    }
  }, [shared, active]);

  useBrowserController({
    enabled: shared,
    backend,
    controllerId,
    url,
    title,
    getCallbacks,
    onCommand: handleCommand,
  });

  const toggleLabel = shared ? t('contextPanel.browser.agent.stop') : t('contextPanel.browser.agent.handOff');

  return (
    <div className="flex items-center gap-1">
      {shared ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex select-none items-center gap-1 rounded-full px-1.5 py-0.5 typography-micro',
                active ? 'bg-[var(--status-info-background)] text-[var(--status-info)]' : 'text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  active ? 'animate-pulse bg-[var(--status-info)]' : 'bg-muted-foreground/50',
                )}
              />
              {active ? t('contextPanel.browser.agent.controlling') : t('contextPanel.browser.agent.ready')}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>
            {lastOp ? t('contextPanel.browser.agent.lastAction', { op: lastOp }) : t('contextPanel.browser.agent.ready')}
          </TooltipContent>
        </Tooltip>
      ) : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setSharedPref(directory, !shared)}
            aria-label={toggleLabel}
          >
            <Icon name={shared ? 'stop-circle' : 'robot-2'} className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{toggleLabel}</TooltipContent>
      </Tooltip>

      {onDock ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onDock}
              aria-label={t('contextPanel.browser.poppedOut.bringBack')}
            >
              <Icon name="corner-down-left" className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('contextPanel.browser.poppedOut.bringBack')}</TooltipContent>
        </Tooltip>
      ) : canPopOut && onPopOut ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onPopOut}
              aria-label={t('contextPanel.browser.agent.popOut')}
            >
              <Icon name="picture-in-picture-2" className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('contextPanel.browser.agent.popOut')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
};
