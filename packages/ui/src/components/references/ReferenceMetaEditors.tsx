import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SourceBoardBase } from '@/components/sourceBoard/SourceBoardMetaEditors';
import type { RepositoryChangeRequestReference, RepositoryReferenceReviewer, SourceControlReadContext } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import { RowPerson } from './ReferencePickerRow';

export const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <>
        <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{label}</dt>
        <dd className="min-w-0 typography-meta text-muted-foreground">{children}</dd>
    </>
);

export const ReferenceBase: React.FC<{
    pull: RepositoryChangeRequestReference;
    branchHeads: boolean;
    canChange: boolean;
    context?: SourceControlReadContext | null;
    onChanged?: () => void | Promise<void>;
}> = ({ pull, branchHeads, canChange, context, onChanged }) => (
    <span className="flex min-w-0 items-center gap-1.5">
        {branchHeads ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                <span className="truncate">{pull.head}</span>
                <Icon name="arrow-right" className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{pull.base}</span>
            </span>
        ) : <span className="min-w-0 truncate font-mono">{pull.base}</span>}
        {canChange && context && onChanged ? <SourceBoardBase pull={pull} context={context} onChanged={onChanged} /> : null}
    </span>
);

export const ReferenceAssignees: React.FC<{
    control?: React.ReactNode;
    assignees: readonly RepositoryReferenceReviewer[];
}> = ({ control, assignees }) => (
    <>
        {control ?? (
            <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {assignees.map((person) => <RowPerson key={person.id} name={person.login} avatarUrl={person.avatarUrl} />)}
            </span>
        )}
    </>
);
