import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { SETTINGS_HELPER_CLASS, SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { ENVIRONMENT_VARIABLE_NAME_PATTERN } from '@/lib/environmentApi';
import { useI18n } from '@/lib/i18n';

type EnvironmentVariablesEditorProps = {
  /** Names of the stored variables. Values never reach the UI. */
  names: string[];
  disabled?: boolean;
  /** Stores a value; resolves true when it was saved. */
  onSet: (name: string, value: string) => Promise<boolean>;
  onRemove: (name: string) => Promise<boolean>;
};

/**
 * A list of environment variable names with a way to add a variable, replace
 * a stored value or remove one. A stored value is never shown: replacing it
 * means typing a new one.
 */
export const EnvironmentVariablesEditor: React.FC<EnvironmentVariablesEditorProps> = ({
  names,
  disabled = false,
  onSet,
  onRemove,
}) => {
  const { t } = useI18n();
  const [newName, setNewName] = React.useState('');
  const [newValue, setNewValue] = React.useState('');
  const [replacing, setReplacing] = React.useState<string | null>(null);
  const [replacementValue, setReplacementValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const trimmedName = newName.trim();
  const nameInvalid = trimmedName.length > 0 && !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(trimmedName);
  const controlsDisabled = disabled || busy;

  const run = async (action: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    if (!trimmedName || nameInvalid) return;
    if (await run(() => onSet(trimmedName, newValue))) {
      setNewName('');
      setNewValue('');
    }
  };

  const handleReplace = async (name: string) => {
    if (await run(() => onSet(name, replacementValue))) {
      setReplacing(null);
      setReplacementValue('');
    }
  };

  const cancelReplace = () => {
    setReplacing(null);
    setReplacementValue('');
  };

  return (
    <div className="space-y-3">
      {names.length === 0 ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.editor.empty')}</p>
      ) : (
        <ul className="w-full max-w-[32rem] space-y-1">
          {names.map((name) => (
            <li key={name} className="flex min-h-8 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-xs text-foreground">{name}</span>
              {replacing === name ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleReplace(name);
                  }}
                >
                  <Input
                    type="password"
                    autoFocus
                    value={replacementValue}
                    onChange={(event) => setReplacementValue(event.target.value)}
                    placeholder={t('settings.environment.editor.newValuePlaceholder')}
                    aria-label={t('settings.environment.editor.newValueAria', { name })}
                    disabled={controlsDisabled}
                    className="h-8 min-w-0 max-w-[16rem] flex-1 font-mono text-xs"
                  />
                  <Button type="submit" size="xs" disabled={controlsDisabled} className="shrink-0 !font-normal">
                    {t('settings.environment.editor.save')}
                  </Button>
                  <Button type="button" variant="ghost" size="xs" onClick={cancelReplace} disabled={busy} className="shrink-0 !font-normal">
                    {t('settings.common.actions.cancel')}
                  </Button>
                </form>
              ) : (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setReplacing(name);
                      setReplacementValue('');
                    }}
                    disabled={controlsDisabled}
                    className={SETTINGS_ICON_BUTTON_CLASS}
                    aria-label={t('settings.environment.editor.replaceAria', { name })}
                    title={t('settings.environment.editor.replace')}
                  >
                    <Icon name="pencil" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void run(() => onRemove(name))}
                    disabled={controlsDisabled}
                    className={SETTINGS_ICON_BUTTON_CLASS}
                    aria-label={t('settings.environment.editor.removeAria', { name })}
                    title={t('settings.environment.editor.remove')}
                  >
                    <Icon name="delete-bin" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <div className="flex w-full max-w-[32rem] flex-wrap items-center gap-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            // An identifier is written the same in every language.
            placeholder="NAME"
            aria-label={t('settings.environment.editor.nameAria')}
            aria-invalid={nameInvalid || undefined}
            disabled={controlsDisabled}
            className="h-8 w-40 font-mono text-xs"
          />
          <Input
            type="password"
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
            placeholder={t('settings.environment.editor.valuePlaceholder')}
            aria-label={t('settings.environment.editor.valueAria')}
            disabled={controlsDisabled}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="submit"
            variant="outline"
            size="xs"
            disabled={controlsDisabled || !trimmedName || nameInvalid}
            className="shrink-0 !font-normal"
          >
            <Icon name="add" className="h-3.5 w-3.5" />
            {t('settings.environment.editor.add')}
          </Button>
        </div>
        {nameInvalid ? (
          <p className="typography-meta text-[var(--status-error)]">{t('settings.environment.editor.invalidName')}</p>
        ) : null}
      </form>
    </div>
  );
};
