import React from 'react';
import { checkConnectedServerForUpdates, useUpdateStore } from '@/stores/useUpdateStore';
import type { UpdateInfo } from '@/lib/desktop';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';
import { openExternalUrl } from '@/lib/url';
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
import { formatCanaryBuild, parseCanaryVersion, type UpdateChannel } from '@/lib/updateChannel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { copyTextToClipboard } from '@/lib/clipboard';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { fetchOpenCodeUpgradeStatus, runOpenCodeUpgrade, type OpenCodeUpgradeStatus } from '@/components/update/openCodeUpgrade';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { getUpdateCheckErrorMessage } from '@/lib/updateCheckError';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import { DesktopAutoUpdateRow } from './DesktopAutoUpdateRow';
import { AboutReleaseNotes } from './AboutReleaseNotes';
import { AboutUpdateBanners } from './AboutUpdateBanners';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  SettingsChipGroup,
  SettingsSection,
  SettingsFieldRow,
  SETTINGS_BRAND_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/openchamber/openchamber';
const DISCORD_URL = 'https://discord.gg/ZYRSdnwwKA';
const X_URL = 'https://x.com/openchamber_dev';

const MIN_CHECKING_DURATION = 800;

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
        error: error instanceof Error ? getUpdateCheckErrorMessage(error) : String(error),
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

