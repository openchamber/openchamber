import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { getLeadDigest, type LeadQuestion } from '@/lib/sessionLead';
import { cn } from '@/lib/utils';
import { useInputStore } from '@/sync/input-store';
import { useSession } from '@/sync/live-session-hooks';
import { answerLeadQuestion, dismissLeadSuggestion } from '@/sync/session-lead';
import { useChatColumnActions } from '../chatColumnSession';
import { useLeadAnswers } from './leadAnswers';

type Translate = ReturnType<typeof useI18n>['t'];

const MINUTE_MS = 60_000;

const relativeTime = (t: Translate, at: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE_MS);
  if (minutes < 1) return t('common.relative.justNow');
  if (minutes < 60) return t('common.relative.minutesAgoShort', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.relative.hoursAgoShort', { count: hours });
  return t('common.relative.daysAgoShort', { count: Math.floor(hours / 24) });
};

const SectionTitle: React.FC<{ waiting?: boolean; children: React.ReactNode }> = ({ waiting = false, children }) => (
  <h3 className={cn('typography-micro font-medium', waiting ? 'text-status-warning' : 'text-muted-foreground')}>{children}</h3>
);

const ItemText: React.FC<{ text: string }> = ({ text }) => (
  <SimpleMarkdownRenderer content={text} className="typography-meta text-foreground [&_p]:my-0" enableFileReferences={false} />
);

const DigestList: React.FC<{ title: string; items: string[] }> = ({ title, items }) => {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <SectionTitle>{title}</SectionTitle>
      <SimpleMarkdownRenderer
        content={items.map((item) => `- ${item}`).join('\n')}
        className="typography-meta text-foreground [&_ul]:my-0 [&_ul]:ps-4"
        enableFileReferences={false}
      />
    </section>
  );
};

type ActionHandlers = {
  answer: (question: string, answer: string) => void;
  reply: (question: string) => void;
  start: (item: string) => void;
  dismiss: (item: string) => void;
};

const QuestionItem: React.FC<{ item: LeadQuestion; answered: string | undefined; sending: boolean; on: ActionHandlers }> = ({ item, answered, sending, on }) => {
  const { t } = useI18n();
  const options = item.recommended ? [item.recommended, ...item.options.filter((option) => option !== item.recommended)] : item.options;
  return (
    <li className="flex flex-col gap-1.5" data-lead-question="">
      <ItemText text={item.question} />
      {answered !== undefined ? (
        <p className="typography-micro text-muted-foreground">{t('chat.leadDigest.answered', { answer: answered })}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((option) => (
            <Button
              key={option}
              size="xs"
              variant={option === item.recommended ? 'default' : 'outline'}
              disabled={sending}
              title={option === item.recommended ? t('chat.leadDigest.recommended') : undefined}
              onClick={() => on.answer(item.question, option)}
            >
              {option}
            </Button>
          ))}
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => on.reply(item.question)}>
            {t('chat.leadDigest.replyInChat')}
          </Button>
        </div>
      )}
    </li>
  );
};

const SuggestionItem: React.FC<{ item: string; on: ActionHandlers }> = ({ item, on }) => {
  const { t } = useI18n();
  return (
    <li className="group/suggestion flex items-start gap-2" data-lead-suggestion="">
      <div className="min-w-0 flex-1 py-0.5"><ItemText text={item} /></div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-focus-within/suggestion:opacity-100 pointer-coarse:opacity-100">
        <Button size="xs" variant="outline" onClick={() => on.start(item)}>{t('chat.leadDigest.start')}</Button>
        <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => on.dismiss(item)}>{t('chat.leadDigest.dismiss')}</Button>
      </div>
    </li>
  );
};

export const LeadDigestRow: React.FC<{ sessionId: string | null; directory: string | undefined }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId, directory);
  const digest = getLeadDigest(session);
  const now = useMinuteTickerNow(digest !== null);
  const answers = useLeadAnswers(sessionId ?? '', directory, digest?.updatedAt ?? Number.POSITIVE_INFINITY);
  const { focusInput } = useChatColumnActions();
  const [open, setOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  if (!digest || !sessionId || !directory) return null;

  const fillComposer = (text: string) => {
    setOpen(false);
    useInputStore.getState().setPendingInputText(text, 'append');
    focusInput();
  };
  const on: ActionHandlers = {
    answer: (question, answer) => {
      setSending(true);
      void answerLeadQuestion(sessionId, directory, question, answer)
        .then(() => setOpen(false), () => toast.error(t('chat.leadDigest.answerFailed')))
        .finally(() => setSending(false));
    },
    reply: (question) => fillComposer(`> ${question}\n\n`),
    start: (item) => fillComposer(item),
    dismiss: (item) => {
      void dismissLeadSuggestion(sessionId, directory, item).catch(() => toast.error(t('chat.leadDigest.dismissFailed')));
    },
  };

  const waiting = digest.needsYou.filter((item) => !answers.has(item.question)).length;
  const summary = (digest.now[0] ?? digest.news[0] ?? digest.needsYou[0]?.question ?? digest.suggestions[0] ?? '').replace(/`/g, '');
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-lead-digest=""
        className="group/digest relative z-20 flex h-7 w-full min-w-0 shrink-0 items-center gap-1.5 bg-background px-4 text-start typography-meta text-muted-foreground hover:text-foreground focus-visible:outline-none"
      >
        <Icon name="arrow-right-s" className="size-3.5 shrink-0 transition-transform group-data-[popup-open]/digest:rotate-90 rtl:group-data-[popup-open]/digest:-rotate-90" />
        {waiting > 0 ? (
          <span className="shrink-0 text-status-warning">
            {waiting === 1 ? t('chat.leadDigest.needsYouOne') : t('chat.leadDigest.needsYouMany', { count: waiting })}
          </span>
        ) : null}
        {waiting > 0 && summary ? <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">·</span> : null}
        <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">{summary}</span>
        <span className="shrink-0 tabular-nums">{relativeTime(t, digest.updatedAt, now)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={2} className="z-50">
          <Popover.Popup className={cn(dropdownMenuPopupClass, 'flex max-h-[min(60vh,var(--available-height))] w-[calc(var(--anchor-width)-1.5rem)] flex-col gap-3 overflow-y-auto px-4 py-3')}>
            {digest.needsYou.length > 0 ? (
              <section className="flex flex-col gap-1">
                <SectionTitle waiting={waiting > 0}>{t('chat.leadDigest.needsYou')}</SectionTitle>
                <ul className="flex flex-col gap-2.5">
                  {digest.needsYou.map((item) => (
                    <QuestionItem key={item.question} item={item} answered={answers.get(item.question)} sending={sending} on={on} />
                  ))}
                </ul>
              </section>
            ) : null}
            <DigestList title={t('chat.leadDigest.now')} items={digest.now} />
            <DigestList title={t('chat.leadDigest.news')} items={digest.news} />
            {digest.suggestions.length > 0 ? (
              <section className="flex flex-col gap-1">
                <SectionTitle>{t('chat.leadDigest.suggestions')}</SectionTitle>
                <ul className="flex flex-col gap-1">
                  {digest.suggestions.map((item) => <SuggestionItem key={item} item={item} on={on} />)}
                </ul>
              </section>
            ) : null}
            <GlassRedrawGuard />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
