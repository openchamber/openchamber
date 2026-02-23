import React from 'react';
import { RiInformationLine, RiRestartLine } from '@remixicon/react';
import { NumberInput } from '@/components/ui/number-input';
import { ButtonSmall } from '@/components/ui/button-small';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { DEFAULT_MESSAGE_LIMIT } from '@/stores/types/sessionTypes';

const MIN_LIMIT = 10;
const MAX_LIMIT = 500;

export const MemoryLimitsSettings: React.FC = () => {
  const messageLimit = useUIStore((state) => state.messageLimit);
  const setMessageLimit = useUIStore((state) => state.setMessageLimit);

  const [isLoading, setIsLoading] = React.useState(true);

  // Load settings from server on mount
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: { messageLimit?: number } | null = null;

        // 1. Runtime settings API (VSCode)
        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings as Record<string, unknown> | undefined;
              if (settings) {
                data = {
                  messageLimit: typeof settings.messageLimit === 'number' ? settings.messageLimit : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        // 2. Fetch API (Web/server)
        if (!data) {
          const response = await fetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data && typeof data.messageLimit === 'number') {
          setMessageLimit(data.messageLimit);
        }
      } catch (error) {
        console.warn('Failed to load memory limits settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setMessageLimit]);

  const handleChange = React.useCallback((value: number) => {
    setMessageLimit(value);
    void updateDesktopSettings({ messageLimit: value }).catch((error: unknown) => {
      console.warn('Failed to save messageLimit:', error);
    });
  }, [setMessageLimit]);

  if (isLoading) {
    return null;
  }

  const isDefault = messageLimit === DEFAULT_MESSAGE_LIMIT;

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">Message Memory</h3>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              Limit how many messages are loaded per session in memory.<br />
              Older messages are available via "Load more". Background sessions are trimmed automatically.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0">
        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Message Limit</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <NumberInput
              value={messageLimit}
              onValueChange={handleChange}
              min={MIN_LIMIT}
              max={MAX_LIMIT}
              step={10}
              aria-label="Message limit"
              className="w-20 tabular-nums"
            />
            <ButtonSmall
              type="button"
              variant="ghost"
              onClick={() => handleChange(DEFAULT_MESSAGE_LIMIT)}
              disabled={isDefault}
              className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
              aria-label="Reset message limit"
              title="Reset"
            >
              <RiRestartLine className="h-3.5 w-3.5" />
            </ButtonSmall>
          </div>
        </div>
      </section>
    </div>
  );
};
