import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { Input } from '@/components/ui/input';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { getLeadDigest, type LeadQuestion, type LeadReply } from '@/lib/sessionLead';
import { cn } from '@/lib/utils';
import { useSession } from '@/sync/live-session-hooks';
import { dismissLeadSuggestions, sendLeadReply } from '@/sync/session-lead';
import { useLeadReplies, type LeadReplies } from './leadReplies';

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

type DraftAnswer = { answer: string; typed: boolean };
type Draft = { answers: ReadonlyMap<string, DraftAnswer>; suggestions: ReadonlyMap<string, boolean> };

type DigestDraft = Draft & { digestAt: number; sent: LeadReplies };

const emptyDraft = (digestAt: number): DigestDraft => ({ answers: new Map(), suggestions: new Map(), digestAt, sent: { answers: new Map(), suggestions: new Map() } });

const withEntry = <V,>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): Map<string, V> => {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
};

const merged = <V,>(left: ReadonlyMap<string, V>, right: ReadonlyMap<string, V>) => (right.size === 0 ? left : new Map([...left, ...right]));

const QuestionItem: React.FC<{
  item: LeadQuestion;
  sent: string | undefined;
  draft: DraftAnswer | undefined;
  disabled: boolean;
  onPick: (option: string) => void;
  onType: (text: string) => void;
  onSubmit: () => void;
}> = ({ item, sent, draft, disabled, onPick, onType, onSubmit }) => {
  const { t } = useI18n();
  const options = item.recommended ? [item.recommended, ...item.options.filter((option) => option !== item.recommended)] : item.options;
  const picked = draft && !draft.typed ? draft.answer : undefined;
  return (
    <li className="flex flex-col gap-1.5" data-lead-question="">
      <ItemText text={item.question} />
      {sent !== undefined ? (
        <p className="typography-micro text-muted-foreground">{t('chat.leadDigest.answered', { answer: sent })}</p>
      ) : (
        <>
          {options.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {options.map((option) => (
                <Button
                  key={option}
                  size="xs"
                  variant={picked === option ? 'default' : 'chip'}
                  aria-pressed={picked === option}
                  disabled={disabled}
                  onClick={() => onPick(option)}
                >
                  {option}
                  {option === item.recommended ? <span className="font-normal opacity-70">{t('chat.leadDigest.recommended')}</span> : null}
                </Button>
              ))}
            </div>
          ) : null}
          <Input
            inputSize="compact"
            value={draft?.typed ? draft.answer : ''}
            disabled={disabled}
            placeholder={t('chat.leadDigest.ownAnswer')}
            aria-label={t('chat.leadDigest.ownAnswer')}
            onChange={(event) => onType(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onSubmit();
            }}
          />
        </>
      )}
    </li>
  );
};

const SuggestionItem: React.FC<{
  item: string;
  sent: boolean | undefined;
  draft: boolean | undefined;
  disabled: boolean;
  onDecide: (accepted: boolean) => void;
}> = ({ item, sent, draft, disabled, onDecide }) => {
  const { t } = useI18n();
  return (
    <li className="flex items-start gap-2" data-lead-suggestion="">
      <div className="min-w-0 flex-1 py-0.5"><ItemText text={item} /></div>
      {sent !== undefined ? (
        <span className="shrink-0 py-0.5 typography-micro text-muted-foreground">{t(sent ? 'chat.leadDigest.accepted' : 'chat.leadDigest.declined')}</span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant={draft === true ? 'default' : 'chip'} aria-pressed={draft === true} disabled={disabled} onClick={() => onDecide(true)}>
            {t('chat.leadDigest.accept')}
          </Button>
          <Button size="xs" variant={draft === false ? 'default' : 'chip'} aria-pressed={draft === false} disabled={disabled} onClick={() => onDecide(false)}>
            {t('chat.leadDigest.decline')}
          </Button>
        </div>
      )}
    </li>
  );
};

