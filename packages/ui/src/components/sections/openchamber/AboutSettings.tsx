import React from 'react';
import { checkConnectedServerForUpdates, useUpdateStore } from '@/stores/useUpdateStore';
import type { UpdateInfo } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useShallow } from 'zustand/react/shallow';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { AboutLogo } from '@/components/ui/AboutLogo';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from '@/components/ui/spinner';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { getDesktopUpdateChannel, setDesktopUpdateChannel } from '@/lib/desktop';
import { formatCanaryBuildDate, parseCanaryVersion, type UpdateChannel } from '@/lib/updateChannel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { copyTextToClipboard } from '@/lib/clipboard';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { fetchOpenCodeUpgradeStatus, runOpenCodeUpgrade, type OpenCodeUpgradeStatus } from '@/components/update/openCodeUpgrade';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import {
  SettingsChipGroup,
  SettingsSection,
  SettingsFieldRow,
  SETTINGS_BRAND_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/openchamber/openchamber';
const DISCORD_URL = 'https://discord.gg/ZYRSdnwwKA';
const X_URL = 'https://x.com/openchamber_dev';

const MIN_CHECKING_DURATION = 800; // ms

/**
 * The channel a server installed from npm follows, the way its update check
 * reads it: the stored pick, else Canary for a Canary build installed from
 * the terminal. Null when the settings could not be read.
 */
const loadServerUpdateChannel = async (serverVersion: string): Promise<UpdateChannel | null> => {
  const settings = await loadDesktopSettings();
  if (!settings) return null;
  return settings.serverUpdateChannel ?? (parseCanaryVersion(serverVersion) ? 'canary' : 'stable');
};

type ConnectedServerUpdate = {
  info: UpdateInfo | null;
  checking: boolean;
  available: boolean;
  error: string | null;
};

const IDLE_SERVER_UPDATE: ConnectedServerUpdate = { info: null, checking: false, available: false, error: null };

/**
 * The server this window is connected to, when that is not the app itself:
 * the native app's server, or a desktop app's remote host. The shared update
 * store checks the app build, so the server check lives here, in page-local
 * state, and installs through the server's own update route (the dialog's
 * `web` flow).
 */
