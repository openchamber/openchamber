import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import type { GitHubChecksSummary, GitHubIssueLabel, LinearIssueLabel } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import {
    githubStateLook,
    labelColor,
    LINEAR_PRIORITY_KEYS,
    linearStateLook,
    relativeTimeOf,
    type ReferencePickerItem,
} from './referencePickerItems';

type Label = { name: string; color: string | null };

const toLabels = (labels: ReadonlyArray<GitHubIssueLabel | LinearIssueLabel> | undefined): Label[] => (
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

export const ReferenceLabelChips: React.FC<{ labels: Label[]; max?: number }> = ({ labels, max }) => {
    if (labels.length === 0) return null;
    const shown = max === undefined ? labels : labels.slice(0, max);
    const hidden = labels.length - shown.length;
    return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {shown.map((label) => (
                <span
                    key={label.name}
                    className="max-w-[9rem] truncate typography-micro text-muted-foreground"
                >
                    {/* `align-middle` centres on the lowercase letters, not the line box. */}
                    <span
                        className="mr-1 inline-block size-1.5 rounded-full align-middle"
                        style={{ backgroundColor: label.color ?? 'var(--surface-muted-foreground)' }}
                    />
                    {label.name}
                </span>
            ))}
            {hidden > 0 ? <span className="typography-micro text-muted-foreground">+{hidden}</span> : null}
        </span>
    );
};

export const ChecksGlyph: React.FC<{ checks: GitHubChecksSummary | null }> = ({ checks }) => {
    if (!checks || checks.total === 0) return null;
    if (checks.state === 'failure') return <Icon name="close-circle" className="size-3.5 text-[var(--status-error)]" />;
    if (checks.state === 'pending') return <Icon name="time" className="size-3.5 text-[var(--status-warning)]" />;
    if (checks.state === 'success') return <Icon name="checkbox-circle" className="size-3.5 text-[var(--status-success)]" />;
    return null;
};

const Dot = () => <span aria-hidden className="text-muted-foreground/60">·</span>;

type RowProps = {
    item: ReferencePickerItem;
    highlighted: boolean;
    /** Null in single-choice mode, where rows have no checkbox. */
    checked: boolean | null;
    diffIncluded: boolean;
    now: number;
    onHighlight: () => void;
    onToggle: () => void;
    onActivate: () => void;
};

export const ReferencePickerRow = React.memo(function ReferencePickerRow({
    item,
    highlighted,
    checked,
    diffIncluded,
    now,
    onHighlight,
    onToggle,
    onActivate,
}: RowProps) {
    const { t } = useI18n();
    const look = item.source === 'github' ? githubStateLook(item.reference) : linearStateLook(item.issue);
    const title = item.source === 'github' ? item.reference.title : item.issue.title;
    const id = item.source === 'github' ? `#${item.reference.number}` : item.issue.identifier;
    const updated = relativeTimeOf(item.source === 'github' ? item.reference.updatedAt : item.issue.updatedAt, now);
    const labels = toLabels(item.source === 'github' ? item.reference.labels : item.issue.labels);
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
                highlighted ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
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
                <div className={cn('typography-ui-header font-semibold line-clamp-2 break-words', !highlighted && 'text-foreground')}>{title}</div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 typography-micro text-muted-foreground">
                    <span className="font-mono">{id}</span>
                    {item.source === 'github' && item.reference.author ? (
                        <>
                            <Dot />
                            <RowPerson name={item.reference.author.login} avatarUrl={item.reference.author.avatarUrl} />
                        </>
                    ) : null}
                    {item.source === 'linear' && item.issue.assignee ? (
                        <>
                            <Dot />
                            <RowPerson name={item.issue.assignee.displayName || item.issue.assignee.name || '—'} avatarUrl={item.issue.assignee.avatarUrl} />
                        </>
                    ) : null}
                    {updated ? (
                        <>
                            <Dot />
                            <span>{updated.key === 'common.relative.justNow' ? t(updated.key) : t(updated.key, { count: updated.count })}</span>
                        </>
                    ) : null}
                    {item.source === 'github' && item.reference.commentCount > 0 ? (
                        <span className="inline-flex items-center gap-0.5">
                            <Icon name="chat-1" className="size-3.5" />
                            {item.reference.commentCount}
                        </span>
                    ) : null}
                    {item.source === 'github' && item.reference.kind === 'pull' && diffIncluded ? (
                        <span className="inline-flex items-center gap-0.5" title={t('references.picker.preview.includeDiff')}>
                            <Icon name="file-code" className="size-3.5" />
                        </span>
                    ) : null}
                    {item.source === 'linear' && item.issue.priority && item.issue.priority > 0 ? (
                        <>
                            <Dot />
                            <span>{t(LINEAR_PRIORITY_KEYS[item.issue.priority])}</span>
                        </>
                    ) : null}
                    {item.source === 'github' && item.reference.sourceRepo.source === 'upstream' ? (
                        <span className="rounded bg-[var(--status-info-background)] px-1 typography-micro text-[var(--status-info-text)]">
                            {item.reference.sourceRepo.owner}/{item.reference.sourceRepo.repo}
                        </span>
                    ) : null}
                    {labels.length > 0 ? (
                        <span className="ml-1">
                            <ReferenceLabelChips labels={labels} max={2} />
                        </span>
                    ) : null}
                </div>
            </div>
        </div>
    );
});
