import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import type { RepositoryReferenceReviewer } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ReviewerStateValue } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

export const ReviewerPerson: React.FC<{ person: RepositoryReferenceReviewer }> = ({ person }) => {
    const { broken, onError } = useAvatarImage(person.avatarUrl);
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {person.avatarUrl && !broken ? (
                <img src={person.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" onError={onError} />
            ) : person.avatarUrl ? (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] leading-none">
                    {person.login.slice(0, 1).toUpperCase()}
                </span>
            ) : null}
            <span className="truncate">{person.login}</span>
        </span>
    );
};

const REVIEWER_STATE = {
    approved: { icon: 'checkbox-circle', color: 'var(--status-success)', label: 'references.picker.preview.reviewer.approved' },
    changes_requested: { icon: 'error-warning', color: 'var(--status-error)', label: 'references.picker.preview.reviewer.changesRequested' },
    commented: { icon: 'chat-3', color: 'var(--status-info)', label: 'references.picker.preview.reviewer.commented' },
    pending: { icon: 'time', color: 'var(--muted-foreground)', label: 'references.picker.preview.reviewer.pending' },
    dismissed: { icon: 'eye-off', color: 'var(--muted-foreground)', label: 'references.picker.preview.reviewer.dismissed' },
} satisfies Record<ReviewerStateValue, { icon: React.ComponentProps<typeof Icon>['name']; color: string; label: I18nKey }>;

export const ReviewerState: React.FC<{ person: RepositoryReferenceReviewer; state?: ReviewerStateValue }> = ({ person, state }) => {
    const { t } = useI18n();
    if (!state) return <ReviewerPerson person={person} />;
    const marker = REVIEWER_STATE[state];
    const label = t(marker.label);
    return (
        <span
            className={cn('inline-flex min-w-0 items-center gap-1', state === 'dismissed' && 'text-muted-foreground')}
            title={label}
            data-reviewer-state={state}
        >
            <ReviewerPerson person={person} />
            <span
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full"
                style={{ color: marker.color, backgroundColor: `color-mix(in srgb, ${marker.color} 16%, transparent)` }}
            >
                <Icon name={marker.icon} className="size-3" />
            </span>
            <span className="sr-only">{label}</span>
        </span>
    );
};
