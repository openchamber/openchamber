/**
 * The linked GitHub issue or pull request shown above the composer.
 *
 * Linking one attaches its body — and for a PR its diff — as context on the
 * next send. The row exists so that context is visible and dismissible rather
 * than silently riding along, and clicking it reopens the picker to swap the
 * reference.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export interface LinkedReferenceRowProps {
    /** Shown before the title: `#12` for an issue, `PR #12` for a pull request. */
    numberLabel: React.ReactNode;
    title: string;
    url: string;
    author?: { login: string; avatarUrl?: string };
    /** A PR also shows its branches. */
    branches?: { head: string; base: string };
    openInBrowserLabel: string;
    removeLabel: string;
    onReopenPicker: () => void;
    onRemove: () => void;
}

export function LinkedReferenceRow(props: LinkedReferenceRowProps) {
    const { t } = useI18n();
    const {
        numberLabel,
        title,
        url,
        author,
        branches,
        openInBrowserLabel,
        removeLabel,
        onReopenPicker,
        onRemove,
    } = props;

    return (
        <div className="pb-2 w-full px-1">
            <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
                <button
                    type="button"
                    onClick={onReopenPicker}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
                >
                    {author?.avatarUrl ? (
                        <img
                            src={author.avatarUrl}
                            alt={author.login}
                            className="h-5 w-5 rounded-full flex-shrink-0"
                        />
                    ) : null}
                    <span className="text-muted-foreground flex-shrink-0">
                        {numberLabel}
                        {author ? (
                            <span className="ml-1">
                                {t('chat.chatInput.linked.byAuthor', { author: author.login })}
                            </span>
                        ) : null}
                    </span>
                    <span className="text-foreground truncate">{title}</span>
                    {branches ? (
                        <span className="text-muted-foreground flex-shrink-0 typography-meta">
                            {branches.head} → {branches.base}
                        </span>
                    ) : null}
                </button>
                <span className="flex items-center gap-0.5 flex-shrink-0">
                    <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                        aria-label={openInBrowserLabel}
                    >
                        <Icon name="external-link" className="h-4 w-4 text-muted-foreground" />
                    </a>
                    <button
                        type="button"
                        onClick={onRemove}
                        className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                        aria-label={removeLabel}
                        title={removeLabel}
                    >
                        <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                    </button>
                </span>
            </div>
        </div>
    );
}
