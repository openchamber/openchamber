import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMiniChatGlobalShortcut,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMiniChatGlobalShortcut,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { formatShortcutForDisplay, getCustomizableShortcutActions, UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';

import { DesktopQuakeModeSettings } from './DesktopQuakeModeSettings';
import { saveDesktopRestartDrafts, useDesktopRestartDrafts } from './desktopRestartDrafts';
import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';
import { useDesktopQuakeMode } from './useDesktopQuakeMode';

const SettingsErrorLine: React.FC<{ message: string | null }> = ({ message }) => (
  message ? <p className="typography-micro text-[var(--status-error)]">{message}</p> : null
);

/**
 * The desktop shell itself: how the app starts and lives on the system (login
 * item, menu bar, tray, keep awake), and the system-wide shortcuts that bring
 * it up from any app (Mini Chat, Quake Mode). Network access is its own
 * section, `DesktopNetworkSettings`.
 */
export const DesktopAppSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__OPENCHAMBER_PLATFORM__ === 'darwin';
  const isLinuxDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__OPENCHAMBER_PLATFORM__ === 'linux';
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  // The menu bar icon and the Linux window frame apply on the next launch, so
  // they stay drafts until "Save + restart".
  const [savedMacMenuBarEnabled, setSavedMacMenuBarEnabled] = React.useState(true);
  const [draftMacMenuBarEnabled, setDraftMacMenuBarEnabled] = React.useState(true);
  const [savedLinuxNativeFrame, setSavedLinuxNativeFrame] = React.useState(false);
  const [draftLinuxNativeFrame, setDraftLinuxNativeFrame] = React.useState(false);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [miniChatGlobalShortcutSupported, setMiniChatGlobalShortcutSupported] = React.useState(false);
  const [miniChatGlobalShortcutCombo, setMiniChatGlobalShortcutCombo] = React.useState<string | null>(null);
  const [miniChatGlobalShortcutActive, setMiniChatGlobalShortcutActive] = React.useState(false);
  const [isSavingMiniChatGlobalShortcut, setIsSavingMiniChatGlobalShortcut] = React.useState(false);
  const [editingMiniChatGlobalShortcut, setEditingMiniChatGlobalShortcut] = React.useState(false);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const miniChatGlobalShortcutAction = React.useMemo(
    () => getCustomizableShortcutActions().find((action) => action.id === 'mini_chat_global') ?? null,
    [],
  );
  // Each section shows the failures of its own controls.
  const [appError, setAppError] = React.useState<string | null>(null);
  const [quickAccessError, setQuickAccessError] = React.useState<string | null>(null);
  const quake = useDesktopQuakeMode(isLocalDesktop, setQuickAccessError);
  const { release: releaseQuakeShortcut } = quake;
  // Recording the Quake combo offers a replace instead of a silent collision
  // the main process would then refuse to register.
  const miniChatRecorderOverrides = React.useMemo(
    () => (quake.combo ? { ...shortcutOverrides, quake_mode_global: quake.combo } : shortcutOverrides),
    [quake.combo, shortcutOverrides],
  );

  React.useEffect(() => {
    if (!isLocalDesktop || (!isMacDesktop && !isLinuxDesktop)) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const data = await loadDesktopSettings();
        if (!data) {
          throw new Error(t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }
        if (cancelled) {
          return;
        }
        const macMenuBarEnabled = data.desktopMacMenuBarEnabled !== false;
        setSavedMacMenuBarEnabled(macMenuBarEnabled);
        setDraftMacMenuBarEnabled(macMenuBarEnabled);
        const linuxNativeFrame = data.desktopLinuxNativeFrame === true;
        setSavedLinuxNativeFrame(linuxNativeFrame);
        setDraftLinuxNativeFrame(linuxNativeFrame);
        setAppError(null);
      } catch (cause) {
        if (!cancelled) {
          setAppError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, isLocalDesktop, isMacDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setLaunchAtLoginSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopLaunchAtLogin();
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(status?.supported === true);
      setLaunchAtLoginEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setMinimizeToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMinimizeToTray();
      if (cancelled) {
        return;
      }
      setMinimizeToTraySupported(status?.supported === true);
      setMinimizeToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopKeepAwake();
      if (cancelled) {
        return;
      }
      setKeepAwakeSupported(status?.supported === true);
      setKeepAwakeEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setMiniChatGlobalShortcutSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMiniChatGlobalShortcut();
      if (cancelled) {
        return;
      }
      setMiniChatGlobalShortcutSupported(status?.supported === true);
      setMiniChatGlobalShortcutCombo(status?.combo ?? null);
      setMiniChatGlobalShortcutActive(status?.active === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  const restartDraftsDirty = draftMacMenuBarEnabled !== savedMacMenuBarEnabled
    || draftLinuxNativeFrame !== savedLinuxNativeFrame;
  const setRestartDraft = useDesktopRestartDrafts((state) => state.setDraft);
  const hasPendingRestart = useDesktopRestartDrafts((state) => Boolean(state.patches.app || state.patches.network));
  const restartBlocked = useDesktopRestartDrafts((state) => Boolean(state.blocked.network));

  // Publishes this section's pending changes, so a restart from the network
  // section saves them too.
  React.useEffect(() => {
    setRestartDraft('app', restartDraftsDirty ? {
      ...(draftMacMenuBarEnabled !== savedMacMenuBarEnabled ? { desktopMacMenuBarEnabled: draftMacMenuBarEnabled } : {}),
      ...(draftLinuxNativeFrame !== savedLinuxNativeFrame ? { desktopLinuxNativeFrame: draftLinuxNativeFrame } : {}),
    } : null, false);
  }, [draftLinuxNativeFrame, draftMacMenuBarEnabled, restartDraftsDirty, savedLinuxNativeFrame, savedMacMenuBarEnabled, setRestartDraft]);
  React.useEffect(() => () => setRestartDraft('app', null, false), [setRestartDraft]);

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setAppError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setAppError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.launchAtLoginSaveFailed'));
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported, t]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setAppError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
      }
      if (!status.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTrayUnsupported'));
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setAppError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported, t]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setAppError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setAppError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.keepAwakeSaveFailed'));
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported, t]);

  // Resolves true only when the combo was stored, so callers can tie other
  // changes to a successful save.
  const handleMiniChatGlobalShortcutSave = React.useCallback(async (combo: string | null): Promise<boolean> => {
    if (!miniChatGlobalShortcutSupported || isSavingMiniChatGlobalShortcut) {
      return false;
    }

    setIsSavingMiniChatGlobalShortcut(true);
    setQuickAccessError(null);

    try {
      const status = await setDesktopMiniChatGlobalShortcut(combo);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutSaveFailed'));
      }
      setMiniChatGlobalShortcutCombo(status.combo ?? null);
      setMiniChatGlobalShortcutActive(status.active === true);
      if (status.error === 'unsupported-combo') {
        setQuickAccessError(t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutUnsupported'));
        return false;
      }
      return true;
    } catch (cause) {
      setQuickAccessError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutSaveFailed'));
      return false;
    } finally {
      setIsSavingMiniChatGlobalShortcut(false);
    }
  }, [isSavingMiniChatGlobalShortcut, miniChatGlobalShortcutSupported, t]);

  // Mirrors the in-app shortcut save flow: when the recorded combo collides
  // with a customizable in-app action, free that binding so the global
  // shortcut owns the combo (both would otherwise fire simultaneously). The
  // in-app binding is released only after the global combo was stored.
  const handleMiniChatGlobalRecorderSave = React.useCallback((
    _actionId: string,
    combo: string,
    replaceActionId?: string,
  ) => {
    void handleMiniChatGlobalShortcutSave(combo).then((saved) => {
      if (!saved || !replaceActionId) return;
      if (replaceActionId === 'quake_mode_global') {
        releaseQuakeShortcut();
        return;
      }
      setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
      void updateDesktopSettings({ shortcutOverrides: { ...shortcutOverrides, [replaceActionId]: UNASSIGNED_SHORTCUT } });
    });
  }, [handleMiniChatGlobalShortcutSave, releaseQuakeShortcut, setShortcutOverride, shortcutOverrides]);

  const releaseMiniChatGlobalShortcut = React.useCallback(() => {
    void setDesktopMiniChatGlobalShortcut(null).then((status) => {
      if (!status) return;
      setMiniChatGlobalShortcutCombo(status.combo ?? null);
      setMiniChatGlobalShortcutActive(status.active === true);
    });
  }, []);

  const handleSaveAndRestart = React.useCallback(async () => {
    setIsSaving(true);
    setAppError(null);

    try {
      // Saves the network section's pending changes as well: the restart
      // would drop them otherwise.
      if (!await saveDesktopRestartDrafts()) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.saveFailed'));
      }
      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);
      setSavedLinuxNativeFrame(draftLinuxNativeFrame);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
      }
    } catch (cause) {
      setAppError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
    }
  }, [draftLinuxNativeFrame, draftMacMenuBarEnabled, t]);

  if (!isLocalDesktop) {
    return null;
  }

  const hasAppSettings = launchAtLoginSupported || isMacDesktop || isLinuxDesktop || minimizeToTraySupported || keepAwakeSupported;
  const hasQuickAccess = miniChatGlobalShortcutSupported || quake.supported;

  return (
    <>
      {hasAppSettings ? (
        <SettingsSection title={t('settings.layout.general.desktopApp.title')} divider={false} contentClassName="space-y-3">
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            {launchAtLoginSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-launch-at-login"
                checked={launchAtLoginEnabled}
                onChange={(checked) => {
                  if (checked === launchAtLoginEnabled) return;
                  void handleLaunchAtLoginToggle();
                }}
                disabled={isSavingLaunchAtLogin}
                label={t('settings.openchamber.desktopNetwork.field.launchAtLogin')}
                info={t('settings.openchamber.desktopNetwork.field.launchAtLoginDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.launchAtLoginAria')}
              />
            ) : null}

            {minimizeToTraySupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-minimize-to-tray"
                checked={minimizeToTrayEnabled}
                onChange={(checked) => {
                  if (checked === minimizeToTrayEnabled) return;
                  void handleMinimizeToTrayToggle();
                }}
                disabled={isSavingMinimizeToTray}
                label={t('settings.openchamber.desktopNetwork.field.minimizeToTray')}
                info={t('settings.openchamber.desktopNetwork.field.minimizeToTrayDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.minimizeToTrayAria')}
              />
            ) : null}

            {keepAwakeSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-keep-awake"
                checked={keepAwakeEnabled}
                onChange={(checked) => {
                  if (checked === keepAwakeEnabled) return;
                  void handleKeepAwakeToggle();
                }}
                disabled={isSavingKeepAwake}
                label={t('settings.openchamber.desktopNetwork.field.keepAwake')}
                info={t('settings.openchamber.desktopNetwork.field.keepAwakeDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.keepAwakeAria')}
              />
            ) : null}

            {isMacDesktop ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-mac-menu-bar"
                checked={draftMacMenuBarEnabled}
                onChange={setDraftMacMenuBarEnabled}
                disabled={isLoading || isSaving}
                label={t('settings.openchamber.desktopNetwork.field.macMenuBar')}
                info={t('settings.openchamber.desktopNetwork.field.macMenuBarDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.macMenuBarAria')}
              />
            ) : null}

            {isLinuxDesktop ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-linux-native-frame"
                checked={draftLinuxNativeFrame}
                onChange={setDraftLinuxNativeFrame}
                disabled={isLoading || isSaving}
                label={t('settings.openchamber.desktopNetwork.field.linuxNativeFrame')}
                info={t('settings.openchamber.desktopNetwork.field.linuxNativeFrameDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.linuxNativeFrame')}
              />
            ) : null}
          </div>

          <SettingsErrorLine message={appError} />

          {/* The menu bar icon and the window frame take effect on the next
              launch; the button is there only where such a toggle is. */}
          {isMacDesktop || isLinuxDesktop ? (
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndRestart}
              disabled={isLoading || isSaving || !hasPendingRestart || restartBlocked}
              className="!font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.desktopNetwork.actions.saveAndRestart')}
            </Button>
          ) : null}
        </SettingsSection>
      ) : null}

      {hasQuickAccess ? (
        <SettingsSection
          title={t('settings.layout.general.quickAccess.title')}
          info={t('settings.layout.general.quickAccess.info')}
          divider={hasAppSettings}
          contentClassName="space-y-2"
        >
          {miniChatGlobalShortcutSupported ? (
            <SettingsFieldRow
              settingsItem="sessions.desktop-mini-chat-global-shortcut"
              label={t('settings.openchamber.desktopNetwork.field.miniChatGlobalShortcut')}
              info={t('settings.openchamber.desktopNetwork.field.miniChatGlobalShortcutDescription')}
              description={miniChatGlobalShortcutCombo && !miniChatGlobalShortcutActive ? (
                <span className="block text-[var(--status-warning)]">
                  {t('settings.openchamber.desktopNetwork.field.miniChatGlobalShortcutInactive')}
                </span>
              ) : undefined}
            >
              <kbd className="min-w-32 oc-tile-inset rounded-md px-2 py-1 text-center typography-meta text-foreground">
                {miniChatGlobalShortcutCombo
                  ? formatShortcutForDisplay(miniChatGlobalShortcutCombo)
                  : t('settings.openchamber.keyboardShortcuts.unassigned')}
              </kbd>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="!font-normal"
                disabled={isSavingMiniChatGlobalShortcut}
                onClick={() => setEditingMiniChatGlobalShortcut(true)}
              >
                {t('settings.openchamber.keyboardShortcuts.actions.edit')}
              </Button>
              {miniChatGlobalShortcutCombo ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  disabled={isSavingMiniChatGlobalShortcut}
                  onClick={() => void handleMiniChatGlobalShortcutSave(null)}
                >
                  {t('settings.common.actions.reset')}
                </Button>
              ) : null}
            </SettingsFieldRow>
          ) : null}

          <DesktopQuakeModeSettings
            quake={quake}
            miniChatCombo={miniChatGlobalShortcutCombo}
            onReleaseMiniChatShortcut={releaseMiniChatGlobalShortcut}
          />

          <SettingsErrorLine message={quickAccessError} />

          <ShortcutRecordingDialog
            action={editingMiniChatGlobalShortcut ? miniChatGlobalShortcutAction : null}
            overrides={miniChatRecorderOverrides}
            onSave={handleMiniChatGlobalRecorderSave}
            onOpenChange={(open) => {
              if (!open) {
                setEditingMiniChatGlobalShortcut(false);
              }
            }}
            maxChords={1}
            maxKeys={5}
          />
        </SettingsSection>
      ) : null}
    </>
  );
};
