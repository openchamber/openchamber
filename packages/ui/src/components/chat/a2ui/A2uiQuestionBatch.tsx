import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Button as UiButton } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Textarea } from '@/components/ui/textarea';
import { seriesColor } from '../lib/visualKit';
import type { A2uiJson, A2uiObject, QuestionBatchItem } from './protocol';

type FilterMode = 'all' | 'unanswered' | 'answered';
type ViewMode = 'compact' | 'paged';

const isAnswered = (value: A2uiJson | undefined): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
};

const formatSelectionLabel = (item: QuestionBatchItem, value: A2uiJson | undefined): string => {
  const values = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' && value
      ? [value]
      : [];
  return values
    .map((v) => item.options.find((opt) => opt.value === v || opt.label === v)?.label ?? v)
    .join(', ');
};

export function A2uiQuestionBatch({
  title,
  description,
  items,
  answers,
  notes,
  pageSize = 5,
  disabled,
  submitLabel = 'Submit selections',
  requireAll = false,
  onAnswerChange,
  onNoteChange,
  onApplyRecommended,
  onSubmit,
  renderMarkdown,
}: {
  title?: string;
  description?: string;
  items: QuestionBatchItem[];
  answers: A2uiObject;
  notes: A2uiObject;
  pageSize?: number;
  disabled: boolean;
  submitLabel?: string;
  requireAll?: boolean;
  onAnswerChange: (id: string, value: A2uiJson) => void;
  onNoteChange: (id: string, note: string) => void;
  onApplyRecommended: (patch: Record<string, string>) => void;
  onSubmit?: (payload: A2uiObject) => void;
  renderMarkdown: (source: string, className?: string) => React.ReactNode;
}) {
  const [filter, setFilter] = React.useState<FilterMode>('all');
  const [viewMode, setViewMode] = React.useState<ViewMode>(items.length > 8 ? 'paged' : 'compact');
  const [page, setPage] = React.useState(0);
  const [reopened, setReopened] = React.useState<ReadonlySet<string>>(() => new Set());
  const [openDetails, setOpenDetails] = React.useState<ReadonlySet<string>>(() => new Set());
  const [openNotes, setOpenNotes] = React.useState<ReadonlySet<string>>(() => new Set());

  const totalCount = items.length;
  const answeredCount = items.filter((item) => isAnswered(answers[item.id])).length;
  const unansweredItems = items.filter((item) => !isAnswered(answers[item.id]));
  const remainingRecommended = unansweredItems.filter((item) => Boolean(item.recommended));
  const progressPct = totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0;

  const filteredItems = React.useMemo(() => {
    if (filter === 'unanswered') return items.filter((item) => !isAnswered(answers[item.id]));
    if (filter === 'answered') return items.filter((item) => isAnswered(answers[item.id]));
    return items;
  }, [answers, filter, items]);

  const effectivePageSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / effectivePageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const visibleItems = viewMode === 'paged'
    ? filteredItems.slice(clampedPage * effectivePageSize, (clampedPage + 1) * effectivePageSize)
    : filteredItems;

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelect = (item: QuestionBatchItem, optionValue: string) => {
    if (disabled) return;
    if (!item.multiple) {
      onAnswerChange(item.id, optionValue);
      // Fold answered items in compact mode so undecided questions stay prominent.
      setReopened((prev) => {
        if (!prev.has(item.id)) return prev;
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      return;
    }
    const current = answers[item.id];
    const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : [];
    const next = list.includes(optionValue) ? list.filter((v) => v !== optionValue) : [...list, optionValue];
    onAnswerChange(item.id, next);
  };

  const handleBulkRecommended = () => {
    if (disabled || remainingRecommended.length === 0) return;
    const patch: Record<string, string> = {};
    for (const item of remainingRecommended) {
      if (item.recommended) patch[item.id] = item.recommended;
    }
    onApplyRecommended(patch);
  };

  const handleSubmit = () => {
    if (disabled || !onSubmit) return;
    const cleanAnswers: A2uiObject = {};
    const cleanNotes: A2uiObject = {};
    const unansweredIds: string[] = [];

    for (const item of items) {
      const value = answers[item.id];
      if (isAnswered(value)) {
        cleanAnswers[item.id] = value ?? null;
      } else {
        unansweredIds.push(item.id);
      }
      const noteValue = notes[item.id];
      if (typeof noteValue === 'string' && noteValue.trim()) {
        cleanNotes[item.id] = noteValue.trim();
      }
    }

    onSubmit({
      answers: cleanAnswers,
      notes: cleanNotes,
      answeredCount,
      totalCount,
      unanswered: unansweredIds,
    });
  };

  const canSubmit = !disabled && (requireAll ? answeredCount === totalCount : answeredCount > 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Header + live progress bar + filters */}
      <div className="oc-box flex flex-col gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {title && <div className="font-medium text-foreground">{title}</div>}
            {description && <div className="typography-meta text-muted-foreground">{description}</div>}
          </div>
          <span className="oc-badge shrink-0 tabular-nums" data-tone={answeredCount === totalCount && totalCount > 0 ? 'success' : 'info'}>
            {answeredCount} / {totalCount} answered ({progressPct}%)
          </span>
        </div>

        <div
          className="oc-track h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemax={totalCount}
          aria-label={title || 'Questionnaire progress'}
        >
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{
              width: `${progressPct}%`,
              background: answeredCount === totalCount && totalCount > 0 ? 'var(--status-success)' : seriesColor(0),
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['all', `All (${totalCount})`],
                ['unanswered', `Unanswered (${totalCount - answeredCount})`],
                ['answered', `Answered (${answeredCount})`],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={filter === mode}
                onClick={() => {
                  setFilter(mode);
                  setPage(0);
                }}
                className={cn(
                  'rounded-md px-2 py-0.5 typography-micro font-medium transition-colors',
                  filter === mode
                    ? 'bg-foreground/12 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {items.length > effectivePageSize && (
              <button
                type="button"
                onClick={() => {
                  setViewMode((prev) => (prev === 'paged' ? 'compact' : 'paged'));
                  setPage(0);
                }}
                className="rounded-md px-2 py-0.5 typography-micro text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                {viewMode === 'paged' ? 'Show all' : `Paginate (${effectivePageSize}/page)`}
              </button>
            )}
            {!disabled && remainingRecommended.length > 0 && (
              <UiButton
                type="button"
                variant="outline"
                size="xs"
                onClick={handleBulkRecommended}
              >
                Apply recommended ({remainingRecommended.length})
              </UiButton>
            )}
          </div>
        </div>
      </div>

      {/* Questions list */}
      {visibleItems.length === 0 ? (
        <div className="oc-box py-4 text-center typography-meta text-muted-foreground">
          {filter === 'unanswered' ? 'Every question has an answer.' : 'No questions match this filter.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleItems.map((item) => {
            const globalIndex = items.findIndex((candidate) => candidate.id === item.id);
            const value = answers[item.id];
            const answered = isAnswered(value);
            const rawNote = notes[item.id];
            const noteText = typeof rawNote === 'string' ? rawNote : '';
            const selectedValues = Array.isArray(value)
              ? value.filter((v): v is string => typeof v === 'string')
              : typeof value === 'string' && value
                ? [value]
                : [];
            const folded = viewMode === 'compact' && answered && !item.multiple && !reopened.has(item.id);
            const detailKey = `q:${item.id}`;
            const detailOpen = openDetails.has(detailKey);
            const noteOpen = openNotes.has(item.id) || noteText.length > 0;

            if (folded) {
              return (
                <div key={item.id} className="oc-box flex flex-col gap-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="checkbox-circle" className="size-4 shrink-0 text-[var(--status-success)]" />
                    <span className="typography-micro tabular-nums text-muted-foreground">#{globalIndex + 1}</span>
                    <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{item.question}</span>
                    <span className="oc-badge shrink-0" data-tone="info">
                      {formatSelectionLabel(item, value)}
                    </span>
                    {!disabled && (
                      <UiButton
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={() => toggleSet(setReopened, item.id)}
                      >
                        Change
                      </UiButton>
                    )}
                  </div>
                  {noteText.trim() && (
                    <div className="ps-6 typography-micro text-muted-foreground line-clamp-2">{noteText}</div>
                  )}
                </div>
              );
            }

            return (
              <div key={item.id} className="oc-box flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded px-1.5 py-0.5 typography-micro font-medium tabular-nums bg-foreground/8 text-muted-foreground">
                    {globalIndex + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.category && <span className="oc-badge">{item.category}</span>}
                      <span className="typography-meta font-medium text-foreground">{item.question}</span>
                    </div>
                  </div>
                  {answered && (
                    <Icon name="checkbox-circle" className="mt-0.5 size-4 shrink-0 text-[var(--status-success)]" />
                  )}
                  {item.detail && (
                    <button
                      type="button"
                      aria-expanded={detailOpen}
                      onClick={() => toggleSet(setOpenDetails, detailKey)}
                      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 typography-micro text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    >
                      <Icon name="information" className="size-3.5" />
                      {detailOpen ? 'Hide details' : 'Details'}
                    </button>
                  )}
                </div>

                {item.detail && detailOpen && (
                  <div className="rounded-lg bg-foreground/5 px-2.5 py-2 typography-meta text-muted-foreground">
                    {renderMarkdown(item.detail)}
                  </div>
                )}

                <div
                  className={cn(
                    item.options.length >= 4
                      ? 'grid grid-cols-1 gap-1.5 sm:grid-cols-2'
                      : 'flex flex-col gap-1',
                  )}
                  role={item.multiple ? 'group' : 'radiogroup'}
                  aria-label={item.question}
                >
                  {item.options.map((option) => {
                    const selected = selectedValues.includes(option.value);
                    const isRecommended = item.recommended === option.value || item.recommended === option.label;
                    const optDetailKey = `opt:${item.id}:${option.value}`;
                    const optDetailOpen = openDetails.has(optDetailKey);

                    return (
                      <div key={option.value} className="flex flex-col">
                        <div className="flex items-start gap-1.5">
                          <div
                            onClick={() => handleSelect(item, option.value)}
                            className={cn(
                              'flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 transition-colors',
                              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                              selected && 'bg-[var(--primary)]/10',
                            )}
                          >
                            <div className="flex items-center gap-2">
                              {item.multiple ? (
                                <Checkbox
                                  checked={selected}
                                  onChange={() => handleSelect(item, option.value)}
                                  disabled={disabled}
                                  ariaLabel={option.label}
                                />
                              ) : (
                                <Radio
                                  checked={selected}
                                  onChange={() => handleSelect(item, option.value)}
                                  disabled={disabled}
                                  ariaLabel={option.label}
                                />
                              )}
                              <span className={cn('typography-meta min-w-0', selected ? 'font-medium text-foreground' : 'text-foreground/85')}>
                                {option.label}
                              </span>
                              {isRecommended && (
                                <span className="oc-badge" data-tone="info">
                                  Recommended
                                </span>
                              )}
                              {option.badge && <span className="oc-badge">{option.badge}</span>}
                            </div>
                            {option.description && (
                              <div className="ps-6 pt-0.5 typography-micro text-muted-foreground">
                                {option.description}
                              </div>
                            )}
                          </div>
                          {option.detail && (
                            <button
                              type="button"
                              aria-expanded={optDetailOpen}
                              onClick={() => toggleSet(setOpenDetails, optDetailKey)}
                              className="mt-1.5 shrink-0 rounded px-1.5 py-0.5 typography-micro text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                            >
                              {optDetailOpen ? 'Less' : 'More'}
                            </button>
                          )}
                        </div>
                        {option.detail && optDetailOpen && (
                          <div className="ms-8 mb-1 rounded-md bg-foreground/5 px-2.5 py-1.5 typography-micro text-muted-foreground">
                            {renderMarkdown(option.detail)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {item.allowNote && (
                  <div className="pt-0.5">
                    {noteOpen ? (
                      <Textarea
                        rows={1}
                        maxLength={1000}
                        value={noteText}
                        disabled={disabled}
                        placeholder="Optional note or condition for this item"
                        aria-label={`Note for ${item.question}`}
                        onChange={(event) => onNoteChange(item.id, event.target.value)}
                        className="min-h-8 typography-meta"
                      />
                    ) : !disabled ? (
                      <button
                        type="button"
                        onClick={() => toggleSet(setOpenNotes, item.id)}
                        className="inline-flex items-center gap-1 typography-micro text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Icon name="sticky-note" className="size-3.5" />
                        Add note
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination footer */}
      {viewMode === 'paged' && pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <UiButton
            type="button"
            variant="outline"
            size="xs"
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </UiButton>
          <div className="flex flex-wrap items-center gap-1">
            {Array.from({ length: pageCount }, (_, idx) => {
              const slice = filteredItems.slice(idx * effectivePageSize, (idx + 1) * effectivePageSize);
              const sliceDone = slice.length > 0 && slice.every((item) => isAnswered(answers[item.id]));
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPage(idx)}
                  aria-current={clampedPage === idx ? 'page' : undefined}
                  className={cn(
                    'min-w-6 rounded px-1.5 py-0.5 typography-micro tabular-nums transition-colors',
                    clampedPage === idx
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)] font-medium'
                      : sliceDone
                        ? 'bg-[var(--status-success)]/15 text-[var(--status-success)] hover:bg-[var(--status-success)]/25'
                        : 'bg-foreground/6 text-muted-foreground hover:bg-foreground/12 hover:text-foreground',
                  )}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
          <UiButton
            type="button"
            variant="outline"
            size="xs"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next
          </UiButton>
        </div>
      )}

      {/* Built-in submit bar when QuestionBatch owns submission */}
      {onSubmit && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="typography-meta text-muted-foreground tabular-nums">
            {answeredCount === totalCount
              ? `All ${totalCount} questions answered — ready to submit.`
              : `${totalCount - answeredCount} remaining${requireAll ? ' (all required)' : ' (you can also submit partial choices)'}.`}
          </span>
          <UiButton
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            <Icon name="check" className="size-3.5" />
            {submitLabel} ({answeredCount}/{totalCount})
          </UiButton>
        </div>
      )}
    </div>
  );
}
