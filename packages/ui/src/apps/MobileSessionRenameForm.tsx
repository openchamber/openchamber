import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Inline title editor shown in place of a mobile session row's content while
    renaming. Mirrors the desktop sidebar rename: a bare transparent input at
    the row's own typography (no bordered field — the row keeps its exact
    height) with explicit save/cancel icon buttons. */
export const MobileSessionRenameForm: React.FC<{
  initialTitle: string;
  /** Left padding, so the input starts where the row's title did. */
  indent: number;
  /** Extra classes for the form; multi-line rows pin their own height. */
  className?: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}> = ({ initialTitle, indent, className, onSubmit, onCancel }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initialTitle);

  // Opens with the whole title selected, so the first keystroke replaces it.
  // Stable ref callback: an inline one would re-run on every render and
  // re-select the text mid-edit.
  const focusRenameInput = React.useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    if (!next || next === initialTitle.trim()) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <form
      // Fixed 36px: the session row's real height is NOT Tailwind's min-h-10 —
      // mobile.css's global button touch-target rule (min-height: 36px) wins
      // that specificity fight, so single-line rows resolve to 36px. Pin the
      // rename state to the same 36px.
      className={cn('flex h-9 min-w-0 flex-1 items-center gap-2 pr-2', className)}
      style={{ paddingLeft: indent }}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        ref={focusRenameInput}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => handleSessionRenameKeyDown(event, onCancel)}
        aria-label={t('sessions.sidebar.session.rename.save')}
        placeholder={t('sessions.sidebar.session.menu.rename')}
        // 16px prevents the iOS focus zoom; the bare input keeps the row height.
        // The inline min-height overrides mobile.css's global 36px input
        // floor, which otherwise makes the rename row taller than the 40px
        // session row.
        className="min-w-0 flex-1 bg-transparent text-[16px] typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
        style={{ minHeight: 0 }}
        enterKeyHint="done"
      />
      <button
        type="submit"
        aria-label={t('sessions.sidebar.session.rename.save')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // Inline mins beat mobile.css's global 36px button touch-target floor
        // so the controls fit the 40px row.
        style={{ touchAction: 'manipulation', minHeight: 0, minWidth: 0 }}
      >
        <Icon name="check" className="size-4" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('sessions.sidebar.session.rename.cancel')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ touchAction: 'manipulation', minHeight: 0, minWidth: 0 }}
      >
        <Icon name="close" className="size-4" />
      </button>
    </form>
  );
};
