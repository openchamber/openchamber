import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  formatShortcutForDisplay,
  getShortcutBindingConflicts,
  isRiskyBrowserShortcut,
  keyToShortcutToken,
  resolveShortcutEventKey,
  normalizeCombo,
  type ShortcutActionId,
  type ShortcutBindingConflict,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);
const MAX_SHORTCUT_KEY_COUNT = 3;
const SECOND_CHORD_TIMEOUT_MS = 3000;

interface RecordingKeyboardEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
}

interface ShortcutRecordingState {
  chords: ShortcutCombo[];
  livePreview: ShortcutCombo | null;
  settled: boolean;
}

interface ShortcutRecordingDialogProps {
  action: CustomizableShortcutAction | null;
  overrides: Record<string, string>;
  onSave: (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => void;
  onOpenChange: (open: boolean) => void;
}

function getPhysicalKeyCount(
  event: Pick<RecordingKeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  includeEventKey = false,
): number {
  const keys = new Set<string>();
  if (event.altKey) keys.add('alt');
  if (event.ctrlKey) keys.add('control');
  if (event.metaKey) keys.add('meta');
  if (event.shiftKey) keys.add('shift');
  if (includeEventKey) keys.add(event.key.toLowerCase());
  return keys.size;
}

function isCustomizableConflict(
  conflict: ShortcutBindingConflict,
): conflict is ShortcutBindingConflict & { action: CustomizableShortcutAction } {
  return conflict.action.customizable;
}

function getModifierPreview(event: RecordingKeyboardEvent): ShortcutCombo | null {
  if (getPhysicalKeyCount(event) > MAX_SHORTCUT_KEY_COUNT) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

function keyboardEventToCombo(event: RecordingKeyboardEvent): ShortcutCombo | null {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  if (getPhysicalKeyCount(event, true) > MAX_SHORTCUT_KEY_COUNT) return null;

  const key = keyToShortcutToken(resolveShortcutEventKey(event));
  if (!key) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(key);
  return normalizeCombo(parts.join('+'));
}

function modifierKeyUpToCombo(event: React.KeyboardEvent<HTMLDivElement>): ShortcutCombo | null {
  const key = event.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;
  if (getPhysicalKeyCount(event, true) > MAX_SHORTCUT_KEY_COUNT) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey || key === 'meta' || key === 'control') parts.push('mod');
  if (event.shiftKey || key === 'shift') parts.push('shift');
  if (event.altKey || key === 'alt') parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

// eslint-disable-next-line react-refresh/only-export-components -- tested pure recording state transition
export function settleShortcutRecordingState(state: ShortcutRecordingState): ShortcutRecordingState {
  return state.chords.length > 0 ? { ...state, livePreview: null, settled: true } : state;
}

// eslint-disable-next-line react-refresh/only-export-components -- tested pure recording state transition
export function updateShortcutRecordingState(
  state: ShortcutRecordingState,
  event: RecordingKeyboardEvent,
  phase: 'keydown' | 'keyup',
): ShortcutRecordingState {
  if (event.repeat || event.isComposing) return state;
  if (phase === 'keyup') {
    return { ...state, livePreview: getModifierPreview(event) };
  }

  if (event.key === 'Backspace') {
    return { chords: state.chords.slice(0, -1), livePreview: null, settled: false };
  }

  const chord = keyboardEventToCombo(event);
  if (chord) {
    if (state.settled) {
      return { chords: [chord], livePreview: null, settled: false };
    }
    const chords = state.chords.length < 2 ? [...state.chords, chord] : state.chords;
    return {
      chords,
      livePreview: null,
      settled: chords.length === 2,
    };
  }

  return { ...state, livePreview: getModifierPreview(event) };
}

export const ShortcutRecordingDialog: React.FC<ShortcutRecordingDialogProps> = ({
  action,
  overrides,
  onSave,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const actionLabel = (shortcut: CustomizableShortcutAction) => t(shortcut.settingsLabelKey);
  const conflictActionLabel = (conflict: ShortcutBindingConflict) => (
    conflict.action.customizable
      ? actionLabel(conflict.action)
      : formatShortcutForDisplay(conflict.action.defaultBinding)
  );
  const [recording, setRecording] = React.useState<ShortcutRecordingState>({ chords: [], livePreview: null, settled: false });
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!action) return;
    setRecording({ chords: [], livePreview: null, settled: false });
    recordingRef.current?.focus();
  }, [action]);

  const waitingForSecondChord = recording.chords.length === 1 && !recording.settled;

