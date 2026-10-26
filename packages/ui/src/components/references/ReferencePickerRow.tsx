import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import type { CISummary, Label, ChangeRequestListStatus, RepositoryDiscussionReference, TrackerLabel, TrackerProgress } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { trackerStateGlyph } from '@/lib/trackers/stateLook';
import { cn } from '@/lib/utils';

import {
    repositoryStateLook,
    labelColor,
    REFERENCE_META_TEXT,
    relativeTimeOf,
    type ReferencePickerItem,
    referenceNumberLabel,
    TRACKER_PRIORITY_KEYS,
} from './referencePickerItems';
import { joinProjectPath } from '@/lib/source-control/projectPath';

type ChipLabel = { name: string; color: string | null };

const toLabels = (labels: ReadonlyArray<Label | TrackerLabel> | undefined): ChipLabel[] => (
    (labels ?? []).map((label) => ({ name: label.name, color: labelColor(label.color) }))
);

// GitHub serves any size; a row needs 32 px (16 px at 2x), not the full image.
const rowAvatarUrl = (url: string): string => {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'avatars.githubusercontent.com') return url;
        parsed.searchParams.set('s', '32');
        return parsed.toString();
    } catch {
        return url;
    }
};

/** Who an item belongs to: avatar, or the name's initial, then the name. */
const RowPerson: React.FC<{ name: string; avatarUrl: string | null | undefined }> = ({ name, avatarUrl }) => (
    <span className="inline-flex min-w-0 items-center gap-1">
        {avatarUrl ? (
            <img src={rowAvatarUrl(avatarUrl)} alt="" loading="lazy" className="size-4 shrink-0 rounded-full bg-surface-muted" />
        ) : (
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] leading-none">
                {name.slice(0, 1).toUpperCase()}
            </span>
        )}
        <span className="truncate">{name}</span>
    </span>
);

export const ReferenceLabelChips: React.FC<{ labels: ChipLabel[]; max?: number }> = ({ labels, max }) => {
    if (labels.length === 0) return null;
    const shown = max === undefined ? labels : labels.slice(0, max);
    const hidden = labels.length - shown.length;
    return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {shown.map((label) => (
                <span
                    key={label.name}
                    className={cn('max-w-[9rem] truncate typography-micro', REFERENCE_META_TEXT)}
                >
                    {/* `align-middle` centres on the lowercase letters, not the line box. */}
                    <span
                        className="me-1 inline-block size-1.5 rounded-full align-middle"
                        style={{ backgroundColor: label.color ?? 'var(--surface-muted-foreground)' }}
                    />
                    {label.name}
                </span>
            ))}
            {hidden > 0 ? <span className={cn('typography-micro', REFERENCE_META_TEXT)}>+{hidden}</span> : null}
        </span>
    );
};

/** A parent item's children: finished of all, or only how many when not all were counted. */
const SubIssueCount: React.FC<{ progress: TrackerProgress }> = ({ progress }) => {
    const { t } = useI18n();
    const label = progress.more
        ? t('references.picker.tracker.childrenMany', { count: progress.total })
        : t('references.picker.tracker.childrenDone', { done: progress.done, total: progress.total });
    return (
        <span className="inline-flex items-center gap-0.5 tabular-nums" title={label} aria-label={label}>
            <Icon name="node-tree" className="size-3.5" />
            {progress.more ? `${progress.total}+` : `${progress.done}/${progress.total}`}
        </span>
    );
};

/** A discussion's category: its emoji, when it has one, and its name. */
export const DiscussionCategory: React.FC<{ category: RepositoryDiscussionReference['category'] }> = ({ category }) => (
    <span className="inline-flex min-w-0 max-w-[12rem] items-center gap-1">
        {category.emoji ? <span aria-hidden className="shrink-0">{category.emoji}</span> : null}
        <span className="truncate">{category.name}</span>
    </span>
);

export const ChecksGlyph: React.FC<{ checks: CISummary | null }> = ({ checks }) => {
    if (!checks || checks.total === 0) return null;
    if (checks.state === 'failure') return <Icon name="close-circle" className="size-3.5 text-[var(--status-error)]" />;
    if (checks.state === 'pending') return <Icon name="time" className="size-3.5 text-[var(--status-warning)]" />;
    if (checks.state === 'success') return <Icon name="checkbox-circle" className="size-3.5 text-[var(--status-success)]" />;
    return null;
};

type RowProps = {
    item: ReferencePickerItem;
    /** An open PR's checks and mergeability, once they have arrived. */
    pullStatus: ChangeRequestListStatus | null;
    highlighted: boolean;
    /** Null in single-choice mode, where rows have no checkbox. */
    checked: boolean | null;
    diffIncluded: boolean;
    /** Names the repository on every row, as it does on a fork's upstream items: the list spans several. */
    showRepository?: boolean;
    now: number;
    onHighlight: () => void;
    onToggle: () => void;
    onActivate: () => void;
};

