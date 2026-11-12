import React from 'react';

import { CommandItem } from '@/components/ui/command';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { splitSnippet, type MessageSearchHit, type MessageSearchRole } from '@/lib/messageSearch';
import type { IconName } from '@/components/icon/icons';

const ROLE_ICON: Record<MessageSearchRole, IconName> = {
  user: 'user-3',
  assistant: 'chat-ai-3',
  reasoning: 'brain-ai-3',
};

export type MessageAuthor = 'any' | 'user' | 'assistant' | 'reasoning';

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
        className="me-2 mt-0.5 h-4 w-4 shrink-0"
        role="img"
        aria-hidden={false}
        aria-label={roleLabel}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-foreground"><MatchHighlight segments={splitSnippet(hit.snippet)} /></span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground typography-micro">
          {hit.role === 'reasoning' ? <span className="shrink-0">{t('commandPalette.messages.inReasoning')} ·</span> : null}
          <span className="min-w-0 truncate">{title}</span>
          {projectLabel ? <span className="max-w-[40%] shrink-0 truncate">· {projectLabel}</span> : null}
          {hit.archived ? <span className="shrink-0">· {t('search.omni.result.archivedTag')}</span> : null}
          <span className="shrink-0">· {formatHitDate(hit.createdAt)}</span>
        </span>
      </span>
    </CommandItem>
  );
};
