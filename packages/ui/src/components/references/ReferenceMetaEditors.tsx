import * as React from 'react';

import type { RepositoryReferenceReviewer } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import { RowPerson } from './ReferencePickerRow';

export const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <>
        <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{label}</dt>
        <dd className="min-w-0 typography-meta text-muted-foreground">{children}</dd>
    </>
);

export const ReferenceAssigneesRow: React.FC<{
    control?: React.ReactNode;
    assignees: readonly RepositoryReferenceReviewer[];
}> = ({ control, assignees }) => {
    const { t } = useI18n();
    return (
        <MetaRow label={t('sourceBoard.assignees.label')}>
            {control ?? (
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {assignees.map((person) => <RowPerson key={person.id} name={person.login} avatarUrl={person.avatarUrl} />)}
                </span>
            )}
        </MetaRow>
    );
};

export const LoadError: React.FC<{ error: string }> = ({ error }) => {
    const { t } = useI18n();
    return <span className="text-[var(--status-error-text)]">{t('references.picker.error.load', { error })}</span>;
};
