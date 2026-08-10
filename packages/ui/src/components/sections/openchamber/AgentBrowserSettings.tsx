import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

type BrowserStatus = {
  supported?: boolean;
  executable?: string | null;
  source?: string;
  configuredPath?: string | null;
  noSandbox?: boolean;
  platform?: string;
  arch?: string;
  installPlatform?: string | null;
  installSupported?: boolean;
  recommendedNoSandbox?: boolean;
  missingPreferred?: boolean;
  running?: boolean;
};

export const AgentBrowserSettings: React.FC = () => {
  const { t } = useI18n();
  const [pathValue, setPathValue] = React.useState('');
  const [noSandbox, setNoSandbox] = React.useState(false);
  const [status, setStatus] = React.useState<BrowserStatus | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refreshStatus = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/api/browser/status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return;
      }
      const data = (await response.json().catch(() => null)) as BrowserStatus | null;
      if (data) {
        setStatus(data);
      }
    } catch {
      // ignore probe failures — settings fields still work
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const data = (await response.json().catch(() => null)) as null | {
            browserExecutablePath?: unknown;
            browserNoSandbox?: unknown;
          };
          if (!cancelled && data) {
            setPathValue(typeof data.browserExecutablePath === 'string' ? data.browserExecutablePath.trim() : '');
            setNoSandbox(data.browserNoSandbox === true);
          }
        }
        if (!cancelled) {
          await refreshStatus();
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  const handleBrowse = React.useCallback(async () => {
    if (!isDesktopShell()) return;
    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setPathValue(selected.path.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSave = React.useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const trimmed = pathValue.trim();
      const unquoted = trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
          || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
      await updateDesktopSettings({
        browserExecutablePath: unquoted,
        browserNoSandbox: noSandbox,
      });
      await runtimeFetch('/api/browser/reload', { method: 'POST' });
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [noSandbox, pathValue, refreshStatus]);

  const handleInstall = React.useCallback(async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const response = await runtimeFetch('/api/browser/install', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const data = (await response.json().catch(() => null)) as null | {
        error?: string;
        executable?: string;
        noSandbox?: boolean;
      };
      if (!response.ok) {
        throw new Error(data?.error || `Install failed (${response.status})`);
      }
      if (typeof data?.executable === 'string') {
        setPathValue(data.executable);
      }
      if (data?.noSandbox === true) {
        setNoSandbox(true);
      }
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstalling(false);
    }
  }, [refreshStatus]);

  const handleNoSandboxChange = React.useCallback((enabled: boolean) => {
    setNoSandbox(enabled);
    void updateDesktopSettings({ browserNoSandbox: enabled }).then(async () => {
      await runtimeFetch('/api/browser/reload', { method: 'POST' });
      await refreshStatus();
    });
  }, [refreshStatus]);

  const statusLabel = (() => {
    if (isLoading) return t('settings.openchamber.agentBrowser.status.loading');
    if (!status) return t('settings.openchamber.agentBrowser.status.unknown');
    if (status.supported && status.executable) {
      return t('settings.openchamber.agentBrowser.status.ready', { path: status.executable });
    }
    if (status.missingPreferred) {
      return t('settings.openchamber.agentBrowser.status.missingPath');
    }
    return t('settings.openchamber.agentBrowser.status.missing');
  })();

  return (
    <SettingsSection title={t('settings.openchamber.agentBrowser.title')}>
      <div className="space-y-0.5">
        <p className={SETTINGS_HELPER_CLASS} data-settings-item="general.agent-browser-status">
          {statusLabel}
          {status?.platform && status?.arch ? (
            <span className="block opacity-80">
              {t('settings.openchamber.agentBrowser.status.host', {
                platform: status.platform,
                arch: status.arch,
              })}
            </span>
          ) : null}
        </p>

        <SettingsFieldRow
          settingsItem="general.agent-browser-path"
          label={t('settings.openchamber.agentBrowser.field.binaryPath')}
          info={t('settings.openchamber.agentBrowser.field.binaryPathInfo')}
        >
          <div className="flex max-w-[24rem] items-center gap-2">
            <Input
              value={pathValue}
              onChange={(event) => setPathValue(event.target.value)}
              placeholder={t('settings.openchamber.agentBrowser.field.binaryPathPlaceholder')}
              className="h-8 rounded-md px-3"
              disabled={isLoading || isSaving || isInstalling}
              aria-label={t('settings.openchamber.agentBrowser.field.binaryPath')}
            />
            {isDesktopShell() ? (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className={SETTINGS_ICON_BUTTON_CLASS}
                onClick={() => void handleBrowse()}
                disabled={isLoading || isSaving || isInstalling}
                aria-label={t('settings.openchamber.agentBrowser.actions.browseAria')}
              >
                <Icon name="folder-open" className="size-4" />
              </Button>
            ) : null}
          </div>
        </SettingsFieldRow>

        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="general.agent-browser-no-sandbox"
            checked={noSandbox}
            onChange={handleNoSandboxChange}
            label={t('settings.openchamber.agentBrowser.field.noSandbox')}
            ariaLabel={t('settings.openchamber.agentBrowser.field.noSandboxAria')}
            info={t('settings.openchamber.agentBrowser.field.noSandboxInfo')}
            description={
              status?.recommendedNoSandbox && !noSandbox
                ? t('settings.openchamber.agentBrowser.field.noSandboxRecommended')
                : undefined
            }
          />
        </div>

        <SettingsInset>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleSave()}
              disabled={isLoading || isSaving || isInstalling}
            >
              {isSaving
                ? t('settings.openchamber.agentBrowser.actions.saving')
                : t('settings.openchamber.agentBrowser.actions.save')}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void handleInstall()}
              disabled={isLoading || isSaving || isInstalling || status?.installSupported === false}
              title={
                status?.installSupported === false
                  ? t('settings.openchamber.agentBrowser.actions.installUnsupported')
                  : undefined
              }
            >
              {isInstalling ? (
                <>
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  <span>{t('settings.openchamber.agentBrowser.actions.installing')}</span>
                </>
              ) : (
                <>
                  <Icon name="download" className="size-4" />
                  <span>{t('settings.openchamber.agentBrowser.actions.install')}</span>
                </>
              )}
            </Button>
          </div>
          {error ? (
            <p className="typography-meta text-[var(--status-error)]">{error}</p>
          ) : null}
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
