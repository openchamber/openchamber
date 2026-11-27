import React from 'react';

import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { useEmojiPicker } from '@/components/emoji/useEmojiPicker';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { appendKnowledgeDraft, knowledgeFieldKey, knowledgePanelKey, useKnowledgeDraft, type KnowledgeDraftKind } from '@/hooks/useKnowledgeDraft';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';
import { useI18n } from '@/lib/i18n';

const COUNTER_THRESHOLD = 0.8;

export const KnowledgeComposer: React.FC<{
  placeholder: string;
  addLabel: string;
  maxLength: number;
  projectPath: string;
  draftKind: KnowledgeDraftKind;
  multiline?: boolean;
  dictation?: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => Promise<boolean> | boolean;
  extraActions?: React.ReactNode;
}> = ({ placeholder, addLabel, maxLength, projectPath, draftKind, multiline = false, dictation = true, disabled = false, onSubmit, extraActions }) => {
  const { t } = useI18n();
  const { identity, text, setText, takeForAdd } = useKnowledgeDraft(projectPath, draftKind);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useEmojiPicker(fieldRef);
  const isMobile = useUIStore((state) => state.isMobile);
  const [submitting, setSubmitting] = React.useState(false);

  const normalize = React.useCallback((value: string) => (
    (multiline ? value : value.replace(/\r?\n/g, ' ')).slice(0, maxLength)
  ), [maxLength, multiline]);

  const submit = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    const putBack = takeForAdd(trimmed);
    setSubmitting(true);
    try {
      if (!await onSubmit(trimmed)) putBack();
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, submitting, takeForAdd, text]);

  const showCounter = text.length >= maxLength * COUNTER_THRESHOLD;
  const blocked = disabled || submitting;
  const canSend = !blocked && text.trim().length > 0;

  return (
    <div
      className={cn(
        'flex items-end gap-1 py-1 pe-1',
        isMobile ? 'border-b border-edge-muted ps-1' : 'oc-surface-elevated oc-raised oc-field rounded-lg bg-[var(--surface-elevated)] ps-3',
        disabled && 'opacity-50',
      )}
    >
      <textarea
        ref={fieldRef}
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
          isMobile ? 'typography-meta' : 'typography-markdown md:typography-ui-label',
          'block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 text-foreground outline-none placeholder:text-muted-foreground',
          multiline ? 'max-h-[calc(12lh+0.25rem)]' : 'max-h-[calc(6lh+0.25rem)]',
          'focus-visible:outline-none disabled:cursor-not-allowed',
        )}
      />
      {emojiPicker}
      {showCounter ? (
        <span className="flex h-6 flex-shrink-0 items-center typography-micro text-muted-foreground" dir="auto">
          {text.length}/{maxLength}
        </span>
      ) : null}
      {dictation ? (
        <InlineDictationButton
          fieldKey={knowledgeFieldKey(identity)}
          panelKey={knowledgePanelKey(projectPath)}
          onTranscript={(spoken) => appendKnowledgeDraft(identity, (current) => (
            normalize(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken)
          ))}
          disabled={disabled}
          buttonClassName={KNOWLEDGE_ICON_BUTTON_CLASS}
        />
      ) : null}
      {extraActions}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        className={cn(
          'inline-flex h-6 flex-shrink-0 items-center rounded-md px-1.5 typography-ui-label font-medium transition-colors',
          'focus-visible:outline-none disabled:cursor-not-allowed',
          canSend ? 'text-[var(--primary-text)] hover:bg-interactive-hover' : 'text-muted-foreground opacity-50',
        )}
        aria-label={addLabel}
      >
        {t('rightSidebar.contextNotesTodo.composer.add')}
      </button>
    </div>
  );
};
