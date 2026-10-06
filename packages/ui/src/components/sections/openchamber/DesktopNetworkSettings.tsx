import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getDesktopLanAddress,
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
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { formatShortcutForDisplay, getCustomizableShortcutActions, UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsFieldRow,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';

import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';

export const DesktopNetworkSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__OPENCHAMBER_PLATFORM__ === 'darwin';
  const isLinuxDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__OPENCHAMBER_PLATFORM__ === 'linux';
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  // The password is write-only: the server says whether one is set, and the
  // page sends a value only when the user types a new one or removes it.
  const [hasSavedPassword, setHasSavedPassword] = React.useState(false);
  const [draftPassword, setDraftPassword] = React.useState('');
  const [removePassword, setRemovePassword] = React.useState(false);
  const [lanAccessActive, setLanAccessActive] = React.useState(false);
  const [lanAccessBlockedReason, setLanAccessBlockedReason] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
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
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
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

        const enabled = data.desktopLanAccessEnabled === true;
        setSavedValue(enabled);
        setDraftValue(enabled);
        setHasSavedPassword(data.hasDesktopUiPassword === true);
        setDraftPassword('');
        setRemovePassword(false);
        setLanAccessActive(data.desktopLanAccessActive === true);
        setLanAccessBlockedReason(data.desktopLanAccessBlockedReason ?? null);
        const macMenuBarEnabled = data.desktopMacMenuBarEnabled !== false;
        setSavedMacMenuBarEnabled(macMenuBarEnabled);
        setDraftMacMenuBarEnabled(macMenuBarEnabled);
        const linuxNativeFrame = data.desktopLinuxNativeFrame === true;
        setSavedLinuxNativeFrame(linuxNativeFrame);
        setDraftLinuxNativeFrame(linuxNativeFrame);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.loadFailed'));
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
  }, [isLocalDesktop, t]);

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

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const nextPassword = draftPassword.trim();
  const passwordDirty = nextPassword.length > 0 || removePassword;
  const isDirty = draftValue !== savedValue
    || passwordDirty
    || draftMacMenuBarEnabled !== savedMacMenuBarEnabled
    || draftLinuxNativeFrame !== savedLinuxNativeFrame;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAccessActive && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;
  const passwordWillBeSet = nextPassword.length > 0 || (hasSavedPassword && !removePassword);
  const lanRequiresPassword = draftValue && !passwordWillBeSet;
  const lanBlockedByMissingPassword = savedValue && !lanAccessActive && lanAccessBlockedReason === 'missing-password';
  // Enterprise mode without the administrator's allowance: the desktop binds
  // loopback and the server refuses a network address, so there is no choice here.
  const lanBlockedByEnterprise = useEnterprisePolicyStore((state) => state.networkAccessBlocked)
    || lanAccessBlockedReason === 'enterprise-mode';
  const saveDisabled = isLoading || isSaving || !isDirty || lanRequiresPassword;

  const handlePasswordChange = React.useCallback((value: string) => {
    setDraftPassword(value);
    if (value.trim()) {
      setRemovePassword(false);
    }
  }, []);

  const handleRemovePassword = React.useCallback(() => {
    setDraftPassword('');
    setRemovePassword(true);
    setDraftValue(false);
  }, []);

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.launchAtLoginSaveFailed'));
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
    setError(null);

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
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
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
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.keepAwakeSaveFailed'));
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
    setError(null);

    try {
      const status = await setDesktopMiniChatGlobalShortcut(combo);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutSaveFailed'));
      }
      setMiniChatGlobalShortcutCombo(status.combo ?? null);
      setMiniChatGlobalShortcutActive(status.active === true);
      if (status.error === 'unsupported-combo') {
        setError(t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutUnsupported'));
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.miniChatGlobalShortcutSaveFailed'));
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
      setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
      void updateDesktopSettings({ shortcutOverrides: { ...shortcutOverrides, [replaceActionId]: UNASSIGNED_SHORTCUT } });
    });
  }, [handleMiniChatGlobalShortcutSave, setShortcutOverride, shortcutOverrides]);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const result = await updateDesktopSettings({
        desktopLanAccessEnabled: draftValue,
        // Omitted when unchanged: the server keeps the password it has.
        ...(nextPassword ? { desktopUiPassword: nextPassword } : removePassword ? { desktopUiPassword: '' } : {}),
        desktopMacMenuBarEnabled: draftMacMenuBarEnabled,
        desktopLinuxNativeFrame: draftLinuxNativeFrame,
      });

      if (!result.ok) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.saveFailed'));
      }

      setSavedValue(draftValue);
      if (nextPassword) {
        setHasSavedPassword(true);
      } else if (removePassword) {
        setHasSavedPassword(false);
      }
      setDraftPassword('');
      setRemovePassword(false);
      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);
      setSavedLinuxNativeFrame(draftLinuxNativeFrame);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
    }
  }, [draftLinuxNativeFrame, draftMacMenuBarEnabled, draftValue, isDirty, nextPassword, removePassword, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.openchamber.desktopNetwork.title')}>
      <div className="space-y-3">
        {(launchAtLoginSupported || isMacDesktop || isLinuxDesktop || minimizeToTraySupported || keepAwakeSupported || miniChatGlobalShortcutSupported) ? (
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
                <kbd className="min-w-32 rounded-md border border-border bg-muted px-2 py-1 text-center typography-meta font-mono text-foreground">
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
          </div>
        ) : null}

        <SettingsStackedField
          settingsItem="sessions.desktop-ui-password"
          label={(
            <label htmlFor="desktop-ui-password">
              {t('settings.openchamber.desktopPassword.field.password')}
            </label>
          )}
          info={t('settings.openchamber.desktopPassword.field.passwordDescription')}
        >
          <Input
            id="desktop-ui-password"
            type="password"
            className="h-8 min-w-0 flex-1"
            value={draftPassword}
            onChange={(event) => handlePasswordChange(event.target.value)}
            placeholder={t(hasSavedPassword && !removePassword
              ? 'settings.openchamber.desktopPassword.field.passwordSetPlaceholder'
              : 'settings.openchamber.desktopPassword.field.passwordPlaceholder')}
            disabled={isLoading || isSaving}
            required={draftValue && !passwordWillBeSet}
            aria-invalid={lanRequiresPassword}
          />
          {hasSavedPassword && !removePassword ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleRemovePassword}
              disabled={isLoading || isSaving}
              className="shrink-0 !font-normal"
            >
              {t('settings.openchamber.desktopPassword.actions.removePassword')}
            </Button>
          ) : null}
        </SettingsStackedField>

        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.desktop-lan-access"
            checked={draftValue && !lanBlockedByEnterprise}
            onChange={setDraftValue}
            disabled={isLoading || isSaving || lanBlockedByEnterprise}
            label={t('settings.openchamber.desktopNetwork.field.allowLanAccess')}
            info={t('settings.openchamber.desktopNetwork.field.allowLanAccessDescription')}
            description={lanBlockedByEnterprise ? (
              <span className="block">{t('settings.openchamber.desktopNetwork.field.enterpriseBlocked')}</span>
            ) : (
              <>
                <span className="block text-[var(--status-warning)]/85">
                  {t('settings.openchamber.desktopNetwork.field.warning')}
                </span>
                {lanRequiresPassword || lanBlockedByMissingPassword ? (
                  <span className="block text-[var(--status-warning)]/85">
                    {t('settings.openchamber.desktopNetwork.field.passwordRequiredWarning')}
                  </span>
                ) : null}
              </>
            )}
            ariaLabel={t('settings.openchamber.desktopNetwork.field.allowLanAccessAria')}
          />
        </div>

        {error ? (
          <div className="typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {lanUrl && !lanBlockedByEnterprise ? (
          <div className="typography-micro text-muted-foreground/80">
            {isDirty && !savedValue
              ? t('settings.openchamber.desktopNetwork.hint.openAfterRestart')
              : t('settings.openchamber.desktopNetwork.hint.openNow')}
            <span className="font-mono text-foreground">{lanUrl}</span>
          </div>
        ) : null}

        <div className="flex justify-start py-1.5">
          <Button
            type="button"
            size="xs"
            onClick={handleSaveAndRestart}
            disabled={saveDisabled}
            className="shrink-0 !font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.desktopNetwork.actions.saveAndRestart')}
          </Button>
        </div>
      </div>
      <ShortcutRecordingDialog
        action={editingMiniChatGlobalShortcut ? miniChatGlobalShortcutAction : null}
        overrides={shortcutOverrides}
        onSave={handleMiniChatGlobalRecorderSave}
        onOpenChange={(open) => {
          if (!open) {
            setEditingMiniChatGlobalShortcut(false);
          }
        }}
        maxChords={1}
      />
    </SettingsSection>
  );
};
