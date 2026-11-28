import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { trackerStateGlyph } from '@/lib/trackers/stateLook';
import type { TrackerDescriptor, TrackerItemSummary } from '@/lib/trackers/types';
import { cn } from '@/lib/utils';

import { MetaRow } from './ReferenceMetaEditors';
import { ReferenceLabelChips } from './ReferencePickerRow';
import { REFERENCE_META_TEXT, TRACKER_PRIORITY_KEYS } from './referencePickerItems';

export const RelatedTrackerItem: React.FC<{
    issue: TrackerItemSummary;
    onOpen?: (issue: TrackerItemSummary) => void;
    showAssignee?: boolean;
}> = ({ issue, onOpen, showAssignee = false }) => {
    const look = trackerStateGlyph(issue.state?.category);
    const assignee = issue.assignee?.name;
    const content = (
        <>
            <Icon name={look.icon} className="size-3.5 shrink-0" style={{ color: look.color }} />
            <span className={cn('shrink-0 font-mono', REFERENCE_META_TEXT)}>{issue.identifier}</span>
            <span dir="auto" className="min-w-0 truncate">{issue.title}</span>
            {showAssignee && assignee ? (
                <span className={cn('ms-auto shrink-0 ps-2', REFERENCE_META_TEXT)}>{assignee}</span>
            ) : null}
        </>
    );
    const className = 'flex w-full min-w-0 items-center gap-1.5 text-start typography-meta';
    if (!onOpen) return <span className={cn(className, 'text-muted-foreground')}>{content}</span>;
    return (
        <button
            type="button"
            onClick={() => onOpen(issue)}
            title={issue.title}
            className={cn(className, 'rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring')}
        >
            {content}
        </button>
    );
};

export const TrackerItemMeta: React.FC<{
    issue: TrackerItemSummary;
    parent: TrackerItemSummary | null;
    assignee: string | null | undefined;
    updated: string | null;
    labels: { name: string; color: string | null }[];
    capabilities: Pick<TrackerDescriptor['capabilities'], 'priority' | 'fields'>;
    onOpenIssue?: (issue: TrackerItemSummary) => void;
}> = ({ issue, parent, assignee, updated, labels, capabilities, onOpenIssue }) => {
    const { t } = useI18n();
    const fields = capabilities.fields ? issue.fields ?? [] : [];
    return (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
            {parent ? (
                <MetaRow label={t('references.picker.preview.parent')}>
                    <RelatedTrackerItem issue={parent} onOpen={onOpenIssue} />
                </MetaRow>
            ) : null}
            {assignee ? <MetaRow label={t('references.picker.preview.assignee')}>{assignee}</MetaRow> : null}
            {issue.container ? <MetaRow label={t(trackerPresentation(issue.provider).copy.containerMeta)}>{issue.container.name}</MetaRow> : null}
            {capabilities.priority && issue.priority && issue.priority !== 'none' ? (
                <MetaRow label={t('references.picker.preview.priority')}>{t(TRACKER_PRIORITY_KEYS[issue.priority])}</MetaRow>
            ) : null}
            {fields.map((field) => (
                <MetaRow key={field.id} label={field.label}>{field.value}</MetaRow>
            ))}
            {updated ? <MetaRow label={t('references.picker.preview.updated')}>{updated}</MetaRow> : null}
            {labels.length > 0 ? (
                <MetaRow label={t('references.picker.preview.labels')}><ReferenceLabelChips labels={labels} /></MetaRow>
            ) : null}
        </dl>
    );
};