function useConnectedServerUpdate(enabled: boolean) {
  const [state, setState] = React.useState<ConnectedServerUpdate>(IDLE_SERVER_UPDATE);

  const check = React.useCallback(async () => {
    if (!enabled) return;
    setState((current) => ({ ...current, checking: true, error: null }));
    try {
      const info = await checkConnectedServerForUpdates();
      setState({ info, checking: false, available: info.available, error: null });
    } catch (error) {
      setState({
        info: null,
        checking: false,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled]);

  return { ...state, check };
}

type OpenCodeUpgradePhase =
  | { kind: 'idle' }
  | { kind: 'upgrading' }
  | { kind: 'installed'; version: string | null }
  | { kind: 'failed'; error: string };

/**
 * OpenCode on the connected server, checked and upgraded through the same
 * routes as the OpenCode update toast. Separate from the OpenChamber update:
 * it replaces the OpenCode CLI, not OpenChamber.
 */
function useOpenCodeUpgrade(failedFallback: string) {
  const [status, setStatus] = React.useState<OpenCodeUpgradeStatus | null>(null);
  const [phase, setPhase] = React.useState<OpenCodeUpgradePhase>({ kind: 'idle' });

  const refresh = React.useCallback(async (): Promise<OpenCodeUpgradeStatus | null> => {
    try {
      const next = await fetchOpenCodeUpgradeStatus();
      setStatus(next);
      return next;
    } catch {
      // Best effort: About still shows the OpenChamber half. The stale status
      // stays rather than turning into "no update".
      return null;
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const upgrade = React.useCallback(async () => {
    setPhase({ kind: 'upgrading' });
    try {
      const version = await runOpenCodeUpgrade(failedFallback);
      setPhase({ kind: 'installed', version });
    } catch (error) {
      setPhase({ kind: 'failed', error: error instanceof Error ? error.message : failedFallback });
    }
  }, [failedFallback]);

  /**
   * Restarts OpenCode after an upgrade, then re-reads the running version.
   * The "installed, reload to use it" phase is a temporary stand-in: once the
   * server reports the installed version as running, the authoritative status
   * replaces it.
   */
  const reloadAfterUpgrade = React.useCallback(async (reload: () => Promise<void>) => {
    await reload().catch(() => undefined);
    const next = await refresh();
    if (!next?.currentVersion) return;
    setPhase((current) => {
      if (current.kind !== 'installed') return current;
      if (current.version && current.version.replace(/^v/, '') !== next.currentVersion) return current;
      return { kind: 'idle' };
    });
  }, [refresh]);

  return { status, phase, refresh, upgrade, reloadAfterUpgrade };
}

/** Version of the installed native app build (Capacitor only). */
function useNativeAppVersion(enabled: boolean): string | null {
  const [version, setVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void import('@capacitor/app')
      .then(({ App }) => App.getInfo())
      .then((info) => {
        if (!cancelled) setVersion(info.version.trim() || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return version;
}

type AboutSettingsProps = {
  initialUpdateDialogOpen?: boolean;
};

export const AboutSettings: React.FC<AboutSettingsProps> = ({ initialUpdateDialogOpen = false }) => {
  const { t } = useI18n();
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(initialUpdateDialogOpen);
  const [showChecking, setShowChecking] = React.useState(false);
  const [openChamberVersion, setOpenChamberVersion] = React.useState<string | null>(null);
  const updateStore = useUpdateStore(useShallow((s) => ({
    info: s.info,
    checking: s.checking,
    available: s.available,
    error: s.error,
    downloading: s.downloading,
    downloaded: s.downloaded,
    installing: s.installing,
    progress: s.progress,
    runtimeType: s.runtimeType,
    checkForUpdates: s.checkForUpdates,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));
  const { isMobile } = useDeviceInfo();
  // Native app: updates target the connected server; the app itself updates
  // through its store, which is not actionable from here.
  const isNativeApp = React.useMemo(() => isCapacitorApp(), []);
  const isDesktopRemote = useDesktopRemoteHostActive();
  const serverUpdate = useConnectedServerUpdate(isNativeApp || isDesktopRemote);
  // A desktop app on a remote host updates itself and its server separately.
  const remoteHostUpdate = isDesktopRemote ? serverUpdate : null;
  const checkRemoteHost = serverUpdate.check;
  React.useEffect(() => {
    if (isDesktopRemote) void checkRemoteHost();
  }, [isDesktopRemote, checkRemoteHost]);
  const [serverUpdateDialogOpen, setServerUpdateDialogOpen] = React.useState(false);
  const [desktopAppVersion, setDesktopAppVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!isDesktopRemote) return;
    let cancelled = false;
    void getDesktopAppVersion().then((version) => {
      if (!cancelled) setDesktopAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopRemote]);
  const nativeAppVersion = useNativeAppVersion(isNativeApp);
  const update = isNativeApp
    ? {
      info: serverUpdate.info,
      checking: serverUpdate.checking,
      available: serverUpdate.available,
      error: serverUpdate.error,
      checkForUpdates: serverUpdate.check,
      runtimeType: 'web' as const,
    }
    : {
      info: updateStore.info,
      checking: updateStore.checking,
      available: updateStore.available,
      error: updateStore.error,
      checkForUpdates: updateStore.checkForUpdates,
      runtimeType: updateStore.runtimeType,
    };

  // A Canary build reads as the release it leads to and the day it was made:
  // "2.5.4 Canary · 30 Oct" for 2.5.4-canary.20261030.123.
  const describeVersion = (version: string) => {
    const canary = parseCanaryVersion(version);
    return canary
      ? t('settings.openchamber.about.canaryVersion', {
        version: canary.release,
        date: formatCanaryBuildDate(canary.builtOn, getCurrentIntlLocale()),
      })
      : version;
  };
  const currentVersion = describeVersion(openChamberVersion || update.info?.currentVersion || 'unknown');
  const appVersion = describeVersion(desktopAppVersion || updateStore.info?.currentVersion || 'unknown');
  const remoteHostVersion = openChamberVersion || remoteHostUpdate?.info?.currentVersion || 'unknown';

  // The update channel of the desktop app, or of the server installed from npm
  // that this browser page belongs to (a browser on a desktop app's server
  // gets the app's updates, which this page does not switch). Picking Canary
  // checks at once, so the update to the Canary build shows up where every
  // update does.
  const isDesktopApp = updateStore.runtimeType === 'desktop';
  const [isWebServer, setIsWebServer] = React.useState(false);
  const isNpmServer = updateStore.runtimeType === 'web' && isWebServer && openChamberVersion !== null;
  const [updateChannel, setUpdateChannel] = React.useState<UpdateChannel | null>(null);
  React.useEffect(() => {
    if (!isDesktopApp && !isNpmServer) return;
    let cancelled = false;
    const load = isDesktopApp ? getDesktopUpdateChannel() : loadServerUpdateChannel(openChamberVersion ?? '');
    void load.then((channel) => {
      if (!cancelled) setUpdateChannel(channel);
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopApp, isNpmServer, openChamberVersion]);
  const openCode = useOpenCodeUpgrade(t('opencodeUpdate.toast.failed.description'));
  const openCodeVersion = openCode.status?.currentVersion ?? null;
  const openCodeUpdateVersion = openCode.phase.kind === 'installed' ? null : openCode.status?.availableVersion ?? null;
  const [commandCopied, setCommandCopied] = React.useState(false);

  // The OpenChamber button names what it replaces. In the native app that is
  // the server the phone is connected to (or the desktop app serving it),
  // never the phone app itself, which updates through its store.
  const serverUpdateLabel = (info: UpdateInfo | null) => {
    const version = describeVersion(info?.version || '');
    return info?.packageManager === 'electron'
      ? t('settings.openchamber.about.actions.updateDesktopToVersion', { version })
      : t('settings.openchamber.about.actions.updateServerToVersion', { version });
  };
  const openChamberUpdateLabel = (() => {
    const version = describeVersion(update.info?.version || '');
    if (isNativeApp) return serverUpdateLabel(update.info);
    return isDesktopRemote
      ? t('settings.openchamber.about.actions.updateAppToVersion', { version })
      : t('settings.openchamber.about.actions.updateOpenChamberToVersion', { version });
  })();
  const isInstallBlocked = (info: UpdateInfo | null) => Boolean(info?.installBlocked);
  const installBlocked = update.available && isInstallBlocked(update.info);
  const remoteHostInstallBlocked = Boolean(remoteHostUpdate?.available && isInstallBlocked(remoteHostUpdate.info));

  const chooseUpdateChannel = async (channel: UpdateChannel) => {
    if (channel === updateChannel) return;
    const previous = updateChannel;
    setUpdateChannel(channel);
    const stored = isDesktopApp
      ? await setDesktopUpdateChannel(channel) === channel
      : (await updateDesktopSettings({ serverUpdateChannel: channel })).ok;
    if (!stored) {
      setUpdateChannel(previous);
      toast.error(t('settings.openchamber.about.toast.updateChannelNotSaved'));
      return;
    }
    void update.checkForUpdates();
  };
  // The chosen Canary wears the colours of its icon: the violet tile and the yellow bird.
  const CANARY_COLOURS = 'bg-[var(--brand-canary)] text-[var(--brand-canary-foreground)] hover:bg-[var(--brand-canary)] hover:text-[var(--brand-canary-foreground)]';
  const updateChannelControl = updateChannel && (
    <SettingsChipGroup
      value={updateChannel}
      onChange={(channel) => void chooseUpdateChannel(channel)}
      aria-label={t('settings.openchamber.about.field.updateChannel')}
      className="flex-nowrap"
      options={[
        { value: 'stable', label: t('settings.openchamber.about.option.updateChannel.stable') },
        {
          value: 'canary',
          label: t('settings.openchamber.about.option.updateChannel.canary'),
          selectedClassName: CANARY_COLOURS,
        },
      ]}
    />
  );

  const checkAll = () => {
    void update.checkForUpdates();
    if (remoteHostUpdate) void remoteHostUpdate.check();
    void openCode.refresh();
  };

  const copyManualCommand = async (command: string) => {
    const result = await copyTextToClipboard(command);
    if (!result.ok) return;
    setCommandCopied(true);
    setTimeout(() => setCommandCopied(false), 2000);
  };

  const reloadOpenCode = () => {
    void openCode.reloadAfterUpgrade(async () => {
      await reloadOpenCodeConfiguration({
        message: t('opencodeUpdate.toast.reload.message'),
        mode: 'projects',
        scopes: ['all'],
      });
    });
  };

  const renderManualUpdateNotice = (info: UpdateInfo | null) => {
    if (info?.installBlocked === 'desktop-host') {
      return (
        <p className="typography-meta text-muted-foreground">
          {t('updateDialog.desktopHostInstall', { version: info.version || '' })}
        </p>
      );
    }
    // No command updates a copy that no package manager installed.
    if (info?.installBlocked === 'manual-install') {
      return (
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.about.manualInstallUpdate', { version: describeVersion(info.version || '') })}
        </p>
      );
    }
    const command = info?.updateCommand || 'openchamber update';
    return (
      <div className="space-y-2">
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.about.serviceManagerUpdate', { version: describeVersion(info?.version || '') })}
        </p>
        <div className="flex items-center gap-2 oc-tile-inset rounded-md p-1 ps-3">
          <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">{command}</code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void copyManualCommand(command)}
            aria-label={commandCopied ? t('updateDialog.actions.copied') : t('updateDialog.actions.copyCommand')}
          >
            <Icon name={commandCopied ? 'check' : 'clipboard'} className="size-4" />
          </Button>
        </div>
      </div>
    );
  };
  const manualUpdateNotice = installBlocked ? renderManualUpdateNotice(update.info) : null;

  const remoteHostUpdateControls = (() => {
    if (!remoteHostUpdate?.available || remoteHostUpdate.checking) return null;
    if (remoteHostInstallBlocked) return renderManualUpdateNotice(remoteHostUpdate.info);
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setServerUpdateDialogOpen(true)}>
        <Icon name="download" className="size-4" />
        {serverUpdateLabel(remoteHostUpdate.info)}
      </Button>
    );
  })();
  const remoteHostUpdateDialog = remoteHostUpdate ? (
    <UpdateDialog
      open={serverUpdateDialogOpen}
      onOpenChange={setServerUpdateDialogOpen}
      info={remoteHostUpdate.info}
      downloading={false}
      downloaded={false}
      progress={null}
      error={remoteHostUpdate.error}
      onDownload={() => {}}
      onRestart={() => {}}
      runtimeType="web"
    />
  ) : null;

  // The OpenCode update as a button and a line of text, so the desktop layout
  // can put the button in the OpenCode row and the text under the rows.
  const openCodeUpdate = (() => {
    const { phase } = openCode;
    if (phase.kind === 'installed') {
      return {
        action: (
          <Button type="button" size="sm" variant="outline" onClick={reloadOpenCode}>
            {t('opencodeUpdate.toast.actions.reload')}
          </Button>
        ),
        note: (
          <p className="typography-meta text-muted-foreground">
            {phase.version
              ? t('settings.openchamber.about.openCode.installedVersion', { version: phase.version })
              : t('settings.openchamber.about.openCode.installed')}
          </p>
        ),
      };
    }
    if (!openCodeUpdateVersion) return null;
    if (!openCode.status?.supported) {
      return {
        action: null,
        note: (
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.about.openCode.manualUpdate', { version: openCodeUpdateVersion })}
          </p>
        ),
      };
    }
    const upgrading = phase.kind === 'upgrading';
    return {
      action: (
        <Button type="button" size="sm" variant="outline" onClick={() => void openCode.upgrade()} disabled={upgrading}>
          {upgrading ? <Spinner className="size-4" /> : <Icon name="download" className="size-4" />}
          {upgrading
            ? t('opencodeUpdate.toast.upgrading.title')
            : t('settings.openchamber.about.actions.updateOpenCodeToVersion', { version: openCodeUpdateVersion })}
        </Button>
      ),
      note: phase.kind === 'failed'
        ? <p className="typography-meta text-[var(--status-error)]">{phase.error}</p>
        : null,
    };
  })();
  const openCodeUpdateControls = openCodeUpdate ? (
    <div className="flex flex-col items-center gap-2">
      {openCodeUpdate.note}
      {openCodeUpdate.action}
    </div>
  ) : null;

  React.useEffect(() => {
    let cancelled = false;

    const loadOpenChamberVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { openchamberVersion?: unknown; runtime?: unknown } | null;
        const version = typeof data?.openchamberVersion === 'string' && data.openchamberVersion.trim().length > 0
          ? data.openchamberVersion.trim()
          : null;
        if (!cancelled) {
          setOpenChamberVersion(version);
          setIsWebServer(data?.runtime === 'web');
        }
      } catch {
        if (!cancelled) setOpenChamberVersion(null);
      }
    };

    void loadOpenChamberVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  const remoteHostUpdateChecking = remoteHostUpdate?.checking ?? false;
  const remoteHostUpdateAvailable = remoteHostUpdate?.available ?? false;

  // Track if we initiated a check to show toast on completion
  const didInitiateCheck = React.useRef(false);

  // Ensure minimum visible duration for checking animation
  React.useEffect(() => {
    if (update.checking) {
      setShowChecking(true);
      didInitiateCheck.current = true;
    } else if (showChecking) {
      const timer = setTimeout(() => {
        setShowChecking(false);
        // Show toast if check completed with no update available. On a remote
        // host "latest" would be wrong while the server still has an update.
        const remoteHostPending = remoteHostUpdateChecking || remoteHostUpdateAvailable;
        if (didInitiateCheck.current && !update.available && !update.error && !remoteHostPending) {
          toast.success(isNativeApp
            ? t('settings.openchamber.about.toast.serverLatestVersion')
            : t('settings.openchamber.about.toast.latestVersion'));
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [t, isNativeApp, update.checking, showChecking, update.available, update.error, remoteHostUpdateChecking, remoteHostUpdateAvailable]);

  const isChecking = update.checking || showChecking;

  if (isMobile) {
    return (
      <div className="w-full space-y-6 pb-2">
        <div className="flex flex-col items-center text-center">
          <AboutLogo size={72} />
          <h2 className={`mt-4 ${SETTINGS_BRAND_TITLE_CLASS}`}>OpenChamber</h2>
          <div className="mt-2 space-y-1 typography-ui text-muted-foreground">
            {isNativeApp ? (
              <>
                <p>{t('settings.openchamber.about.native.serverOpenChamberVersion', { version: currentVersion })}</p>
                <p>{t('settings.openchamber.about.native.serverOpenCodeVersion', { version: openCodeVersion || t('settings.openchamber.about.state.unknown') })}</p>
                {nativeAppVersion && <p>{t('settings.openchamber.about.native.appVersion', { version: nativeAppVersion })}</p>}
              </>
            ) : isDesktopRemote ? (
              <>
                <p>{t('aboutDialog.appVersionLabel', { version: appVersion })}</p>
                <p>{t('settings.openchamber.about.native.serverOpenChamberVersion', { version: remoteHostVersion })}</p>
                <p>{t('settings.openchamber.about.native.serverOpenCodeVersion', { version: openCodeVersion || t('settings.openchamber.about.state.unknown') })}</p>
              </>
            ) : (
              <>
                <p>{t('aboutDialog.openChamberVersionLabel', { version: currentVersion })}</p>
                <p>{t('aboutDialog.openCodeVersionLabel', { version: openCodeVersion || t('settings.openchamber.about.state.unknown') })}</p>
              </>
            )}
          </div>
          <InstanceServiceUrls />
        </div>

        {updateChannelControl && <div className="flex justify-center">{updateChannelControl}</div>}

        <div className="flex justify-center">
          {!update.available && !update.error && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={checkAll}
              disabled={isChecking}
              className="w-auto justify-center gap-2"
            >
              {isChecking ? <Icon name="loader" className="size-4 animate-spin" /> : <Icon name="refresh" className="size-4" />}
              {isChecking
                ? t('settings.openchamber.about.state.checking')
                : isNativeApp
                  ? t('settings.openchamber.about.actions.checkServerForUpdates')
                  : t('settings.openchamber.about.actions.checkForUpdates')}
            </Button>
          )}

          {!isChecking && update.available && !installBlocked && (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => setUpdateDialogOpen(true)}
              className="w-auto justify-center gap-2"
            >
              <Icon name="download" className="size-4" />
              {openChamberUpdateLabel}
            </Button>
          )}
        </div>

        {manualUpdateNotice}

        {remoteHostUpdateControls && (
          <div className="flex justify-center text-center">{remoteHostUpdateControls}</div>
        )}

        {openCodeUpdateControls && (
          <div className="flex justify-center text-center">{openCodeUpdateControls}</div>
        )}

        {[update.error, remoteHostUpdate?.error].filter(Boolean).map((error) => (
          <p key={error} className="rounded-xl bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {error}
          </p>
        ))}

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center gap-5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="github-fill" className="size-5" />
              <span>GitHub</span>
            </a>

            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="discord-fill" className="size-5" />
              <span>Discord</span>
            </a>
          </div>

          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="twitter-xfill" className="size-5" />
            <span>@openchamber_dev</span>
          </a>
        </div>

        <p className="text-center typography-ui text-muted-foreground">
          {t('aboutDialog.footerNote')}
        </p>

        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={update.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          installing={updateStore.installing}
          progress={updateStore.progress}
          error={update.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate}
          runtimeType={update.runtimeType}
        />
        {remoteHostUpdateDialog}
      </div>
    );
  }

  // Desktop layout: the brand with its links, then one run of field rows, each
  // version with its own update action on the right.
  // The check button is always there and stays put while checking (it also
  // re-checks a remote host's server); the outcome reads before it.
  const openChamberStatus = (
    <>
      {isChecking ? (
        <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
          <Icon name="loader" className="size-4 animate-spin" />
          {t('settings.openchamber.about.state.checking')}
        </span>
      ) : update.available && !installBlocked ? (
        <Button size="sm" variant="default" onClick={() => setUpdateDialogOpen(true)}>
          <Icon name="download" className="size-4" />
          {openChamberUpdateLabel}
        </Button>
      ) : !update.available && !update.error ? (
        <span className="typography-meta text-muted-foreground">{t('settings.openchamber.about.state.upToDate')}</span>
      ) : null}
      <Button size="sm" variant="outline" onClick={checkAll} disabled={isChecking}>
        {t('settings.openchamber.about.actions.checkForUpdates')}
      </Button>
    </>
  );
  const versionValue = (version: string) => <span className="font-mono">{version}</span>;
  const notes = [
    manualUpdateNotice,
    remoteHostInstallBlocked ? remoteHostUpdateControls : null,
    openCodeUpdate?.note ?? null,
    ...[update.error, remoteHostUpdate?.error].filter(Boolean).map((error) => (
      <p key={error} className="rounded-lg bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
        {error}
      </p>
    )),
  ].filter(Boolean);

  return (
    <>
      <SettingsSection divider={false}>
        <div className="flex items-center gap-4">
          <AboutLogo size={48} />
          <div className="min-w-0 space-y-1">
            <h2 className={SETTINGS_BRAND_TITLE_CLASS}>OpenChamber</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {[
                { href: GITHUB_URL, icon: 'github-fill' as const, label: 'GitHub' },
                { href: DISCORD_URL, icon: 'discord-fill' as const, label: 'Discord' },
                { href: X_URL, icon: 'twitter-xfill' as const, label: '@openchamber_dev' },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon name={link.icon} className="size-4" />
                  <span>{link.label}</span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection contentClassName="space-y-4">
        <div>
          {updateChannelControl && (
            <SettingsFieldRow
              label={t('settings.openchamber.about.field.updateChannel')}
              info={t('settings.openchamber.about.field.updateChannelHint')}
            >
              {updateChannelControl}
            </SettingsFieldRow>
          )}
          {isDesktopRemote ? (
            <>
              <SettingsFieldRow label={t('settings.openchamber.about.field.appVersion')} description={versionValue(appVersion)}>
                {openChamberStatus}
              </SettingsFieldRow>
              <SettingsFieldRow label={t('settings.openchamber.about.field.serverVersion')} description={versionValue(remoteHostVersion)}>
                {remoteHostInstallBlocked ? null : remoteHostUpdateControls}
              </SettingsFieldRow>
            </>
          ) : (
            <SettingsFieldRow label={t('settings.openchamber.about.field.version')} description={versionValue(currentVersion)}>
              {openChamberStatus}
            </SettingsFieldRow>
          )}
          <SettingsFieldRow
            label={t('settings.openchamber.about.field.openCodeVersion')}
            description={versionValue(openCodeVersion || t('settings.openchamber.about.state.unknown'))}
          >
            {openCodeUpdate?.action}
          </SettingsFieldRow>
          <InstanceServiceUrls label={t('settings.openchamber.about.field.instanceUrls')} />
        </div>
        {notes.length > 0 && <div className="space-y-3">{notes}</div>}
      </SettingsSection>

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={update.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        installing={updateStore.installing}
        progress={updateStore.progress}
        error={update.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={update.runtimeType}
      />
      {remoteHostUpdateDialog}
    </>
  );
};
