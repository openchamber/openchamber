import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isValidSnippetName, normalizeSnippetNameInput } from '@/lib/snippetNames';
import { cn } from '@/lib/utils';

interface SnippetAliasesFieldProps {
  aliases: string[];
  onChange: (aliases: string[]) => void;
  className?: string;
}

/**
 * Aliases as chips. Enter, comma or space adds the typed alias, Backspace in
 * an empty field takes the last one back, and leaving the field keeps what
 * was typed.
 */
export const SnippetAliasesField: React.FC<SnippetAliasesFieldProps> = ({ aliases, onChange, className }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Adds the valid, new ones among `candidates` and keeps `rest` in the field.
  const add = (candidates: string[], rest = '') => {
    setDraft(rest);
    const next = [...aliases];
    for (const candidate of candidates) {
      if (isValidSnippetName(candidate) && !next.some((alias) => alias.toLowerCase() === candidate.toLowerCase())) next.push(candidate);
    }
    if (next.length !== aliases.length) onChange(next);
  };

  return (
    <div
      className={cn(
        'oc-surface-elevated oc-raised oc-field flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md bg-[var(--surface-elevated)] px-1.5 py-1',
        className,
      )}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {aliases.map((alias) => (
        <span key={alias} className="oc-tile-inset flex h-6 max-w-full items-center gap-0.5 rounded ps-1.5 pe-0.5 typography-meta text-foreground">
          <span className="truncate">#{alias}</span>
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t('settings.snippets.page.field.aliasRemove', { alias })}
            onClick={() => onChange(aliases.filter((existing) => existing !== alias))}
          >
            <Icon name="close" className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => {
          // A comma or a space ends an alias, typed or pasted.
          const parts = event.target.value.split(/[,\s]+/).map(normalizeSnippetNameInput);
          const rest = parts.pop() ?? '';
          if (parts.length > 0) add(parts, rest);
          else setDraft(rest);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft) {
            event.preventDefault();
            add([draft]);
            return;
          }
          if (event.key === 'Backspace' && !draft && aliases.length > 0) {
            event.preventDefault();
            onChange(aliases.slice(0, -1));
          }
        }}
        onBlur={() => { if (draft) add([draft]); }}
        placeholder={aliases.length === 0 ? t('settings.snippets.page.field.aliasPlaceholder') : undefined}
        aria-label={t('settings.snippets.page.field.aliases')}
        className="h-6 min-w-[8ch] flex-1 bg-transparent px-1 typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
};
