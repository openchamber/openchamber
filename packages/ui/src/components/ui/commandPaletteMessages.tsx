import React from 'react';

import { CommandItem } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { splitSnippet, type MessageSearchHit, type MessageSearchRole } from '@/lib/messageSearch';
import type { IconName } from '@/components/icon/icons';

const ROLE_ICON: Record<MessageSearchRole, IconName> = {
  user: 'user-3',
  assistant: 'chat-ai-3',
  reasoning: 'brain-ai-3',
};

export type MessageScope = 'all' | 'project';
export type MessageAuthor = 'any' | 'user' | 'assistant' | 'reasoning';

/** Matches in a snippet, marked; the text is plain, never markup. */
const MessageSnippet: React.FC<{ snippet: string }> = ({ snippet }) => (
  <>
    {splitSnippet(snippet).map((segment, index) => (segment.match
      ? <mark key={index} className="rounded-[2px] bg-primary/25 text-foreground">{segment.text}</mark>
      : <React.Fragment key={index}>{segment.text}</React.Fragment>))}
  </>
);

const formatHitDate = (createdAt: number): string => {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
};

export const MessageHitItem: React.FC<{
  hit: MessageSearchHit;
  projectLabel: string | null;
  onSelect: (hit: MessageSearchHit) => void;
}> = ({ hit, projectLabel, onSelect }) => {
  const { t } = useI18n();
  const title = hit.sessionTitle || t('commandPalette.session.untitled');
  const roleLabel = hit.role === 'user'
    ? t('commandPalette.messages.byYou')
    : hit.role === 'reasoning' ? t('commandPalette.messages.inReasoning') : t('commandPalette.messages.byAgent');
  return (
    // A reply and its reasoning are two hits of one message.
    <CommandItem value={`message:${hit.role}:${hit.id}`} onSelect={() => onSelect(hit)} className="items-start">
      <Icon
        name={ROLE_ICON[hit.role]}
        className="mr-2 mt-0.5 h-4 w-4 shrink-0"
        role="img"
        aria-hidden={false}
        aria-label={roleLabel}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-foreground"><MessageSnippet snippet={hit.snippet} /></span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground typography-micro">
          {hit.role === 'reasoning' ? <span className="shrink-0">{t('commandPalette.messages.inReasoning')} ·</span> : null}
          <span className="min-w-0 truncate">{title}</span>
          {projectLabel ? <span className="max-w-[40%] shrink-0 truncate">· {projectLabel}</span> : null}
          <span className="shrink-0">· {formatHitDate(hit.createdAt)}</span>
        </span>
      </span>
    </CommandItem>
  );
};

type ChipOption<T extends string> = { value: T; label: string };

const ChipRow = <T extends string>({ options, value, onChange, label }: {
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) => (
  <div className="flex items-center gap-1" role="group" aria-label={label}>
    {options.map((option) => (
      <Button
        key={option.value}
        type="button"
        variant="chip"
        size="xs"
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </Button>
    ))}
  </div>
);

/** The messages mode's header: back to everything, then where and who. */
export const MessageSearchFilters: React.FC<{
  scope: MessageScope;
  onScopeChange: (scope: MessageScope) => void;
  projectScopeAvailable: boolean;
  author: MessageAuthor;
  onAuthorChange: (author: MessageAuthor) => void;
  /** Reasoning is indexed and shown in the chat. */
  reasoningAvailable: boolean;
  onBack: () => void;
}> = ({ scope, onScopeChange, projectScopeAvailable, author, onAuthorChange, reasoningAvailable, onBack }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2 py-1.5">
      <Button type="button" variant="ghost" size="xs" onClick={onBack}>
        <Icon name="arrow-left" className="h-3.5 w-3.5" />
        {t('commandPalette.messages.back')}
      </Button>
      {projectScopeAvailable ? (
        <ChipRow
          label={t('commandPalette.messages.filter.scopeLabel')}
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: 'all', label: t('commandPalette.messages.filter.allProjects') },
            { value: 'project', label: t('commandPalette.messages.filter.thisProject') },
          ]}
        />
      ) : null}
      <ChipRow
        label={t('commandPalette.messages.filter.authorLabel')}
        value={author}
        onChange={onAuthorChange}
        options={[
          { value: 'any', label: t('commandPalette.messages.filter.anyone') },
          { value: 'user', label: t('commandPalette.messages.filter.you') },
          { value: 'assistant', label: t('commandPalette.messages.filter.agent') },
          ...(reasoningAvailable ? [{ value: 'reasoning' as const, label: t('commandPalette.messages.filter.reasoning') }] : []),
        ]}
      />
    </div>
  );
};
