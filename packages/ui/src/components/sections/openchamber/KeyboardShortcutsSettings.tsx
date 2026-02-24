import React from 'react';
import { ButtonSmall } from '@/components/ui/button-small';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiInformationLine } from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  isRiskyBrowserShortcut,
  keyToShortcutToken,
  normalizeCombo,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
} from '@/lib/shortcuts';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

const keyboardEventToCombo = (event: React.KeyboardEvent<HTMLInputElement>): ShortcutCombo | null => {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) {
    return null;
  }

  const parts: string[] = [];

  if (event.metaKey || event.ctrlKey) {
    parts.push('mod');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  if (event.altKey) {
    parts.push('alt');
  }

  const keyToken = keyToShortcutToken(event.key);
  if (!keyToken) {
    return null;
  }

  parts.push(keyToken);
  return normalizeCombo(parts.join('+'));
};

export const KeyboardShortcutsSettings: React.FC = () => {
  const {
    shortcutOverrides,
    setShortcutOverride,
    clearShortcutOverride,
    resetAllShortcutOverrides,
  } = useUIStore();

  const actions = React.useMemo(() => getCustomizableShortcutActions(), []);

  const [capturingActionId, setCapturingActionId] = React.useState<string | null>(null);
  const [draftByAction, setDraftByAction] = React.useState<Record<string, ShortcutCombo>>({});
  const [errorText, setErrorText] = React.useState<string>('');
  const [warningText, setWarningText] = React.useState<string>('');
  const [pendingOverwrite, setPendingOverwrite] = React.useState<{
    actionId: string;
    combo: ShortcutCombo;
    conflictActionId: string;
  } | null>(null);

  const findConflict = React.useCallback((actionId: string, combo: ShortcutCombo): string | null => {
    const normalized = normalizeCombo(combo);
    for (const action of actions) {
      if (action.id === actionId) {
        continue;
      }
      const existing = getEffectiveShortcutCombo(action.id, shortcutOverrides);
      if (normalizeCombo(existing) === normalized) {
        return action.id;
      }
    }
    return null;
  }, [actions, shortcutOverrides]);

  const saveCombo = React.useCallback((actionId: string, combo: ShortcutCombo) => {
    const normalized = normalizeCombo(combo);
    const conflictActionId = findConflict(actionId, normalized);
    if (conflictActionId) {
      setPendingOverwrite({ actionId, combo: normalized, conflictActionId });
      setErrorText('');
      return;
    }

    setShortcutOverride(actionId, normalized);
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText(isRiskyBrowserShortcut(normalized) ? 'This shortcut can conflict with browser defaults. It is still saved.' : '');
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[actionId];
      return rest;
    });
  }, [findConflict, setShortcutOverride]);

  const confirmOverwrite = React.useCallback(() => {
    if (!pendingOverwrite) {
      return;
    }

    setShortcutOverride(pendingOverwrite.conflictActionId, UNASSIGNED_SHORTCUT);
    setShortcutOverride(pendingOverwrite.actionId, pendingOverwrite.combo);
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText(isRiskyBrowserShortcut(pendingOverwrite.combo) ? 'This shortcut can conflict with browser defaults. It is still saved.' : '');
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[pendingOverwrite.actionId];
      return rest;
    });
  }, [pendingOverwrite, setShortcutOverride]);

  const resetOne = React.useCallback((actionId: string) => {
    clearShortcutOverride(actionId);
    setDraftByAction((current) => {
      const rest = { ...current };
      delete rest[actionId];
      return rest;
    });
    setPendingOverwrite(null);
    setErrorText('');
    setWarningText('');
  }, [clearShortcutOverride]);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">Keyboard Shortcuts</h3>
          <ButtonSmall
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => {
              resetAllShortcutOverrides();
              setDraftByAction({});
              setPendingOverwrite(null);
              setErrorText('');
              setWarningText('');
            }}
          >
            Reset All
          </ButtonSmall>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              Capture a new key combo, save it, and bindings will update immediately.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {(errorText || warningText || pendingOverwrite) && (
        <div className="mb-2 space-y-2 px-1">
          {pendingOverwrite && (
            <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className="typography-meta text-foreground">
                This combo is already used by another shortcut. Overwrite and clear that other mapping?
              </span>
              <div className="flex gap-2 shrink-0">
                <ButtonSmall type="button" size="xs" className="!font-normal" onClick={confirmOverwrite}>Overwrite</ButtonSmall>
                <ButtonSmall type="button" size="xs" className="!font-normal" variant="ghost" onClick={() => setPendingOverwrite(null)}>Cancel</ButtonSmall>
              </div>
            </div>
          )}
          {errorText && (
            <div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-foreground">
              {errorText}
            </div>
          )}
          {warningText && (
            <div className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 typography-meta text-foreground">
              {warningText}
            </div>
          )}
        </div>
      )}

      <section className="px-2 pb-2 pt-0 space-y-0.5">
        {actions.map((action, index) => {
          const effective = getEffectiveShortcutCombo(action.id, shortcutOverrides);
          const draft = draftByAction[action.id];
          const displayCombo = draft ?? effective;
          const hasDraft = typeof draft === 'string' && normalizeCombo(draft) !== normalizeCombo(effective);

          return (
            <div key={action.id} className={cn("flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">{action.label}</span>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                <Input
                  readOnly
                  value={capturingActionId === action.id ? 'Press keys...' : formatShortcutForDisplay(displayCombo)}
                  onFocus={() => {
                    setCapturingActionId(action.id);
                    setErrorText('');
                  }}
                  onBlur={() => {
                    if (capturingActionId === action.id) {
                      setCapturingActionId(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (event.key === 'Escape') {
                      setCapturingActionId(null);
                      return;
                    }

                    const combo = keyboardEventToCombo(event);
                    if (!combo) {
                      return;
                    }

                    setDraftByAction((current) => ({
                      ...current,
                      [action.id]: combo,
                    }));
                    setCapturingActionId(null);
                    setPendingOverwrite(null);
                    setErrorText('');
                  }}
                  className="h-7 w-40 min-w-0 typography-ui-label text-center"
                />
                <ButtonSmall
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="!font-normal"
                  onClick={() => {
                    const next = draftByAction[action.id];
                    if (!next) {
                      setErrorText('Capture a shortcut first.');
                      return;
                    }
                    saveCombo(action.id, next);
                  }}
                  disabled={!hasDraft}
                >
                  Save
                </ButtonSmall>
                <ButtonSmall type="button" size="xs" className="!font-normal" variant="ghost" onClick={() => resetOne(action.id)}>
                  Reset
                </ButtonSmall>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
};
