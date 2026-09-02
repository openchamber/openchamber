import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  UNASSIGNED_SHORTCUT,
  type ShortcutActionId,
  type ShortcutCategory,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';

const CATEGORIES: ShortcutCategory[] = ['session', 'models', 'panels', 'navigation', 'application'];

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);
  const [editingAction, setEditingAction] = React.useState<CustomizableShortcutAction | null>(null);

  const actions = React.useMemo(() => {
    const all = getCustomizableShortcutActions();
    return isVSCodeRuntime() ? all.filter((action) => action.id !== 'toggle_prompt_navigator') : all;
  }, []);
  const persist = (nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  };
  const save = (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => {
    const nextOverrides = { ...shortcutOverrides, [actionId]: combo };
    if (replaceActionId) nextOverrides[replaceActionId] = UNASSIGNED_SHORTCUT;
    setShortcutOverride(actionId, combo);
    if (replaceActionId) setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
    persist(nextOverrides);
  };
  const resetOne = (actionId: ShortcutActionId) => {
    const nextOverrides = { ...shortcutOverrides };
    delete nextOverrides[actionId];
    clearShortcutOverride(actionId);
    persist(nextOverrides);
  };
  const shortcutDisplay = (action: CustomizableShortcutAction): string => {
    const isPrefixStyle = 'prefixStyle' in action && action.prefixStyle;
    const combo = isPrefixStyle
      ? getEffectiveShortcutPrefix(action.id, shortcutOverrides)
      : getEffectiveShortcutCombo(action.id, shortcutOverrides);
    const formatted = formatShortcutForDisplay(
      combo,
      t('settings.openchamber.keyboardShortcuts.unassigned'),
    );
    if (!isPrefixStyle || !combo || combo === UNASSIGNED_SHORTCUT) return formatted;
    const suffix = action.id === 'switch_session_tab'
      ? t('settings.openchamber.keyboardShortcuts.action.switch_session_tab.suffix')
      : t('settings.openchamber.keyboardShortcuts.action.switch_context_surface.suffix');
    return `${formatted}${suffix}`;
  };

  return (
    <>
      {CATEGORIES.map((category, categoryIndex) => {
        const categoryActions = actions.filter((action) => action.category === category);
        if (categoryActions.length === 0) return null;
        return (
          <SettingsSection
            key={category}
            settingsItem={categoryIndex === 0 ? 'shortcuts.keyboard-shortcuts' : undefined}
            title={t(`settings.openchamber.keyboardShortcuts.category.${category}`)}
            divider={categoryIndex !== 0}
            info={categoryIndex === 0 ? t('settings.openchamber.keyboardShortcuts.tooltip') : undefined}
            headerAction={categoryIndex === 0 ? (
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => {
                resetAllShortcutOverrides();
                persist({});
              }}>
                {t('settings.openchamber.keyboardShortcuts.actions.resetAll')}
              </Button>
            ) : undefined}
          >
            <div className="space-y-2">
              {categoryActions.map((action) => (
                <SettingsFieldRow key={action.id} label={t(action.settingsLabelKey)}>
                  <kbd
                    className="min-w-32 rounded-md border border-border bg-muted px-2 py-1 text-center typography-meta font-mono text-foreground"
                  >
                    {shortcutDisplay(action)}
                  </kbd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    className="!font-normal"
                    onClick={() => setEditingAction(action)}
                  >
                    {t('settings.openchamber.keyboardShortcuts.actions.edit')}
                  </Button>
                  {action.id in shortcutOverrides ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => resetOne(action.id)}
                    >
                      {t('settings.common.actions.reset')}
                    </Button>
                  ) : null}
                </SettingsFieldRow>
              ))}
            </div>
          </SettingsSection>
        );
      })}
      <ShortcutRecordingDialog
        action={editingAction}
        overrides={shortcutOverrides}
        onSave={save}
        onOpenChange={(open) => {
          if (!open) setEditingAction(null);
        }}
      />
    </>
  );
};
