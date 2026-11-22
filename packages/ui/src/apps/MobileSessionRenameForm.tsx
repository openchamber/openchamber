import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import type { useSessionAiRenameAction } from '@/components/session/useSessionAiRenameAction';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const MobileSessionRenameForm: React.FC<{
  initialTitle: string;
  indent: number;
  className?: string;
  aiRename?: ReturnType<typeof useSessionAiRenameAction>;
  placeholder?: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}> = ({ initialTitle, indent, className, aiRename, placeholder, onSubmit, onCancel }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(initialTitle);

  const focusRenameInput = React.useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    if ((!next && aiRename) || next === initialTitle.trim()) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <form
      className={cn('flex h-9 min-w-0 flex-1 items-center gap-2 pe-2', className)}
      style={{ paddingInlineStart: indent }}
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
        placeholder={placeholder ?? t('sessions.sidebar.session.menu.rename')}
        className="min-w-0 flex-1 bg-transparent text-[16px] typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
        style={{ minHeight: 0 }}
        enterKeyHint="done"
      />
      {aiRename ? <button
        type="button"
        disabled={aiRename.disabled}
        onClick={() => { aiRename.run(); onCancel(); }}
        aria-label={t('sessions.aiRename.action')}
        aria-description={aiRename.hint}
        title={aiRename.hint}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ touchAction: 'manipulation', minHeight: 0, minWidth: 0 }}
      >
        <Icon name="ai-generate-2" className="size-4" />
      </button> : null}
      <button
        type="submit"
        aria-label={t('sessions.sidebar.session.rename.save')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