export const LeadDigestRow: React.FC<{ sessionId: string | null; directory: string | undefined }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId, directory);
  const digest = getLeadDigest(session);
  const now = useMinuteTickerNow(digest !== null);
  const replies = useLeadReplies(sessionId ?? '', directory, digest?.updatedAt ?? Number.POSITIVE_INFINITY);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [stored, setStored] = React.useState<DigestDraft | null>(null);
  const sendingRef = React.useRef(false);
  if (!digest || !sessionId || !directory) return null;

  const digestAt = digest.updatedAt;
  const current = stored?.digestAt === digestAt ? stored : emptyDraft(digestAt);
  const draft: Draft = current;
  const setDraft = (next: Draft) => setStored({ ...current, ...next });
  const sentAnswers = merged(replies.answers, current.sent.answers);
  const sentSuggestions = merged(replies.suggestions, current.sent.suggestions);

  const openQuestions = digest.needsYou.filter((item) => !sentAnswers.has(item.question));
  const openSuggestions = digest.suggestions.filter((item) => !sentSuggestions.has(item));
  const replyOf = (next: Draft): LeadReply => ({
    answers: openQuestions.flatMap(({ question }) => {
      const answer = next.answers.get(question)?.answer.trim();
      return answer ? [{ question, answer }] : [];
    }),
    suggestions: openSuggestions.flatMap((item) => {
      const accepted = next.suggestions.get(item);
      return accepted === undefined ? [] : [{ item, accepted }];
    }),
  });
  const reply = replyOf(draft);
  const staged = reply.answers.length + reply.suggestions.length;

  const send = (toSend: LeadReply) => {
    if (sendingRef.current || toSend.answers.length + toSend.suggestions.length === 0) return;
    const finishes = toSend.answers.length === openQuestions.length && toSend.suggestions.length === openSuggestions.length;
    sendingRef.current = true;
    setSending(true);
    void sendLeadReply(sessionId, directory, toSend).then(() => {
      setStored((latest) => {
        const base = latest?.digestAt === digestAt ? latest : emptyDraft(digestAt);
        return {
          ...base,
          sent: {
            answers: new Map([...base.sent.answers, ...toSend.answers.map(({ question, answer }) => [question, answer] as const)]),
            suggestions: new Map([...base.sent.suggestions, ...toSend.suggestions.map(({ item, accepted }) => [item, accepted] as const)]),
          },
        };
      });
      if (finishes) setOpen(false);
      const declined = toSend.suggestions.filter((entry) => !entry.accepted).map((entry) => entry.item);
      if (declined.length > 0) {
        void dismissLeadSuggestions(sessionId, directory, declined).catch(() => toast.error(t('chat.leadDigest.dismissFailed')));
      }
    }, () => toast.error(t('chat.leadDigest.sendFailed'))).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  };
  const decide = (next: Draft) => {
    setDraft(next);
    const nextReply = replyOf(next);
    if (nextReply.answers.length === openQuestions.length && nextReply.suggestions.length === openSuggestions.length) send(nextReply);
  };
  const pick = (question: string, option: string) => {
    const previous = draft.answers.get(question);
    const unpick = previous?.typed === false && previous.answer === option;
    decide({ ...draft, answers: withEntry(draft.answers, question, unpick ? undefined : { answer: option, typed: false }) });
  };
  const typeAnswer = (question: string, text: string) => setDraft({
    ...draft,
    answers: withEntry(draft.answers, question, text ? { answer: text, typed: true } : undefined),
  });
  const judge = (item: string, accepted: boolean) => decide({
    ...draft,
    suggestions: withEntry(draft.suggestions, item, draft.suggestions.get(item) === accepted ? undefined : accepted),
  });

  const waiting = openQuestions.length;
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
          <Popover.Popup
            ref={popupRef}
            initialFocus={popupRef}
            className={cn(dropdownMenuPopupClass, 'data-[starting-style]:scale-[0.98] data-[ending-style]:scale-[0.98] [&:not([data-ending-style])]:duration-150 flex max-h-[min(60vh,var(--available-height))] w-[calc(var(--anchor-width)-1.5rem)] flex-col focus-visible:outline-none')}
          >
            <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
              {digest.needsYou.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <SectionTitle waiting={waiting > 0}>{t('chat.leadDigest.needsYou')}</SectionTitle>
                  <ul className="flex flex-col gap-3">
                    {digest.needsYou.map((item) => (
                      <QuestionItem
                        key={item.question}
                        item={item}
                        sent={sentAnswers.get(item.question)}
                        draft={draft.answers.get(item.question)}
                        disabled={sending}
                        onPick={(option) => pick(item.question, option)}
                        onType={(text) => typeAnswer(item.question, text)}
                        onSubmit={() => send(reply)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
              {digest.suggestions.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <SectionTitle>{t('chat.leadDigest.suggestions')}</SectionTitle>
                  <ul className="flex flex-col gap-1.5">
                    {digest.suggestions.map((item) => (
                      <SuggestionItem
                        key={item}
                        item={item}
                        sent={sentSuggestions.get(item)}
                        draft={draft.suggestions.get(item)}
                        disabled={sending}
                        onDecide={(accepted) => judge(item, accepted)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
              <DigestList title={t('chat.leadDigest.news')} items={digest.news} />
              <DigestList title={t('chat.leadDigest.now')} items={digest.now} />
            </div>
            {openQuestions.length + openSuggestions.length > 0 ? (
              <div className="flex shrink-0 justify-end border-t border-[var(--interactive-border)] px-4 py-2">
                <Button size="xs" disabled={staged === 0 || sending} onClick={() => send(reply)}>
                  {t('chat.leadDigest.send')}
                </Button>
              </div>
            ) : null}
            <GlassRedrawGuard />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
