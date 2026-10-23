import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionDraftsStore, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import { openSessionDraft } from './openSessionDraft';

type Props = {
  draft: SessionDraft;
  depth: number;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  setSessionSwitcherOpen: (open: boolean) => void;
};

/**
 * A new session's draft the user left before sending: a pen in the slot, the
 * start of what they typed, and a cross that throws it away. A click opens it
 * in the composer, where it goes on as the same draft.
 */
export function SessionDraftRow({ draft, depth, alwaysShowActions, mobileVariant, setSessionSwitcherOpen }: Props): React.ReactNode {
  const { t } = useI18n();
  const firstLine = draft.text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  const attachmentCount = draft.attachments.length;
  const label = firstLine || (attachmentCount === 1
    ? t('sessions.sidebar.draft.attachmentsSingle', { count: attachmentCount })
    : t('sessions.sidebar.draft.attachmentsPlural', { count: attachmentCount }));
  const open = (): void => {
    if (mobileVariant) setSessionSwitcherOpen(false);
    void openSessionDraft(draft).then((complete) => {
      if (!complete) toast.error(t('sessions.sidebar.draft.attachmentsMissing'));
    });
  };
  const discard = (event: React.MouseEvent): void => {
    event.stopPropagation();
    void useSessionDraftsStore.getState().discard(draft.id, { final: true }).catch(() => toast.error(t('sessions.sidebar.draft.discardFailed')));
  };

  return (
    <div
      style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
      className="group/draft relative my-0.5 flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pe-2.5 hover:bg-interactive-hover/60"
    >
      <span className="inline-flex size-3.5 flex-shrink-0 items-center justify-center text-muted-foreground/70">
        <Icon name="edit" className="h-3 w-3" />
      </span>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          '@container relative flex min-w-0 flex-1 items-center gap-1 focus-visible:outline-none',
          !alwaysShowActions && '[--oc-actions-reserve:0.625rem]',
        )}
        aria-label={t('sessions.sidebar.draft.openAria', { label })}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          open();
        }}
      >
        <span
          dir="auto"
          className={cn(
            'oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label italic text-muted-foreground',
            !alwaysShowActions && 'group-hover/draft:oc-actions-mask group-has-[:focus-visible]/draft:oc-actions-mask',
          )}
        >
          {label}
        </span>
        <span className={cn(
          'ms-auto flex flex-shrink-0 items-center gap-1',
          alwaysShowActions ? 'pe-7' : 'transition-opacity group-hover/draft:opacity-0 group-has-[:focus-visible]/draft:opacity-0',
        )}>
          {firstLine && attachmentCount > 0 ? <Icon name="attachment-2" className="h-3 w-3 text-muted-foreground/50" /> : null}
        </span>
      </div>
      <div className={cn(
        'absolute inset-e-1 top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity',
        alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/draft:opacity-100 group-has-[:focus-visible]/draft:opacity-100',
      )}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
              )}
              aria-label={t('sessions.sidebar.draft.discard')}
              onClick={discard}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Icon name="close" className={alwaysShowActions ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('sessions.sidebar.draft.discard')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
