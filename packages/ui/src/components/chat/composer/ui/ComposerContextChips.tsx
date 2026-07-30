/**
 * Context chips above the composer.
 *
 * Each chip stands for context that will be attached to the next message but
 * is not part of its text: review comments left in a diff, captured dev-server
 * logs, preview annotations, terminal selections. They are shown so the user
 * knows what is riding along and can drop any of it before sending.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { InlineCommentDraft, InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import type { Theme } from '@/types/theme';

export interface ComposerContextChipsProps {
    /** Terminal selections, which show their own label and line range. */
    terminalDrafts: readonly InlineCommentDraft[];
    reviewCount: number;
    prCommentCount: number;
    prCheckCount: number;
    previewConsoleCount: number;
    previewAnnotationCount: number;
    draftTarget: InlineCommentDraftTarget | null;
    onRemoveDraft: (target: InlineCommentDraftTarget, draftId: string) => void;
    onRemoveReviewDrafts: () => void;
    onRemovePreviewDrafts: (source: 'preview-console' | 'preview-annotation' | 'pr-comment' | 'pr-check') => void;
    colors: Theme['colors'];
}

/** A chip showing how many items of one kind are attached, with a clear action. */
function CountChip(props: {
    label: string;
    count: number;
    removeLabel: string;
    onRemove: () => void;
    colors: Theme['colors'];
    icon?: React.ReactNode;
}) {
    return (
        <div
            className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
            style={{
                backgroundColor: props.colors?.surface?.elevated,
                borderColor: props.colors?.interactive?.border,
            }}
        >
            {props.icon}
            <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
            <span className="text-xs font-semibold" style={{ color: props.colors?.status?.info }}>
                {props.count}
            </span>
            <button
                type="button"
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                style={{ minHeight: 0, minWidth: 0 }}
                onClick={props.onRemove}
                aria-label={props.removeLabel}
                title={props.removeLabel}
            >
                <Icon name="close" className="h-3 w-3" />
            </button>
        </div>
    );
}

export function ComposerContextChips(props: ComposerContextChipsProps) {
    const { t } = useI18n();
    const {
        terminalDrafts,
        reviewCount,
        prCommentCount,
        prCheckCount,
        previewConsoleCount,
        previewAnnotationCount,
        draftTarget,
        onRemoveDraft,
        onRemoveReviewDrafts,
        onRemovePreviewDrafts,
        colors,
    } = props;

    return (
        <div className="flex flex-wrap items-center gap-2 pb-2">
            {terminalDrafts.map((draft) => (
                <div
                    key={draft.id}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1"
                    title={draft.code}
                >
                    <Icon name="terminal" className="h-3.5 w-3.5" />
                    <span className="truncate text-xs font-medium text-[var(--surface-mutedForeground)]">
                        {t('chat.chatInput.terminalContext', {
                            terminal: draft.fileLabel,
                            start: draft.startLine,
                            end: draft.endLine,
                        })}
                    </span>
                    <button
                        type="button"
                        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--surface-mutedForeground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
                        onClick={() => draftTarget && onRemoveDraft(draftTarget, draft.id)}
                        aria-label={t('chat.chatInput.terminalContextRemove')}
                        title={t('chat.chatInput.terminalContextRemove')}
                    >
                        <Icon name="close" className="h-3 w-3" />
                    </button>
                </div>
            ))}

            {reviewCount > 0 ? (
                <CountChip
                    label={t('chat.chatInput.reviewComments')}
                    count={reviewCount}
                    removeLabel={t('chat.chatInput.reviewCommentsRemove')}
                    onRemove={onRemoveReviewDrafts}
                    colors={colors}
                />
            ) : null}

            {prCommentCount > 0 ? (
                <CountChip
                    label={t('chat.chatInput.prCommentContext')}
                    count={prCommentCount}
                    removeLabel={t('chat.chatInput.prCommentContextRemove')}
                    onRemove={() => onRemovePreviewDrafts('pr-comment')}
                    colors={colors}
                    icon={<Icon name="git-pull-request" className="h-3.5 w-3.5 text-muted-foreground" />}
                />
            ) : null}

            {prCheckCount > 0 ? (
                <CountChip
                    label={t('chat.chatInput.prCheckContext')}
                    count={prCheckCount}
                    removeLabel={t('chat.chatInput.prCheckContextRemove')}
                    onRemove={() => onRemovePreviewDrafts('pr-check')}
                    colors={colors}
                    icon={<Icon name="close-circle" className="h-3.5 w-3.5 text-[var(--status-error)]" />}
                />
            ) : null}

            {previewConsoleCount > 0 ? (
                <CountChip
                    label={t('chat.chatInput.devServerLogs')}
                    count={previewConsoleCount}
                    removeLabel={t('chat.chatInput.devServerLogsRemove')}
                    onRemove={() => onRemovePreviewDrafts('preview-console')}
                    colors={colors}
                />
            ) : null}

            {previewAnnotationCount > 0 ? (
                <CountChip
                    label={t('chat.chatInput.previewAnnotations')}
                    count={previewAnnotationCount}
                    removeLabel={t('chat.chatInput.previewContextRemove')}
                    onRemove={() => onRemovePreviewDrafts('preview-annotation')}
                    colors={colors}
                />
            ) : null}
        </div>
    );
}
