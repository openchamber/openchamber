import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { SettingsChipGroup, SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutBinding,
  isShortcutAvailable,
  isSingleChordShortcut,
  normalizeCombo,
  shortcutMatchesRecordedCombo,
  shortcutRegistry,
  UNASSIGNED_SHORTCUT,
  type ShortcutActionId,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { shortcutSearchItemId } from '@/lib/settings/search';
import { getDesktopMiniChatGlobalShortcut, getDesktopQuakeMode, setDesktopMiniChatGlobalShortcut, setDesktopQuakeModeShortcut } from '@/lib/desktop';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { ShortcutRecordingDialog, updateShortcutRecordingState } from './ShortcutRecordingDialog';


const CATEGORIES = ['session', 'models', 'panels', 'navigation', 'application'] as const;

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);
  const { confirm: confirmResetAll, dialog: confirmResetAllDialog } = useConfirmDialog();
  const [editingAction, setEditingAction] = React.useState<CustomizableShortcutAction | null>(null);
  const [query, setQuery] = React.useState('');
  const [assignmentFilter, setAssignmentFilter] = React.useState<'all' | 'assigned' | 'unassigned'>('all');
  // The key filter is the chords typed so far. It applies on every key press.
  const [keyFilterChords, setKeyFilterChords] = React.useState<ShortcutCombo[]>([]);
  const keyFilter = keyFilterChords.length > 0 ? normalizeCombo(keyFilterChords.join(' ')) : null;
  const [recordingKey, setRecordingKey] = React.useState(false);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const capturingKeys = recordingKey && searchFocused;
  // The second key of a sequence armed before recording dispatches in window
  // capture, ahead of this field's handlers. Suspending the registry cancels
  // that pending sequence and keeps recorded keys from running commands.
  React.useEffect(() => (capturingKeys ? shortcutRegistry.suspend() : undefined), [capturingKeys]);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // The OS-level Mini Chat combo lives in the desktop setting, not in
  // shortcutOverrides; feed it to the recorder as a conflict source.
  const [globalMiniChatCombo, setGlobalMiniChatCombo] = React.useState<ShortcutCombo | null>(null);
  const refreshGlobalMiniChatCombo = React.useCallback(() => {
    void getDesktopMiniChatGlobalShortcut()
      .then((status) => setGlobalMiniChatCombo(status?.combo ?? null))
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    refreshGlobalMiniChatCombo();
  }, [refreshGlobalMiniChatCombo]);
  // Same for the OS-level Quake Mode combo: without it as a conflict source,
  // an in-app action could silently take over the Quake hotkey here.
  const [globalQuakeCombo, setGlobalQuakeCombo] = React.useState<ShortcutCombo | null>(null);
  const refreshGlobalQuakeCombo = React.useCallback(() => {
    void getDesktopQuakeMode()
      .then((status) => setGlobalQuakeCombo(status?.combo ?? null))
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    refreshGlobalQuakeCombo();
  }, [refreshGlobalQuakeCombo]);

  const actions = React.useMemo(() => getCustomizableShortcutActions().filter(isShortcutAvailable), []);
  const persist = (nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  };
  const save = (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => {
    const nextOverrides = { ...shortcutOverrides, [actionId]: combo };
    setShortcutOverride(actionId, combo);
    if (replaceActionId === 'mini_chat_global') {
      // Releasing the OS-level Mini Chat combo goes through the desktop
      // setting; the overrides only carried it as a conflict source.
      void setDesktopMiniChatGlobalShortcut(null).then((status) => {
        if (status) setGlobalMiniChatCombo(status.combo);
      });
    } else if (replaceActionId === 'quake_mode_global') {
      // Same release path for the Quake combo. It is stored as unassigned:
      // clearing it would bring back the default and take the combo again.
      void setDesktopQuakeModeShortcut(UNASSIGNED_SHORTCUT).then((status) => {
        if (status) setGlobalQuakeCombo(status.combo);
      });
    } else if (replaceActionId) {
      nextOverrides[replaceActionId] = UNASSIGNED_SHORTCUT;
      setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
    }
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
    const combo = getEffectiveShortcutBinding(action, shortcutOverrides);
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

  // The desktop global combos join the overrides as conflict sources.
  const recorderOverrides = { ...shortcutOverrides };
  if (globalMiniChatCombo) recorderOverrides.mini_chat_global = globalMiniChatCombo;
  if (globalQuakeCombo) recorderOverrides.quake_mode_global = globalQuakeCombo;

  const isAssigned = React.useCallback((action: CustomizableShortcutAction): boolean => {
    const combo = getEffectiveShortcutBinding(action, shortcutOverrides);
    return combo !== '' && combo !== UNASSIGNED_SHORTCUT;
  }, [shortcutOverrides]);

  const visibleActions = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return actions.filter((action) => {
      const assigned = isAssigned(action);
      if (assignmentFilter === 'assigned' && !assigned) return false;
      if (assignmentFilter === 'unassigned' && assigned) return false;
      if (keyFilter && !shortcutMatchesRecordedCombo(action, keyFilter, shortcutOverrides)) return false;
      if (!needle) return true;
      const label = t(action.settingsLabelKey).toLowerCase();
      const idText = action.id.replace(/_/g, ' ');
      const combo = assigned ? getEffectiveShortcutBinding(action, shortcutOverrides).toLowerCase() : '';
      return label.includes(needle) || idText.includes(needle) || combo.includes(needle);
    });
  }, [actions, assignmentFilter, isAssigned, keyFilter, query, shortcutOverrides, t]);

  const hasVisibleActions = visibleActions.length > 0;
  const activeFilterLabel = keyFilter
    ? formatShortcutForDisplay(keyFilter)
    : query.trim() || t(`settings.openchamber.keyboardShortcuts.filter.${assignmentFilter}`);

  const visibleCategories = CATEGORIES.filter((category) =>
    visibleActions.some((action) => action.category === category),
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Icon
            name="search"
            className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          {keyFilter ? (
            <kbd className="pointer-events-none absolute inset-s-7 top-1/2 -translate-y-1/2 rounded-md border border-border px-1.5 py-0.5 typography-micro text-foreground">
              {formatShortcutForDisplay(keyFilter)}
            </kbd>
          ) : null}
          <Input
            ref={searchInputRef}
            value={query}
            readOnly={recordingKey}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(event) => {
              if (recordingKey) {
                // While recording, keys build the chord filter. Stopping the
                // event also keeps Escape from closing the Settings dialog.
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.repeat) return;
                event.preventDefault();
                if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                  setKeyFilterChords([]);
                  return;
                }
                const next = updateShortcutRecordingState(
                  { chords: keyFilterChords, livePreview: null, settled: keyFilterChords.length >= 2 },
                  {
                    altKey: event.altKey,
                    code: event.nativeEvent.code,
                    ctrlKey: event.ctrlKey,
                    isComposing: event.nativeEvent.isComposing,
                    key: event.key,
                    metaKey: event.metaKey,
                    repeat: event.repeat,
                    shiftKey: event.shiftKey,
                  },
                  'keydown',
                  2,
                  { recordBackspace: true },
                );
                setKeyFilterChords(next.chords);
                return;
              }
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }
            }}
            onKeyUp={(event) => {
              if (recordingKey) event.stopPropagation();
            }}
            placeholder={keyFilter ? '' : t('settings.common.sidebar.searchPlaceholder')}
            aria-label={t('settings.common.sidebar.searchPlaceholder')}
            className={cn('h-8 typography-meta', keyFilter ? 'ps-24' : 'ps-7', recordingKey ? 'pe-40' : 'pe-16')}
          />
          <div className="absolute inset-e-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {recordingKey ? (
              <span className="me-1 rounded-sm bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">
                {t('settings.openchamber.keyboardShortcuts.findByKey.recording')}
              </span>
            ) : null}
            {keyFilter || query ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="!font-normal"
                aria-label={t('settings.common.sidebar.clearSearch')}
                onClick={() => {
                  setKeyFilterChords([]);
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                <Icon name="close" className="size-3.5" aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={cn('!font-normal', recordingKey && 'bg-[var(--interactive-selection)] text-[var(--primary-base)]')}
              aria-pressed={recordingKey}
              aria-label={t('settings.openchamber.keyboardShortcuts.findByKey.button')}
              title={t('settings.openchamber.keyboardShortcuts.findByKey.button')}
              onClick={() => {
                // Toggling either way clears the search, so a chord or text
                // search never carries over into the other mode.
                setQuery('');
                setKeyFilterChords([]);
                setRecordingKey((current) => !current);
                searchInputRef.current?.focus();
              }}
            >
              <Icon name="keyboard" className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
        <SettingsChipGroup
          value={assignmentFilter}
          aria-label={t('settings.openchamber.keyboardShortcuts.title')}
          onChange={setAssignmentFilter}
          options={[
            { value: 'all', label: t('settings.openchamber.keyboardShortcuts.filter.all') },
            { value: 'assigned', label: t('settings.openchamber.keyboardShortcuts.filter.assigned') },
            { value: 'unassigned', label: t('settings.openchamber.keyboardShortcuts.filter.unassigned') },
          ]}
        />
        <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => {
          void confirmResetAll({
            title: t('settings.openchamber.keyboardShortcuts.resetAllDialog.title'),
            message: t('settings.openchamber.keyboardShortcuts.resetAllDialog.message'),
            action: t('settings.openchamber.keyboardShortcuts.resetAllDialog.action'),
            destructive: true,
          }).then((confirmed) => {
            if (!confirmed) return;
            resetAllShortcutOverrides();
            persist({});
          });
        }}>
          {t('settings.openchamber.keyboardShortcuts.actions.resetAll')}
        </Button>
        {confirmResetAllDialog}
      </div>
      {!hasVisibleActions ? (
        <p className="px-2 py-6 text-center typography-meta text-muted-foreground">
          {t('settings.common.sidebar.noMatches', { query: activeFilterLabel })}
        </p>
      ) : null}
      {visibleCategories.map((category, visibleIndex) => {
        const categoryActions = visibleActions.filter((action) => action.category === category);
        const isFirstVisible = visibleIndex === 0;
        return (
          <SettingsSection
            key={category}
            settingsItem={isFirstVisible ? 'shortcuts.keyboard-shortcuts' : undefined}
            title={t(`settings.openchamber.keyboardShortcuts.category.${category}`)}
            divider={!isFirstVisible}
            info={isFirstVisible ? t('settings.openchamber.keyboardShortcuts.tooltip') : undefined}
          >
            <div>
              {categoryActions.map((action) => (
                <SettingsFieldRow key={action.id} label={t(action.settingsLabelKey)} settingsItem={shortcutSearchItemId(action.id)} controlClassName="flex-wrap">
                  <kbd
                    className="min-w-32 oc-tile-inset rounded-md px-2 py-1 text-center typography-meta text-foreground"
                  >
                    {shortcutDisplay(action)}
                  </kbd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    className="!font-normal"
                    onClick={() => {
                      refreshGlobalMiniChatCombo();
                      refreshGlobalQuakeCombo();
                      setEditingAction(action);
                    }}
                  >
                    {t('settings.openchamber.keyboardShortcuts.actions.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal"
                    disabled={shortcutOverrides[action.id] === UNASSIGNED_SHORTCUT}
                    onClick={() => save(action.id, UNASSIGNED_SHORTCUT)}
                  >
                    {t('settings.openchamber.keyboardShortcuts.actions.clear')}
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
        overrides={recorderOverrides}
        maxChords={editingAction && isSingleChordShortcut(editingAction) ? 1 : undefined}
        onSave={save}
        onOpenChange={(open) => {
          if (!open) setEditingAction(null);
        }}
      />
    </>
  );
};
