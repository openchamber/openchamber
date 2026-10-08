import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { REFERENCE_META_TEXT, relativeTimeOf } from './referencePickerItems';
import type { ReferenceCommentItem, ReferenceCommitGroup, ReferenceTimelineEntry } from './referenceTimeline';

const relativeLabel = (t: ReturnType<typeof useI18n>['t'], iso: string | null, now: number) => {
    const relative = relativeTimeOf(iso, now);
    if (!relative) return null;
    return relative.key === 'common.relative.justNow' ? t(relative.key) : t(relative.key, { count: relative.count });
};

const CommitGroup: React.FC<{ group: ReferenceCommitGroup; now: number }> = ({ group, now }) => {
    const { t } = useI18n();
    const count = group.commits.length;
    return (
        <>
            <div className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full border border-border/60 bg-surface-elevated text-muted-foreground">
                <Icon name="git-commit" className="size-3.5" />
            </div>
            <div className={cn('flex h-6 items-center typography-meta', REFERENCE_META_TEXT)}>
                {count === 1 ? t('references.picker.preview.commitsSingle') : t('references.picker.preview.commitsPlural', { count })}
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.commits.map((commit) => {
                    const when = relativeLabel(t, commit.committedAt, now);
                    const sha = commit.sha.slice(0, 7);
                    return (
                        <li key={commit.sha} className="flex min-w-0 items-baseline gap-2 typography-meta">
                            {commit.url ? (
                                <a href={commit.url} target="_blank" rel="noopener noreferrer" className={cn('shrink-0 font-mono typography-micro hover:text-foreground', REFERENCE_META_TEXT)}>{sha}</a>
                            ) : (
                                <span className={cn('shrink-0 font-mono typography-micro', REFERENCE_META_TEXT)}>{sha}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-foreground" title={commit.headline}>{commit.headline}</span>
                            {commit.author ? (
                                <span className={cn('inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 self-center typography-micro', REFERENCE_META_TEXT)}>
                                    {commit.avatarUrl ? (
                                        <img src={commit.avatarUrl} alt="" className="size-3.5 shrink-0 rounded-full" loading="lazy" />
                                    ) : null}
                                    <span className="truncate">{commit.author}</span>
                                </span>
                            ) : null}
                            {when ? <span className={cn('shrink-0 typography-micro', REFERENCE_META_TEXT)}>{when}</span> : null}
                        </li>
                    );
                })}
            </ul>
        </>
    );
};

/**
 * The thread under a preview, drawn like the PR view's comments: avatar on a
 * line, then the comment. Bodies render images and the HTML GitHub allows.
 * A PR's commits sit on the same line, grouped between the comments.
 */
export const ReferenceComments: React.FC<{
    entries: ReferenceTimelineEntry[];
    now: number;
    /** Pins one comment above the composer; shown on hover beside its author. */
    onAttachComment?: (comment: ReferenceCommentItem) => void;
}> = ({ entries, now, onAttachComment }) => {
    const { t } = useI18n();
    return (
        <div className="flex flex-col">
            {entries.map((entry, index) => {
                const isLast = index === entries.length - 1;
                return (
                    <div key={entry.key} className="group relative pb-4 pl-9 last:pb-0">
                        {!isLast ? <div className="absolute bottom-1 left-3 top-8 w-px bg-border/60" /> : null}
                        {entry.kind === 'commits' ? <CommitGroup group={entry} now={now} /> : (
                            <>
                                <div className="absolute left-0 top-0 flex size-6 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated typography-micro text-muted-foreground">
                                    {entry.avatarUrl ? (
                                        <img src={entry.avatarUrl} alt="" className="size-full object-cover" loading="lazy" />
                                    ) : (
                                        <span>{(entry.author ?? '?').slice(0, 1).toUpperCase()}</span>
                                    )}
                                </div>
                                <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 typography-meta', REFERENCE_META_TEXT)}>
                                    <span className="font-medium text-muted-foreground">{entry.author ?? '—'}</span>
                                    {relativeLabel(t, entry.createdAt, now) ? <span>{relativeLabel(t, entry.createdAt, now)}</span> : null}
                                    {entry.context ? <span className="min-w-0 truncate font-mono typography-micro">{entry.context}</span> : null}
                                    {onAttachComment ? (
                                        <button
                                            type="button"
                                            onClick={() => onAttachComment(entry)}
                                            className="ml-auto inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                        >
                                            <Icon name="attachment-2" className="size-3.5" />
                                            {t('gitView.pr.actions.sendToAgent')}
                                        </button>
                                    ) : null}
                                </div>
                                {entry.body.trim() ? (
                                    <SimpleMarkdownRenderer
                                        content={entry.body}
                                        className="mt-1 [&_img]:h-auto [&_img]:max-w-full"
                                        enableFileReferences={false}
                                        allowRawHtml
                                    />
                                ) : null}
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
