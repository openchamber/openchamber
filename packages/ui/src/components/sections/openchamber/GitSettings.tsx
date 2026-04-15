import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { m } from '@/lib/i18n/messages';

export const GitSettings: React.FC = () => {
  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const setSettingsGitmojiEnabled = useConfigStore((state) => state.setSettingsGitmojiEnabled);
  const showGitignored = useFilesViewShowGitignored();
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const setGitChangesViewMode = useUIStore((state) => state.setGitChangesViewMode);

  const [isLoading, setIsLoading] = React.useState(true);

  type GitSettingsPayload = {
    gitmojiEnabled?: boolean;
    gitChangesViewMode?: 'flat' | 'tree';
  };

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: GitSettingsPayload | null = null;

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
                  gitChangesViewMode:
                    (settings as Record<string, unknown>).gitChangesViewMode === 'flat'
                    || (settings as Record<string, unknown>).gitChangesViewMode === 'tree'
                      ? ((settings as Record<string, unknown>).gitChangesViewMode as 'flat' | 'tree')
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
          if (data.gitChangesViewMode === 'flat' || data.gitChangesViewMode === 'tree') {
            setGitChangesViewMode(data.gitChangesViewMode);
          }
        }

      } catch (error) {
        console.warn(m.gitFailedLoadSettings(), error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setGitChangesViewMode, setSettingsGitmojiEnabled]);

  const handleGitmojiChange = React.useCallback(async (enabled: boolean) => {
    setSettingsGitmojiEnabled(enabled);
    try {
      await updateDesktopSettings({
        gitmojiEnabled: enabled,
      });
    } catch (error) {
      console.warn(m.gitFailedSaveGitmoji(), error);
    }
  }, [setSettingsGitmojiEnabled]);

  const handleGitChangesViewModeChange = React.useCallback((mode: 'flat' | 'tree') => {
    if (mode === gitChangesViewMode) {
      return;
    }

    setGitChangesViewMode(mode);
    void updateDesktopSettings({ gitChangesViewMode: mode });
  }, [gitChangesViewMode, setGitChangesViewMode]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{m.gitPreferencesTitle()}</h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div className="pt-1 pb-1">
          <h4 className="typography-ui-header font-medium text-foreground">{m.gitChangesView()}</h4>
          <div role="radiogroup" aria-label={m.gitChangesViewMode()} className="mt-0.5 space-y-0">
            {[
              { id: 'flat' as const, label: m.gitChangesFlatList() },
              { id: 'tree' as const, label: m.gitChangesTreeView() },
            ].map((option) => {
              const selected = gitChangesViewMode === option.id;
              return (
                <div
                  key={option.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => { handleGitChangesViewModeChange(option.id); }}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === m.commonKeyEnter()) {
                      event.preventDefault();
                      handleGitChangesViewModeChange(option.id);
                    }
                  }}
                  className="flex w-full items-center gap-2 py-0 text-left"
                >
                  <Radio
                    checked={selected}
                    onChange={() => { handleGitChangesViewModeChange(option.id); }}
                    ariaLabel={`Git changes view mode: ${option.label}`}
                  />
                  <span className={selected ? 'typography-ui-label font-normal text-foreground' : 'typography-ui-label font-normal text-foreground/50'}>
                    {option.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={settingsGitmojiEnabled}
          onClick={() => {
            void handleGitmojiChange(!settingsGitmojiEnabled);
          }}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === m.commonKeyEnter()) {
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
            ariaLabel={m.gitEnableGitmojiAria()}
          />
          <span className="typography-ui-label text-foreground">{m.gitEnableGitmoji()}</span>
        </div>

        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={showGitignored}
          onClick={() => setFilesViewShowGitignored(!showGitignored)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === m.commonKeyEnter()) {
              event.preventDefault();
              setFilesViewShowGitignored(!showGitignored);
            }
          }}
        >
          <Checkbox
            checked={showGitignored}
            onChange={setFilesViewShowGitignored}
            ariaLabel={m.gitDisplayGitignoredAria()}
          />
          <span className="typography-ui-label text-foreground">{m.gitDisplayGitignored()}</span>
        </div>
      </section>
    </div>
  );
};