  React.useEffect(() => {
    if (!waitingForSecondChord) return;
    const timeout = window.setTimeout(
      () => setRecording(settleShortcutRecordingState),
      SECOND_CHORD_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [waitingForSecondChord]);

  const combo = normalizeCombo(recording.chords.join(' '));
  const conflicts = React.useMemo(
    () => action && combo ? getShortcutBindingConflicts(action.id, combo, overrides) : [],
    [action, combo, overrides],
  );
  const protectedConflict = conflicts.find((conflict) => (
    !conflict.action.customizable && conflict.kind !== 'contextual-prefix'
  ));
  const customizableConflicts = conflicts.filter(isCustomizableConflict);
  const prefixConflict = customizableConflicts.find((conflict) => conflict.kind === 'prefix');
  const exactConflict = customizableConflicts.find((conflict) => conflict.kind === 'exact');
  const contextualPrefixConflict = conflicts.find((conflict) => conflict.kind === 'contextual-prefix');

  const close = () => onOpenChange(false);
  const confirm = () => {
    if (!recording.settled) setRecording(settleShortcutRecordingState);
    if (!action || !combo || protectedConflict || prefixConflict) return;
    onSave(action.id, combo, exactConflict?.action.id);
    close();
  };
  const handleRecordingEvent = (event: React.KeyboardEvent<HTMLDivElement>, phase: 'keydown' | 'keyup') => {
    event.preventDefault();
    event.stopPropagation();

    const isPrefixStyleAction = Boolean(action && 'prefixStyle' in action && action.prefixStyle);
    if (phase === 'keyup' && isPrefixStyleAction && recording.chords.length === 0) {
      const modifierCombo = modifierKeyUpToCombo(event);
      if (modifierCombo) {
        setRecording({ chords: [modifierCombo], livePreview: null, settled: true });
        return;
      }
    }
    const nextRecording = updateShortcutRecordingState(recording, {
      altKey: event.altKey,
      code: event.nativeEvent.code,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
    }, phase);
    setRecording(isPrefixStyleAction && nextRecording.chords.length > 1
      ? recording
      : nextRecording);
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open, eventDetails) => {
        if (!open) {
          eventDetails.cancel();
        }
      }}
    >
      <DialogContent className="max-w-md" initialFocus={recordingRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {action ? t('settings.openchamber.keyboardShortcuts.dialog.title', { action: actionLabel(action) }) : ''}
          </DialogTitle>
          <DialogDescription>{t('settings.openchamber.keyboardShortcuts.dialog.instructions')}</DialogDescription>
        </DialogHeader>

        <div
          className="flex min-h-28 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] px-4 py-5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          ref={recordingRef}
          onKeyDown={(event) => handleRecordingEvent(event, 'keydown')}
          onKeyUp={(event) => handleRecordingEvent(event, 'keyup')}
          onBlur={() => setRecording((current) => ({ ...current, livePreview: null }))}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            {recording.chords.map((chord, index) => (
              <kbd key={`${chord}-${index}`} className="rounded-md border border-border bg-muted px-3 py-2 typography-ui-label font-mono text-foreground">
                {formatShortcutForDisplay(chord)}
              </kbd>
            ))}
            {recording.livePreview ? (
              <kbd className="rounded-md border border-dashed border-border bg-muted px-3 py-2 typography-ui-label font-mono text-muted-foreground">
                {formatShortcutForDisplay(recording.livePreview)}
              </kbd>
            ) : null}
            {recording.chords.length === 0 && !recording.livePreview ? (
              <span className="typography-ui-label text-muted-foreground">
                {t('settings.openchamber.keyboardShortcuts.dialog.recording')}
              </span>
            ) : null}
          </div>
        </div>

        {recording.settled && protectedConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.internalConflict')}
          </p>
        ) : recording.settled && prefixConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.prefixConflict', { action: actionLabel(prefixConflict.action) })}
          </p>
        ) : null}
        {recording.settled && exactConflict && !protectedConflict && !prefixConflict ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.error.exactConflict', { action: actionLabel(exactConflict.action) })}
          </p>
        ) : null}
        {recording.settled && contextualPrefixConflict && !protectedConflict && !prefixConflict ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.warning.contextualPrefix', {
              action: conflictActionLabel(contextualPrefixConflict),
            })}
          </p>
        ) : null}
        {recording.settled && combo && isRiskyBrowserShortcut(combo) ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut')}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!combo || (recording.settled && (Boolean(protectedConflict) || Boolean(prefixConflict)))}
            onClick={confirm}
          >
            {t('settings.openchamber.keyboardShortcuts.actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
