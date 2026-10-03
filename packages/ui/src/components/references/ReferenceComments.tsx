import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';

import { relativeTimeOf } from './referencePickerItems';

/** One comment in the preview's thread, from GitHub or Linear. */
export type ReferenceCommentItem = {
    key: string;
    author: string | null;
    avatarUrl: string | null;
    body: string;
    createdAt: string | null;
    /** What the comment is attached to: a review verdict, or `path:line`. */
    context: string | null;
};

/**
 * The thread under a preview, drawn like the PR view's comments: avatar on a
 * line, then the comment. Bodies render images and the HTML GitHub allows.
 */
export const ReferenceComments: React.FC<{ comments: ReferenceCommentItem[]; now: number }> = ({ comments, now }) => {
    const { t } = useI18n();
    return (
        <div className="flex flex-col">
            {comments.map((comment, index) => {
                const relative = relativeTimeOf(comment.createdAt, now);
                const isLast = index === comments.length - 1;
                return (
                    <div key={comment.key} className="relative pb-4 pl-9 last:pb-0">
                        {!isLast ? <div className="absolute bottom-1 left-3 top-8 w-px bg-border/60" /> : null}
                        <div className="absolute left-0 top-0 flex size-6 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated typography-micro text-muted-foreground">
                            {comment.avatarUrl ? (
                                <img src={comment.avatarUrl} alt="" className="size-full object-cover" loading="lazy" />
                            ) : (
                                <span>{(comment.author ?? '?').slice(0, 1).toUpperCase()}</span>
                            )}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-meta text-muted-foreground">
                            <span className="font-medium text-foreground">{comment.author ?? '—'}</span>
                            {relative ? (
                                <span>{relative.key === 'common.relative.justNow' ? t(relative.key) : t(relative.key, { count: relative.count })}</span>
                            ) : null}
                            {comment.context ? <span className="min-w-0 truncate font-mono typography-micro">{comment.context}</span> : null}
                        </div>
                        {comment.body.trim() ? (
                            <SimpleMarkdownRenderer
                                content={comment.body}
                                className="mt-1 [&_img]:h-auto [&_img]:max-w-full"
                                enableFileReferences={false}
                                allowRawHtml
                            />
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
};
