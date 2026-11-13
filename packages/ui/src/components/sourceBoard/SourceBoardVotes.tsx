import * as React from 'react';

import { REFERENCE_META_TEXT } from '@/components/references/referencePickerItems';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatVoteValue } from '@/lib/source-control/reviewLabels';
import type { ChangeRequestVoteLabel } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

/**
 * The labels a votes host lets this account vote on, one row each: the
 * label's name, the values it may cast, and who voted what. A value is
 * picked or unpicked in place; nothing is sent until the reply's Vote. Labels
 * the account may not vote on are left out.
 */
export const SourceBoardVotes: React.FC<{
    labels: ChangeRequestVoteLabel[];
    /** The picked value per label name. */
    votes: Record<string, number>;
    onChange: (votes: Record<string, number>) => void;
    disabled: boolean;
}> = ({ labels, votes, onChange, disabled }) => {
    const { t } = useI18n();
    const votable = labels.filter((label) => label.permitted.length > 0);
    if (votable.length === 0) return null;

    const pick = (label: string, value: number) => {
        const next = { ...votes };
        if (next[label] === value) delete next[label];
        else next[label] = value;
        onChange(next);
    };

    return (
        <div className="flex flex-col gap-1.5" role="group" aria-label={t('sourceBoard.vote.label')}>
            {votable.map((label) => {
                const descriptions = new Map(label.values.map((entry) => [entry.value, entry.description]));
                const cast = label.votes.filter((vote) => vote.value !== 0);
                return (
                    <div key={label.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="w-28 shrink-0 truncate typography-meta text-foreground" title={label.name}>{label.name}</span>
                        <span className="inline-flex flex-wrap items-center gap-1">
                            {[...label.permitted].sort((left, right) => left - right).map((value) => (
                                <Button
                                    key={value}
                                    type="button"
                                    variant="chip"
                                    size="xs"
                                    className="tabular-nums"
                                    aria-pressed={votes[label.name] === value}
                                    aria-label={t('sourceBoard.vote.valueAria', { label: label.name, value: formatVoteValue(value) })}
                                    title={descriptions.get(value)}
                                    disabled={disabled}
                                    onClick={() => pick(label.name, value)}
                                >
                                    {formatVoteValue(value)}
                                </Button>
                            ))}
                        </span>
                        {cast.length > 0 ? (
                            <span className={cn('min-w-0 truncate typography-meta', REFERENCE_META_TEXT)}>
                                {cast.map((vote) => t('sourceBoard.vote.byUser', { user: vote.user.username, value: formatVoteValue(vote.value) })).join(', ')}
                            </span>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
};
