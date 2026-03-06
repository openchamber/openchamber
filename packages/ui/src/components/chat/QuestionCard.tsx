import React from 'react';
import { RiArrowRightSLine, RiCheckLine, RiCloseLine, RiEditLine, RiListCheck3, RiQuestionLine } from '@remixicon/react';
import { Checkbox } from '@/components/ui/checkbox';

import { cn } from '@/lib/utils';
import type { QuestionRequest } from '@/types/question';
import { useSessionStore } from '@/stores/useSessionStore';
import { useLanguage } from '@/hooks/useLanguage';

interface QuestionCardProps {
  question: QuestionRequest;
}

type TabKey = string;
const SUMMARY_TAB = 'summary';

export const QuestionCard: React.FC<QuestionCardProps> = ({ question }) => {
  const { t } = useLanguage();
  const { respondToQuestion, rejectQuestion } = useSessionStore();
  const isFromSubagent = useSessionStore(
    React.useCallback((state) => {
      const currentSessionId = state.currentSessionId;
      if (!currentSessionId || question.sessionID === currentSessionId) return false;
      const sourceSession = state.sessions.find((session) => session.id === question.sessionID);
      return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
    }, [question.sessionID])
  );
  const [activeTab, setActiveTab] = React.useState<TabKey>('0');
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);

  const [selectedOptions, setSelectedOptions] = React.useState<Record<number, string[]>>({});
  const [customMode, setCustomMode] = React.useState<Record<number, boolean>>({});
  const [customText, setCustomText] = React.useState<Record<number, string>>({});

  const questions = React.useMemo(() => question.questions ?? [], [question.questions]);
  const isSummaryTab = activeTab === SUMMARY_TAB;
  const activeIndex = isSummaryTab ? -1 : Math.max(0, Math.min(questions.length - 1, Number(activeTab) || 0));
  const activeQuestion = isSummaryTab ? null : questions[activeIndex];
  const activeHeader = React.useMemo(() => {
    if (isSummaryTab) return null;
    const header = activeQuestion?.header?.trim();
    return header && header.length > 0 ? header : null;
  }, [activeQuestion?.header, isSummaryTab]);

  React.useEffect(() => {
    setActiveTab('0');
    setSelectedOptions({});
    setCustomMode({});
    setCustomText({});
    setHasResponded(false);
  }, [question.id]);

  const tabs = React.useMemo(() => {
    const questionTabs = questions.map((q, index) => ({
      value: String(index),
      label: q.header?.trim() || `Q${index + 1}`,
    }));
    // Add summary tab when multiple questions
    if (questions.length > 1) {
      questionTabs.push({ value: SUMMARY_TAB, label: t('questionCard.summary') });
    }
    return questionTabs;
  }, [questions, t]);

  // Helper to get answer display for a question index
  const getAnswerDisplay = React.useCallback((index: number): string => {
    const isCustom = Boolean(customMode[index]);
    if (isCustom) {
      const value = (customText[index] ?? '').trim();
      return value || '(no answer)';
    }
    const answers = selectedOptions[index] ?? [];
    return answers.length > 0 ? answers.join(', ') : '(no answer)';
  }, [customMode, customText, selectedOptions]);

  const isMultiple = Boolean(activeQuestion?.multiple);
  const selectedForActive = selectedOptions[activeIndex] ?? [];
  const isCustomActive = Boolean(customMode[activeIndex]);

  const unansweredIndexes = React.useMemo(() => {
    const pending: number[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const isCustom = Boolean(customMode[index]);
      if (isCustom) {
        const value = (customText[index] ?? '').trim();
        if (!value) pending.push(index);
        continue;
      }

      const answers = selectedOptions[index] ?? [];
      if (answers.length === 0) {
        pending.push(index);
      }
    }
    return pending;
  }, [customMode, customText, questions.length, selectedOptions]);

  const requiredSatisfied = React.useMemo(() => {
    if (questions.length === 0) return false;
    return unansweredIndexes.length === 0;
  }, [questions.length, unansweredIndexes.length]);

  const handleNextUnanswered = React.useCallback(() => {
    if (questions.length === 0 || unansweredIndexes.length === 0) return;

    const start = isSummaryTab ? -1 : activeIndex;
    for (let offset = 1; offset <= questions.length; offset += 1) {
      const candidate = (start + offset + questions.length) % questions.length;
      if (unansweredIndexes.includes(candidate)) {
        setActiveTab(String(candidate));
        return;
      }
    }

    setActiveTab(String(unansweredIndexes[0]));
  }, [activeIndex, isSummaryTab, questions.length, unansweredIndexes]);

  const buildAnswersPayload = React.useCallback((): string[][] => {
    const answers: string[][] = [];

    for (let index = 0; index < questions.length; index += 1) {
      const isCustom = Boolean(customMode[index]);
      if (isCustom) {
        const value = (customText[index] ?? '').trim();
        answers.push(value ? [value] : []);
        continue;
      }

      answers.push(selectedOptions[index] ?? []);
    }

    return answers;
  }, [customMode, customText, questions.length, selectedOptions]);

  const handleToggleOption = React.useCallback(
    (label: string) => {
      if (!activeQuestion) return;

      setCustomMode((prev) => ({ ...prev, [activeIndex]: false }));

      setSelectedOptions((prev) => {
        const current = prev[activeIndex] ?? [];
        if (isMultiple) {
          const exists = current.includes(label);
          const next = exists ? current.filter((item) => item !== label) : [...current, label];
          return { ...prev, [activeIndex]: next };
        }
        return { ...prev, [activeIndex]: [label] };
      });
    },
    [activeIndex, activeQuestion, isMultiple]
  );

  const handleSelectCustom = React.useCallback(() => {
    setCustomMode((prev) => ({ ...prev, [activeIndex]: true }));
    setSelectedOptions((prev) => ({ ...prev, [activeIndex]: [] }));
  }, [activeIndex]);

  const handleConfirm = React.useCallback(async () => {
    if (!requiredSatisfied) return;

    setIsResponding(true);
    try {
      const answers = buildAnswersPayload();
      await respondToQuestion(question.sessionID, question.id, answers);
      setHasResponded(true);
    } catch {
      // ignored
    } finally {
      setIsResponding(false);
    }
  }, [buildAnswersPayload, question.id, question.sessionID, requiredSatisfied, respondToQuestion]);

  const handleDismiss = React.useCallback(async () => {
    setIsResponding(true);
    try {
      await rejectQuestion(question.sessionID, question.id);
      setHasResponded(true);
    } catch {
      // ignored
    } finally {
      setIsResponding(false);
    }
  }, [question.id, question.sessionID, rejectQuestion]);

  if (hasResponded || questions.length === 0) {
    return null;
  }

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          {/* Header */}
          <div className="px-2 py-1.5 border-b border-border/20">
            <div className="flex items-center gap-2">
              <RiQuestionLine className="h-3.5 w-3.5 text-primary" />
              <span className="typography-meta font-medium text-muted-foreground">{t('questionCard.inputNeeded')}</span>
              {isFromSubagent ? (
                <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                  {t('questionCard.fromSubagent')}
                </span>
              ) : null}
              {activeHeader ? (
                <span className="ml-auto typography-micro font-medium text-foreground/70 px-1.5 py-0.5 rounded bg-muted/30 border border-border/20">
                  {activeHeader}
                </span>
              ) : null}
            </div>
          </div>

          <div className="px-2 py-2">
            {/* Minimal inline tabs for multiple questions */}
            {tabs.length > 1 ? (
              <div className="flex items-center gap-1 mb-2 flex-wrap">
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.value;
                  const isSummary = tab.value === SUMMARY_TAB;
                  const tabIndex = isSummary ? -1 : Number(tab.value);
                  const isAnswered = !isSummary && Number.isFinite(tabIndex) && !unansweredIndexes.includes(tabIndex);
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setActiveTab(tab.value)}
                      className={cn(
                        'px-2 py-0.5 typography-meta font-medium rounded transition-colors flex items-center gap-1',
                        isActive
                          ? 'bg-interactive-selection/40 text-foreground'
                          : isSummary
                            ? 'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/20'
                            : isAnswered
                              ? 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-interactive-hover/20'
                              : 'text-foreground/85 hover:text-foreground hover:bg-interactive-hover/20'
                      )}
                    >
                      {isSummary ? <RiListCheck3 className="h-3 w-3" /> : null}
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* Summary view */}
            {isSummaryTab ? (
              <div className="space-y-2">
                {questions.map((q, index) => {
                  const answer = getAnswerDisplay(index);
                  const hasAnswer = answer !== '(no answer)';
                  return (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setActiveTab(String(index))}
                      className="w-full text-left rounded px-1.5 py-1 hover:bg-interactive-hover/20 transition-colors"
                    >
                      <div className="typography-micro text-muted-foreground">{q.header || `Question ${index + 1}`}</div>
                      <div className={cn(
                        'typography-meta',
                        hasAnswer ? 'text-foreground' : 'text-muted-foreground/50 italic'
                      )}>
                        {answer}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : activeQuestion ? (
              <>
                <div className="typography-meta font-medium text-foreground mb-1.5">{activeQuestion.question}</div>

                {isMultiple ? (
                  <div className="typography-micro text-muted-foreground mb-1.5">{t('questionCard.selectMultiple')}</div>
                ) : null}

                <div className="space-y-0.5">
                  {activeQuestion.options.map((option, index) => {
                    const selected = selectedForActive.includes(option.label);
                    const recommended = /\(recommended\)/i.test(option.label);

                    return (
                      <button
                        key={`${index}:${option.label}`}
                        type="button"
                        onClick={() => handleToggleOption(option.label)}
                        disabled={isResponding}
                        className={cn(
                          'w-full px-1.5 py-1 text-left rounded transition-colors',
                          'hover:bg-interactive-hover/30',
                          selected ? 'bg-interactive-selection/20' : null,
                          isResponding ? 'opacity-60 cursor-not-allowed' : null
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 shrink-0">
                            <Checkbox
                              checked={selected}
                              onChange={() => handleToggleOption(option.label)}
                              disabled={isResponding}
                            />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={cn(
                                'typography-meta break-all',
                                selected ? 'text-foreground font-medium' : 'text-foreground/80'
                              )}>
                                {option.label}
                              </span>
                              {recommended ? (
                                <span className="typography-micro text-primary/80">{t('questionCard.recommended')}</span>
                              ) : null}
                            </div>
                            {option.description ? (
                              <div className="typography-micro text-muted-foreground break-words">{option.description}</div>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {/* Custom answer option */}
                  <button
                    type="button"
                    onClick={handleSelectCustom}
                    disabled={isResponding}
                    className={cn(
                      'w-full px-1.5 py-1 text-left rounded transition-colors',
                      'hover:bg-interactive-hover/30',
                      isCustomActive ? 'bg-interactive-selection/20' : null,
                      isResponding ? 'opacity-60 cursor-not-allowed' : null
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <RiEditLine className={cn(
                        'h-3.5 w-3.5',
                        isCustomActive ? 'text-primary' : 'text-muted-foreground/50'
                      )} />
                      <span className={cn(
                        'typography-meta',
                        isCustomActive ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}>
                        {t('questionCard.other')}
                      </span>
                    </div>
                  </button>

                  {isCustomActive ? (
                    <div className="pl-6 pr-1 pt-0.5">
                      <textarea
                        ref={(el) => {
                          if (el) {
                            el.style.height = 'auto';
                            const lineHeight = 20; // approx typography-meta line height
                            const minHeight = lineHeight * 2;
                            const maxHeight = lineHeight * 4;
                            el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
                          }
                        }}
                        value={customText[activeIndex] ?? ''}
                        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                          const el = event.target;
                          el.style.height = 'auto';
                          const lineHeight = 20;
                          const minHeight = lineHeight * 2;
                          const maxHeight = lineHeight * 4;
                          el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
                          setCustomText((prev) => ({ ...prev, [activeIndex]: el.value }));
                        }}
                        placeholder={t('questionCard.yourAnswer')}
                        disabled={isResponding}
                        rows={2}
                        className="w-full bg-transparent border border-border/30 focus:border-primary rounded px-2 py-1 outline-none typography-meta text-foreground placeholder:text-muted-foreground/50 transition-colors resize-none overflow-hidden"
                        autoFocus
                      />
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          {/* Footer actions */}
          <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-border/20">
            <button
              type="button"
              onClick={requiredSatisfied ? handleConfirm : handleNextUnanswered}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-success)/0.1)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {requiredSatisfied ? <RiCheckLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
              {requiredSatisfied ? 'Submit' : 'Next'}
            </button>

            <button
              type="button"
              onClick={handleDismiss}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-error)/0.1)] text-[var(--status-error)] hover:bg-[rgb(var(--status-error)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RiCloseLine className="h-3 w-3" />
              Dismiss
            </button>

            {isResponding ? (
              <div className="ml-auto">
                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
