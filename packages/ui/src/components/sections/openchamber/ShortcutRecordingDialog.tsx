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
import { isMacOS } from '@/lib/utils';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);
const DEFAULT_MAX_KEY_COUNT = 3;
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
  /** Maximum number of chords in the sequence. OS-level global shortcuts only support one. @default 2 */
  maxChords?: number;
  /**
   * Most keys held at once, modifiers included. In-app shortcuts stay at three;
   * a global shortcut needs room for all four modifiers plus a key (a "hyper"
   * key sends Ctrl+Shift+Cmd+Option). @default 3
   */
  maxKeys?: number;
}

interface RecordingOptions {
  maxKeys: number;
  /** On macOS Control and Command are separate keys and record separately. */
  macModifiers: boolean;
}

const DEFAULT_RECORDING_OPTIONS: RecordingOptions = { maxKeys: DEFAULT_MAX_KEY_COUNT, macModifiers: isMacOS() };

// `mod` is Command on macOS and Control elsewhere. On macOS a held Control is
// its own `ctrl` modifier, so Ctrl+N never records as Cmd+N; elsewhere Meta is
// the Windows / Super key and records as `super`, never as Control.
function modifierParts(
  event: Pick<RecordingKeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  { macModifiers }: RecordingOptions,
): string[] {
  const parts: string[] = [];
  if (macModifiers) {
    if (event.metaKey) parts.push('mod');
    if (event.ctrlKey) parts.push('ctrl');
  } else {
    if (event.ctrlKey) parts.push('mod');
    if (event.metaKey) parts.push('super');
  }
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  return parts;
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

function getModifierPreview(event: RecordingKeyboardEvent, options: RecordingOptions): ShortcutCombo | null {
  if (getPhysicalKeyCount(event) > options.maxKeys) return null;
  const parts = modifierParts(event, options);
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

function keyboardEventToCombo(event: RecordingKeyboardEvent, options: RecordingOptions): ShortcutCombo | null {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  if (getPhysicalKeyCount(event, true) > options.maxKeys) return null;

  const key = keyToShortcutToken(resolveShortcutEventKey(event));
  if (!key) return null;

  return normalizeCombo([...modifierParts(event, options), key].join('+'));
}

function modifierKeyUpToCombo(event: React.KeyboardEvent<HTMLDivElement>, options: RecordingOptions): ShortcutCombo | null {
  const key = event.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;
  if (getPhysicalKeyCount(event, true) > options.maxKeys) return null;

  // The released modifier no longer shows in the event's flags; count it as held.
  const parts = modifierParts({
    metaKey: event.metaKey || key === 'meta',
    ctrlKey: event.ctrlKey || key === 'control',
    shiftKey: event.shiftKey || key === 'shift',
    altKey: event.altKey || key === 'alt',
  }, options);
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
  maxChords = 2,
  options: Partial<RecordingOptions> = {},
): ShortcutRecordingState {
  const recordingOptions = { ...DEFAULT_RECORDING_OPTIONS, ...options };
  if (event.repeat || event.isComposing) return state;
  if (phase === 'keyup') {
    return { ...state, livePreview: getModifierPreview(event, recordingOptions) };
  }

  if (event.key === 'Backspace') {
    return { chords: state.chords.slice(0, -1), livePreview: null, settled: false };
  }

  const chord = keyboardEventToCombo(event, recordingOptions);
  if (chord) {
    if (state.settled) {
      const chords = [chord];
      return { chords, livePreview: null, settled: chords.length >= maxChords };
    }
    const chords = state.chords.length < maxChords ? [...state.chords, chord] : state.chords;
    return {
      chords,
      livePreview: null,
      settled: chords.length >= maxChords,
    };
  }

  return { ...state, livePreview: getModifierPreview(event, recordingOptions) };
}

export const ShortcutRecordingDialog: React.FC<ShortcutRecordingDialogProps> = ({
  action,
  overrides,
  onSave,
  onOpenChange,
  maxChords = 2,
  maxKeys = DEFAULT_MAX_KEY_COUNT,
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
      const modifierCombo = modifierKeyUpToCombo(event, { ...DEFAULT_RECORDING_OPTIONS, maxKeys });
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
    }, phase, maxChords, { maxKeys });
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
          <DialogDescription>{t(maxChords === 1 ? 'settings.openchamber.keyboardShortcuts.dialog.instructionsSingle' : 'settings.openchamber.keyboardShortcuts.dialog.instructions')}</DialogDescription>
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
              <kbd key={`${chord}-${index}`} className="rounded-md border border-border bg-muted px-3 py-2 typography-ui-label text-foreground">
                {formatShortcutForDisplay(chord)}
              </kbd>
            ))}
            {recording.livePreview ? (
              <kbd className="rounded-md border border-dashed border-border bg-muted px-3 py-2 typography-ui-label text-muted-foreground">
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
