import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';

export const GitSettings: React.FC = () => {
  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const setSettingsGitmojiEnabled = useConfigStore((state) => state.setSettingsGitmojiEnabled);
  const showGitignored = useFilesViewShowGitignored();

  const [isLoading, setIsLoading] = React.useState(true);

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: { gitmojiEnabled?: boolean } | null = null;

        // 1. Runtime settings API (VSCode)
        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  gitmojiEnabled: typeof (settings as Record<string, unknown>).gitmojiEnabled === 'boolean'
                    ? ((settings as Record<string, unknown>).gitmojiEnabled as boolean)
                    : undefined,
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

        if (data) {
          if (typeof data.gitmojiEnabled === 'boolean') {
            setSettingsGitmojiEnabled(data.gitmojiEnabled);
          }
        }

      } catch (error) {
        console.warn('Failed to load git settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setSettingsGitmojiEnabled]);

  const handleGitmojiChange = React.useCallback(async (enabled: boolean) => {
    setSettingsGitmojiEnabled(enabled);
    try {
      await updateDesktopSettings({
        gitmojiEnabled: enabled,
      });
    } catch (error) {
      console.warn('Failed to save gitmoji setting:', error);
    }
  }, [setSettingsGitmojiEnabled]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">Git Preferences</h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={settingsGitmojiEnabled}
          onClick={() => {
            void handleGitmojiChange(!settingsGitmojiEnabled);
          }}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              void handleGitmojiChange(!settingsGitmojiEnabled);
            }
          }}
        >
          <Checkbox
            checked={settingsGitmojiEnabled}
            onChange={(checked) => {
              void handleGitmojiChange(checked);
            }}
            ariaLabel="Enable Gitmoji picker"
          />
          <span className="typography-ui-label text-foreground">Enable Gitmoji Picker</span>
        </div>

        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={showGitignored}
          onClick={() => setFilesViewShowGitignored(!showGitignored)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              setFilesViewShowGitignored(!showGitignored);
            }
          }}
        >
          <Checkbox
            checked={showGitignored}
            onChange={setFilesViewShowGitignored}
            ariaLabel="Display gitignored files"
          />
          <span className="typography-ui-label text-foreground">Display Gitignored Files</span>
        </div>
      </section>
    </div>
  );
};
