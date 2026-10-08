import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { formatShortcutForDisplay, getCustomizableShortcutActions, UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import {
  SettingsCheckboxRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';

import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';
import type { DesktopQuakeMode } from './useDesktopQuakeMode';

const QUAKE_HEIGHT_OPTIONS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 1];

type DesktopQuakeModeSettingsProps = {
  quake: DesktopQuakeMode;
  // The Mini Chat global combo, a conflict source for the Quake recorder.
  miniChatCombo: string | null;
  onReleaseMiniChatShortcut: () => void;
};

export const DesktopQuakeModeSettings: React.FC<DesktopQuakeModeSettingsProps> = ({
  quake,
  miniChatCombo,
  onReleaseMiniChatShortcut,
}) => {
  const { t } = useI18n();
  const [editingShortcut, setEditingShortcut] = React.useState(false);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const shortcutAction = React.useMemo(
    () => getCustomizableShortcutActions().find((action) => action.id === 'quake_mode_global') ?? null,
    [],
  );
  // Recording the Mini Chat combo offers a replace instead of a silent
  // collision the main process would then refuse to register.
  const recorderOverrides = React.useMemo(
    () => (miniChatCombo ? { ...shortcutOverrides, mini_chat_global: miniChatCombo } : shortcutOverrides),
    [miniChatCombo, shortcutOverrides],
  );
  const heightValue = React.useMemo(() => {
    let best = QUAKE_HEIGHT_OPTIONS[0];
    for (const option of QUAKE_HEIGHT_OPTIONS) {
      if (Math.abs(option - quake.heightFraction) < Math.abs(best - quake.heightFraction)) {
        best = option;
      }
    }
    return String(best);
  }, [quake.heightFraction]);
  const { saveShortcut } = quake;

  const handleRecorderSave = React.useCallback((
    _actionId: string,
    combo: string,
    replaceActionId?: string,
  ) => {
    void saveShortcut(combo).then((saved) => {
      if (!saved || !replaceActionId) return;
      if (replaceActionId === 'mini_chat_global') {
        onReleaseMiniChatShortcut();
        return;
      }
      setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
      void updateDesktopSettings({ shortcutOverrides: { ...shortcutOverrides, [replaceActionId]: UNASSIGNED_SHORTCUT } });
    });
  }, [onReleaseMiniChatShortcut, saveShortcut, setShortcutOverride, shortcutOverrides]);

  if (!quake.supported) {
    return null;
  }

  return (
    <>
      <SettingsCheckboxRow
        settingsItem="sessions.desktop-quake-mode"
        checked={quake.enabled}
        onChange={(checked) => {
          if (checked === quake.enabled) return;
          quake.setEnabled(checked);
        }}
        disabled={quake.isSaving}
        label={t('settings.openchamber.desktopNetwork.field.quakeMode')}
        info={t('settings.openchamber.desktopNetwork.field.quakeModeDescription')}
        ariaLabel={t('settings.openchamber.desktopNetwork.field.quakeModeAria')}
      />

      {quake.enabled ? (
        <SettingsFieldRow
          label={t('settings.openchamber.desktopNetwork.field.quakeModeShortcut')}
          info={t('settings.openchamber.desktopNetwork.field.quakeModeShortcutDescription')}
          description={quake.combo && !quake.active ? (
            <span className="block text-[var(--status-warning)]">
              {t('settings.openchamber.desktopNetwork.field.quakeModeShortcutInactive')}
            </span>
          ) : undefined}
        >
          <kbd className="min-w-32 rounded-md border border-border bg-muted px-2 py-1 text-center typography-meta font-mono text-foreground">
            {quake.combo
              ? formatShortcutForDisplay(quake.combo)
              : t('settings.openchamber.keyboardShortcuts.unassigned')}
          </kbd>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="!font-normal"
            disabled={quake.isSaving}
            onClick={() => setEditingShortcut(true)}
          >
            {t('settings.openchamber.keyboardShortcuts.actions.edit')}
          </Button>
          {quake.storedCombo ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="!font-normal"
              disabled={quake.isSaving}
              onClick={() => void quake.saveShortcut(null)}
            >
              {t('settings.common.actions.reset')}
            </Button>
          ) : null}
        </SettingsFieldRow>
      ) : null}

      {quake.enabled ? (
        <SettingsFieldRow
          label={t('settings.openchamber.desktopNetwork.field.quakeModeHeight')}
          info={t('settings.openchamber.desktopNetwork.field.quakeModeHeightDescription')}
        >
          <Select
            value={heightValue}
            onValueChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) quake.setHeight(parsed);
            }}
            disabled={quake.isSaving}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.openchamber.desktopNetwork.field.quakeModeHeightAria')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUAKE_HEIGHT_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {`${Math.round(option * 100)}%`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      ) : null}

      <ShortcutRecordingDialog
        action={editingShortcut ? shortcutAction : null}
        overrides={recorderOverrides}
        onSave={handleRecorderSave}
        onOpenChange={(open) => {
          if (!open) {
            setEditingShortcut(false);
          }
        }}
        maxChords={1}
        maxKeys={5}
      />
    </>
  );
};
