import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SourceBoardBase } from '@/components/sourceBoard/SourceBoardMetaEditors';
import type { RepositoryChangeRequestReference } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { cn } from '@/lib/utils';
import { REFERENCE_META_TEXT } from './referencePickerItems';
import { canChangeReferenceBase } from './referenceBaseChange';
import { useRepositoryReadContext } from './referenceSources';

export const ReferenceBranchRow: React.FC<{
    reference: RepositoryChangeRequestReference;
    branchHeads: boolean;
    directory: string | null;
    branchWriteAccess?: boolean;
    onChanged?: () => Promise<void>;
}> = ({ reference, branchHeads, directory, branchWriteAccess, onChanged }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const descriptor = useSourceControlProvider(reference.provider);
    const readContext = useRepositoryReadContext(directory);
    const context = readContext && readContext !== 'missing' ? readContext : null;
    const canChange = canChangeReferenceBase({
        linked: reference.linked === true,
        branchWriteAccess,
        baseChange: descriptor.features.baseChange,
        hasContext: context !== null,
        hasOnChanged: onChanged !== undefined,
    });

    return (
        <>
            <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{t('references.picker.preview.branch')}</dt>
            <dd className="min-w-0 typography-meta text-muted-foreground">
                <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
                    {branchHeads ? (
                        <span className="inline-flex max-w-full items-center gap-1 font-mono">
                            <span className="truncate">{reference.head}</span>
                            <Icon name="arrow-right" className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{reference.base}</span>
                        </span>
                    ) : (
                        <span className="block truncate font-mono">{reference.base}</span>
                    )}
                    {canChange && context && onChanged ? <SourceBoardBase pull={reference} context={context} onChanged={onChanged} sheet={isMobile} /> : null}
                </span>
            </dd>
        </>
    );
};