function useOpenCodeUpgrade(failedFallback: string) {
  const [status, setStatus] = React.useState<OpenCodeUpgradeStatus | null>(null);
  const [phase, setPhase] = React.useState<OpenCodeUpgradePhase>({ kind: 'idle' });

  const refresh = React.useCallback(async (): Promise<OpenCodeUpgradeStatus | null> => {
    try {
      const next = await fetchOpenCodeUpgradeStatus();
      setStatus(next);
      return next;
    } catch {
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
    installing: s.installing, idlePhase: s.idlePhase, idleReason: s.idleReason, idleRemainingMs: s.idleRemainingMs,
    progress: s.progress,
    runtimeType: s.runtimeType,
    checkForUpdates: s.checkForUpdates,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate, queueIdleInstall: s.queueIdleInstall, cancelIdleInstall: s.cancelIdleInstall,
  })));
  const { isMobile } = useDeviceInfo();
  const isNativeApp = React.useMemo(() => isCapacitorApp(), []);
  const isAndroidApp = isNativeApp && getClientPlatform() === 'android';
  const isDesktopRemote = useDesktopRemoteHostActive();
  const serverUpdate = useConnectedServerUpdate(isNativeApp || isDesktopRemote);
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

  const describeVersion = (version: string, beside?: string | null) => {
    const canary = parseCanaryVersion(version);
    return canary
      ? t('settings.openchamber.about.canaryVersion', {
        version: canary.release,
        date: formatCanaryBuild(canary, getCurrentIntlLocale(), parseCanaryVersion(beside)),
      })
      : version;
  };
  const offeredVersion = update.available ? update.info?.version : null;
  const currentVersion = describeVersion(openChamberVersion || update.info?.currentVersion || 'unknown', offeredVersion);
  const appVersion = describeVersion(desktopAppVersion || updateStore.info?.currentVersion || 'unknown', offeredVersion);
  const remoteHostVersion = openChamberVersion || remoteHostUpdate?.info?.currentVersion || 'unknown';

  const renderReleaseNotes = (
    installed: string | null | undefined,
    offered: string | null | undefined,
    owner: React.ComponentProps<typeof AboutReleaseNotes>['owner'],
  ) => {
    if (!installed) return null;
    const leavesCanary = Boolean(offered && parseCanaryVersion(installed) && !parseCanaryVersion(offered));
    return (
      <AboutReleaseNotes
        version={offered || installed}
        since={offered && !leavesCanary ? installed : null}
        describeVersion={describeVersion}
        owner={owner}
      />
    );
  };
  const installedVersion = isDesktopRemote
    ? desktopAppVersion || updateStore.info?.currentVersion
    : openChamberVersion || update.info?.currentVersion;
  const releaseNotes = (
    <>
      {isAndroidApp && renderReleaseNotes(
        updateStore.info?.currentVersion,
        updateStore.available ? updateStore.info?.version : null,
        'app',
      )}
      {renderReleaseNotes(installedVersion, offeredVersion, isAndroidApp ? 'server' : 'installed')}
    </>
  );

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

  const serverUpdateLabel = (info: UpdateInfo | null) => {
    const version = describeVersion(info?.version || '', info?.currentVersion);
    return info?.packageManager === 'electron'
      ? t('settings.openchamber.about.actions.updateDesktopToVersion', { version })
      : t('settings.openchamber.about.actions.updateServerToVersion', { version });
  };
  const openChamberUpdateLabel = (() => {
    const version = describeVersion(update.info?.version || '', update.info?.currentVersion);
    if (isNativeApp) return serverUpdateLabel(update.info);
    return isDesktopRemote
      ? t('settings.openchamber.about.actions.updateAppToVersion', { version })
      : t('settings.openchamber.about.actions.updateOpenChamberToVersion', { version });
  })();
  const needsNewerOpenCode = (info: UpdateInfo | null) => info?.installBlocked === 'opencode-version';
  const isInstallBlocked = (info: UpdateInfo | null) => Boolean(info?.installBlocked) && !needsNewerOpenCode(info);
  const installBlocked = update.available && isInstallBlocked(update.info);

  const appDownloadUrl = isAndroidApp && updateStore.runtimeType === 'mobile' && updateStore.available
    ? updateStore.info?.downloadUrl ?? null
    : null;
  const appUpdateButton = appDownloadUrl ? (
    <Button type="button" size="sm" variant="outline" onClick={() => void openExternalUrl(appDownloadUrl)}>
      <Icon name="download" className="size-4" />
      {t('settings.openchamber.about.actions.downloadAppVersion', {
        version: describeVersion(updateStore.info?.version || '', nativeAppVersion),
      })}
    </Button>
  ) : null;

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
  const updateChannelControl = updateChannel && (
    <SettingsChipGroup
      value={updateChannel}
      onChange={(channel) => void chooseUpdateChannel(channel)}
      aria-label={t('settings.openchamber.about.field.updateChannel')}
      className="flex-nowrap"
      options={[
        { value: 'stable', label: t('settings.openchamber.about.option.updateChannel.stable') },
        { value: 'canary', label: t('settings.openchamber.about.option.updateChannel.canary'), selectedClassName: 'bg-[var(--brand-canary)] text-[var(--brand-canary-foreground)] hover:bg-[var(--brand-canary)] hover:text-[var(--brand-canary-foreground)]' },
      ]}
    />
  );

  const checkAll = () => {
    void update.checkForUpdates();
    if (remoteHostUpdate) void remoteHostUpdate.check();
    if (isAndroidApp) void updateStore.checkForUpdates();
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
        scopes: ['all'],
      });
    }).then(() => {
      void update.checkForUpdates();
      if (remoteHostUpdate) void remoteHostUpdate.check();
    });
  };

  const renderManualUpdateNotice = (info: UpdateInfo | null) => {
    if (info?.installBlocked === 'opencode-version') {
      return (
        <p className="typography-meta text-[var(--status-warning)]">
          {t('updateDialog.openCodeTooOld', {
            version: describeVersion(info.version || ''),
            required: info.requiredOpenCodeVersion || '',
            current: info.openCodeVersion || '',
          })}
        </p>
      );
    }
    if (info?.installBlocked === 'desktop-host') {
      return (
        <p className="typography-meta text-muted-foreground">
          {t('updateDialog.desktopHostInstall', { version: info.version || '' })}
        </p>
      );
    }
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
          <ScrollableOverlay as="code" outerClassName="overlay-scrollbar-wrapper--no-gutter flex-1 min-w-0" fillContainer={false} className="whitespace-nowrap font-mono text-sm text-foreground">{command}</ScrollableOverlay>
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
  const manualUpdateNotice = update.available && update.info?.installBlocked ? renderManualUpdateNotice(update.info) : null;

  const remoteHostOffered = Boolean(remoteHostUpdate?.available && !remoteHostUpdate.checking);
  const remoteHostUpdateNotice = remoteHostOffered && remoteHostUpdate?.info?.installBlocked
    ? renderManualUpdateNotice(remoteHostUpdate.info)
    : null;
  const remoteHostUpdateButton = remoteHostOffered && !isInstallBlocked(remoteHostUpdate?.info ?? null) ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setServerUpdateDialogOpen(true)}
      disabled={needsNewerOpenCode(remoteHostUpdate?.info ?? null)}
    >
      <Icon name="download" className="size-4" />
      {serverUpdateLabel(remoteHostUpdate?.info ?? null)}
    </Button>
  ) : null;
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

  const didInitiateCheck = React.useRef(false);
  const appChecking = isAndroidApp && updateStore.checking;
  const appUpdateOffered = Boolean(appDownloadUrl);

  React.useEffect(() => {
    if (update.checking) {
      setShowChecking(true);
      didInitiateCheck.current = true;
    } else if (showChecking && !appChecking) {
      const timer = setTimeout(() => {
        setShowChecking(false);
        const remoteHostPending = remoteHostUpdateChecking || remoteHostUpdateAvailable;
        if (didInitiateCheck.current && !update.available && !update.error && !remoteHostPending) {
          toast.success(appUpdateOffered
            ? t('settings.openchamber.about.toast.serverLatestAppUpdate')
            : isNativeApp
              ? t('settings.openchamber.about.toast.serverLatestVersion')
              : t('settings.openchamber.about.toast.latestVersion'));
          didInitiateCheck.current = false;
        }
      }, MIN_CHECKING_DURATION);
      return () => clearTimeout(timer);
    }
  }, [t, isNativeApp, update.checking, showChecking, update.available, update.error, remoteHostUpdateChecking, remoteHostUpdateAvailable, appChecking, appUpdateOffered]);

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
              {isChecking ? <Spinner className="size-4" /> : <Icon name="refresh" className="size-4" />}
              {isChecking
                ? t('settings.openchamber.about.state.checking')
                : isNativeApp && !isAndroidApp
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
              disabled={needsNewerOpenCode(update.info)}
              className="w-auto justify-center gap-2"
            >
              <Icon name="download" className="size-4" />
              {openChamberUpdateLabel}
            </Button>
          )}
        </div>

        {appUpdateButton && <div className="flex justify-center">{appUpdateButton}</div>}

        {manualUpdateNotice}

        {(remoteHostUpdateButton || remoteHostUpdateNotice) && (
          <div className="flex flex-col items-center gap-2 text-center">
            {remoteHostUpdateButton}
            {remoteHostUpdateNotice}
          </div>
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

        {releaseNotes}

        <UpdateDialog
          open={updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
          info={update.info}
          downloading={updateStore.downloading}
          downloaded={updateStore.downloaded}
          installing={updateStore.installing} idlePhase={updateStore.idlePhase} idleReason={updateStore.idleReason} idleRemainingMs={updateStore.idleRemainingMs}
          progress={updateStore.progress}
          error={update.error}
          onDownload={updateStore.downloadUpdate}
          onRestart={updateStore.restartToUpdate} onInstallWhenIdle={updateStore.queueIdleInstall} onCancelIdleInstall={updateStore.cancelIdleInstall}
          runtimeType={update.runtimeType}
        />
        {remoteHostUpdateDialog}
      </div>
    );
  }

  const statusSeparator = <span aria-hidden="true" className="typography-meta text-muted-foreground/60">·</span>;
  const openChamberStatus = isChecking ? (
    <>
      {statusSeparator}
      <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
        <Spinner className="size-4" />
        {t('settings.openchamber.about.state.checking')}
      </span>
    </>
  ) : !update.available && !update.error ? (
    <>
      {statusSeparator}
      <span className="typography-meta text-muted-foreground">{t('settings.openchamber.about.state.upToDate')}</span>
    </>
  ) : null;
  const versionValue = (version: string) => (
    <span className="typography-meta font-mono text-muted-foreground">{version}</span>
  );
  const valueRow = { alignEnd: false, controlClassName: 'min-h-8 flex-wrap @xl:flex-initial' };
  const notes = [
    manualUpdateNotice,
    remoteHostUpdateNotice,
    openCodeUpdate?.note ?? null,
    ...[update.error, remoteHostUpdate?.error].filter(Boolean).map((error) => (
      <p key={error} className="rounded-lg bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error)]">
        {error}
      </p>
    )),
  ].filter(Boolean);

  return (
    <>
      <SettingsSection>
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
        <AboutUpdateBanners describeVersion={describeVersion}
          main={!isChecking && update.available && !installBlocked ? { info: update.info, owner: isDesktopRemote ? 'app' : isNativeApp ? 'server' : 'openchamber', onUpdate: () => setUpdateDialogOpen(true) } : null}
          remoteHost={remoteHostUpdateButton ? { info: remoteHostUpdate?.info ?? null, onUpdate: () => setServerUpdateDialogOpen(true) } : null}
          appDownload={appDownloadUrl ? { version: describeVersion(updateStore.info?.version || '', nativeAppVersion), url: appDownloadUrl } : null}
        />
        <div>
          {isDesktopRemote ? (
            <>
              <SettingsFieldRow label={t('settings.openchamber.about.field.appVersion')} {...valueRow}>
                {versionValue(appVersion)}
                {openChamberStatus}
              </SettingsFieldRow>
              <SettingsFieldRow label={t('settings.openchamber.about.field.serverVersion')} {...valueRow}>
                {versionValue(remoteHostVersion)}
              </SettingsFieldRow>
            </>
          ) : isNativeApp ? (
            <>
              {nativeAppVersion && (
                <SettingsFieldRow label={t('settings.openchamber.about.field.appVersion')} {...valueRow}>
                  {versionValue(describeVersion(nativeAppVersion, updateStore.info?.version))}
                </SettingsFieldRow>
              )}
              <SettingsFieldRow label={t('settings.openchamber.about.field.serverVersion')} {...valueRow}>
                {versionValue(currentVersion)}
                {openChamberStatus}
              </SettingsFieldRow>
            </>
          ) : (
            <SettingsFieldRow label={t('settings.openchamber.about.field.version')} {...valueRow}>
              {versionValue(currentVersion)}
              {openChamberStatus}
            </SettingsFieldRow>
          )}
          <SettingsFieldRow
            label={t('settings.openchamber.about.field.updateChannel')}
            info={updateChannelControl ? t('settings.openchamber.about.field.updateChannelHint') : undefined}
            {...valueRow}
          >
            {updateChannelControl}
            <Button size="sm" variant="ghost" onClick={checkAll} disabled={isChecking}>
              <Icon name="refresh" className="size-4" />
              {t('settings.openchamber.about.actions.checkForUpdates')}
            </Button>
          </SettingsFieldRow>
          <DesktopAutoUpdateRow enabled={isDesktopApp} onEnabled={() => void update.checkForUpdates()} />
          <SettingsFieldRow label={t('settings.openchamber.about.field.openCodeVersion')} {...valueRow}>
            {versionValue(openCodeVersion || t('settings.openchamber.about.state.unknown'))}
            {openCodeUpdate?.action}
          </SettingsFieldRow>
          <InstanceServiceUrls label={t('settings.openchamber.about.field.instanceUrls')} />
        </div>
        {notes.length > 0 && <div className="space-y-3">{notes}</div>}
      </SettingsSection>

      {releaseNotes}

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={update.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        installing={updateStore.installing} idlePhase={updateStore.idlePhase} idleReason={updateStore.idleReason} idleRemainingMs={updateStore.idleRemainingMs}
        progress={updateStore.progress}
        error={update.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate} onInstallWhenIdle={updateStore.queueIdleInstall} onCancelIdleInstall={updateStore.cancelIdleInstall}
        runtimeType={update.runtimeType}
      />
      {remoteHostUpdateDialog}
    </>
  );
};
