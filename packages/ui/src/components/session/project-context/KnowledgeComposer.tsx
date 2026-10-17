import React from 'react';

import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { Icon } from '@/components/icon/Icon';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';

/** The counter appears only once the text gets close to the limit. */
const COUNTER_THRESHOLD = 0.8;

/**
 * The one way every section adds an entry: a single line that grows with its
 * text. Enter adds. A multiline field follows the chat composer: Shift+Enter
 * starts a new line on desktop, and on a phone, whose keyboard has no
 * Shift+Enter, Return starts a new line and the add button adds. A one-line
 * field turns pasted line breaks into spaces.
 *
 * The draft lives here, so dictation can continue it and a failed add can
 * put it back.
 */
export const KnowledgeComposer: React.FC<{
  placeholder: string;
  addLabel: string;
  maxLength: number;
  multiline?: boolean;
  dictation?: boolean;
  disabled?: boolean;
  /** Resolves false when the entry was not added; the text then stays. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  /** Extra controls before the add button, such as an import action. */
  extraActions?: React.ReactNode;
}> = ({ placeholder, addLabel, maxLength, multiline = false, dictation = true, disabled = false, onSubmit, extraActions }) => {
  const [text, setText] = React.useState('');
  const isMobile = useUIStore((state) => state.isMobile);
  const [submitting, setSubmitting] = React.useState(false);

  const normalize = React.useCallback((value: string) => (
    (multiline ? value : value.replace(/\r?\n/g, ' ')).slice(0, maxLength)
  ), [maxLength, multiline]);

  const submit = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    // Cleared at once so the next entry can be typed while this one saves; a
    // failed add puts the text back unless something new was typed meanwhile.
    setText('');
    setSubmitting(true);
    try {
      if (!await onSubmit(trimmed)) {
        setText((current) => (current.trim() ? current : trimmed));
      }
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, submitting, text]);

  const showCounter = text.length >= maxLength * COUNTER_THRESHOLD;
  // The field itself stays enabled while an entry saves: disabling it would
  // drop the focus, and the next entry typed right away would go nowhere.
  const blocked = disabled || submitting;

  return (
    <div
      className={cn(
        'oc-surface-elevated flex items-end gap-1 rounded-lg bg-[var(--surface-elevated)] py-1 pe-1 ps-3',
        'oc-raised oc-field',
        disabled && 'opacity-50',
      )}
    >
      <textarea
        rows={1}
        value={text}
        onChange={(event) => setText(normalize(event.target.value))}
        onKeyDown={(event) => {
          if (isIMECompositionEvent(event)) return;
          if (event.key !== 'Enter') return;
          const modified = event.ctrlKey || event.metaKey;
          const submits = !multiline || modified || (!isMobile && !event.shiftKey);
          if (submits) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={multiline}
        autoComplete="off"
        className={cn(
          'block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 typography-markdown md:typography-ui-label text-foreground outline-none placeholder:text-muted-foreground',
          multiline ? 'max-h-[calc(12lh+0.25rem)]' : 'max-h-[calc(6lh+0.25rem)]',
          'focus-visible:outline-none disabled:cursor-not-allowed',
        )}
      />
      {showCounter ? (
        <span className="flex h-6 flex-shrink-0 items-center typography-micro text-muted-foreground" dir="auto">
          {text.length}/{maxLength}
        </span>
      ) : null}
      {dictation ? (
        // Dictation continues the draft instead of adding it, so a misheard
        // word can be fixed before it lands.
        <InlineDictationButton
          onTranscript={(spoken) => setText((current) => normalize(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken))}
          disabled={disabled}
          buttonClassName={KNOWLEDGE_ICON_BUTTON_CLASS}
        />
      ) : null}
      {extraActions}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={blocked || text.trim().length === 0}
        className={KNOWLEDGE_ICON_BUTTON_CLASS}
        aria-label={addLabel}
        title={addLabel}
      >
        <Icon name="add" className="h-4 w-4" />
      </button>
    </div>
  );
};