export const ReferencePickerRow = React.memo(function ReferencePickerRow({
    item,
    pullStatus,
    highlighted,
    checked,
    diffIncluded,
    showRepository = false,
    now,
    onHighlight,
    onToggle,
    onActivate,
}: RowProps) {
    const { t } = useI18n();
    const descriptor = useSourceControlProvider(item.source === 'repository' ? item.reference.provider : null);
    const tracker = item.source === 'tracker' ? item.item : null;
    const { capabilities } = useTrackerDescriptor(item.source === 'tracker' ? item.provider : null);
    const look = item.source === 'repository' ? repositoryStateLook(item.reference, pullStatus) : trackerStateGlyph(item.item.state?.category);
    const title = item.source === 'repository' ? item.reference.title : item.item.title;
    const id = item.source === 'repository' ? referenceNumberLabel(item.reference, descriptor) : item.item.identifier;
    const updated = relativeTimeOf(item.source === 'repository' ? item.reference.updatedAt : item.item.updatedAt, now);
    const labels = toLabels(item.source === 'repository' ? item.reference.labels : (capabilities.labels ? item.item.labels : undefined));
    const rowRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (highlighted) rowRef.current?.scrollIntoView({ block: 'nearest' });
    }, [highlighted]);

    return (
        <div
            ref={rowRef}
            role="option"
            aria-selected={highlighted}
            className={cn(
                'group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors',
                // The sidebar's session rows: the same tints for the chosen row and hover.
                highlighted ? 'bg-interactive-selection/70 text-interactive-selection-foreground' : 'hover:bg-interactive-hover/60',
            )}
            onClick={onHighlight}
            onDoubleClick={onActivate}
        >
            {checked !== null ? (
                <span className="flex h-5 items-center" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    <Checkbox checked={checked} onChange={onToggle} ariaLabel={t('references.picker.row.selectAria', { id })} />
                </span>
            ) : null}
            <Icon name={look.icon} className="mt-0.5 size-4 shrink-0" style={{ color: look.color }} />
            <div className="min-w-0 flex-1">
                {tracker?.parent && capabilities.children ? (
                    <div className={cn('mb-0.5 flex min-w-0 items-center gap-1 typography-micro', REFERENCE_META_TEXT)}>
                        <Icon name="corner-down-right" className="size-3.5 shrink-0" />
                        <span className="shrink-0 font-mono">{tracker.parent.identifier}</span>
                        <span className="truncate">{tracker.parent.title}</span>
                    </div>
                ) : null}
                <div className={cn('typography-ui-header font-semibold line-clamp-2 break-words', !highlighted && 'text-foreground')}>{title}</div>
                <div className={cn('mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 typography-micro', REFERENCE_META_TEXT)}>
                    <span className="font-mono">{id}</span>
                    {item.source === 'repository' && item.reference.author ? (
                        <RowPerson name={item.reference.author.login} avatarUrl={item.reference.author.avatarUrl} />
                    ) : null}
                    {tracker?.assignee ? (
                        <RowPerson name={tracker.assignee.name || '—'} avatarUrl={tracker.assignee.avatarUrl} />
                    ) : null}
                    {updated ? (
                        <span>{updated.key === 'common.relative.justNow' ? t(updated.key) : t(updated.key, { count: updated.count })}</span>
                    ) : null}
                    {item.source === 'repository' && item.reference.commentCount > 0 ? (
                        <span className="inline-flex items-center gap-0.5">
                            <Icon name="chat-1" className="size-3.5" />
                            {item.reference.commentCount}
                        </span>
                    ) : null}
                    {item.source === 'repository' && item.reference.kind === 'discussion' ? (
                        <>
                            {item.reference.upvotes > 0 ? (
                                <span className="inline-flex items-center gap-0.5" title={t('references.picker.discussion.upvotesTitle', { count: item.reference.upvotes })}>
                                    <Icon name="arrow-up" className="size-3.5" />
                                    {item.reference.upvotes}
                                </span>
                            ) : null}
                            <DiscussionCategory category={item.reference.category} />
                        </>
                    ) : null}
                    {item.source === 'repository' && item.reference.kind === 'pull' && diffIncluded ? (
                        <span className="inline-flex items-center gap-0.5" title={t('references.picker.preview.includeDiff')}>
                            <Icon name="file-code" className="size-3.5" />
                        </span>
                    ) : null}
                    {tracker?.progress && capabilities.children ? (
                        <SubIssueCount progress={tracker.progress} />
                    ) : null}
                    {tracker?.priority && tracker.priority !== 'none' && capabilities.priority ? (
                        <span>{t(TRACKER_PRIORITY_KEYS[tracker.priority])}</span>
                    ) : null}
                    {item.source === 'repository' && (showRepository || item.reference.sourceRepo.source === 'upstream') ? (
                        <span className="rounded bg-[var(--status-info-background)] px-1 typography-micro text-[var(--status-info-text)]">
                            {joinProjectPath(item.reference.sourceRepo.owner, item.reference.sourceRepo.repo)}
                        </span>
                    ) : null}
                    {labels.length > 0 ? (
                        <ReferenceLabelChips labels={labels} max={2} />
                    ) : null}
                </div>
            </div>
        </div>
    );
});
