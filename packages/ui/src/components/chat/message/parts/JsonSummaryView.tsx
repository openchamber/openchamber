import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { BlockLine } from './BlockLine';

const IDENTITY_KEYS = new Set(['id', 'identifier', 'title', 'name']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const formatKey = (key: string) => key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());

const getIdentity = (record: Record<string, unknown>): string | null => {
    const id = typeof record.id === 'string' ? record.id : typeof record.identifier === 'string' ? record.identifier : '';
    const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : '';
    if (id && title) return `${id} · ${title}`;
    return title || id || null;
};

const isUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

/**
 * One collapsible section of the summary.
 *
 * The chevron follows this `<details>`' own state. A shared `group-open`
 * variant also matches an open ancestor, so a nested row that was still
 * collapsed kept pointing down for as long as the section around it was open.
 */
const JsonSummarySection = React.memo(({
    summary,
    initiallyOpen,
    children,
}: {
    summary: string;
    initiallyOpen: boolean;
    children: React.ReactNode;
}) => {
    const [expanded, setExpanded] = React.useState(initiallyOpen);
    return (
        <details
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 typography-meta text-foreground hover:text-muted-foreground">
                <Icon
                    name="arrow-right-s"
                    className={cn(
                        'h-3.5 w-3.5 shrink-0 transition-transform',
                        expanded && 'rotate-90 rtl:-rotate-90',
                    )}
                />
                <span className="min-w-0 truncate font-medium">{summary}</span>
            </summary>
            <div className="relative ms-1 ps-3 pb-1">
                <BlockLine bottomOffset={4} />
                {children}
            </div>
        </details>
    );
});

JsonSummarySection.displayName = 'JsonSummarySection';

const JsonSummaryValue = React.memo(({
    value,
    label,
    depth,
}: {
    value: unknown;
    label?: string;
    depth: number;
}) => {
    if (Array.isArray(value)) {
        const summary = label ? `${formatKey(label)} (${value.length})` : `(${value.length})`;
        return (
            <JsonSummarySection summary={summary} initiallyOpen={depth < 2}>
                <div className="space-y-1">
                {value.map((item, index) => <JsonSummaryValue key={index} value={item} depth={depth + 1} />)}
                </div>
            </JsonSummarySection>
        );
    }

    if (isRecord(value)) {
        const identity = getIdentity(value);
        const entries = Object.entries(value).filter(([key]) => !IDENTITY_KEYS.has(key));
        const summary = label ? `${formatKey(label)}${identity ? ` · ${identity}` : ''}` : identity;
        const content = (
            <div className="space-y-1">
                {entries.map(([key, entry]) => <JsonSummaryValue key={key} label={key} value={entry} depth={depth + 1} />)}
            </div>
        );

        if (!label && depth === 0) {
            return <div className="space-y-2">{identity ? <div className="typography-meta font-medium text-foreground">{identity}</div> : null}{content}</div>;
        }

        return (
            <JsonSummarySection
                summary={summary ?? (label ? formatKey(label) : '{}')}
                initiallyOpen={depth < 2}
            >
                {content}
            </JsonSummarySection>
        );
    }

    const text = value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    const renderedValue = typeof value === 'string' && isUrl(value) ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className="truncate text-[var(--status-info)] underline underline-offset-2 hover:opacity-80" title={value}>{value}</a>
    ) : (
        <span className={cn('min-w-0 break-words', value === null ? 'text-muted-foreground' : 'text-foreground')}>{text}</span>
    );

    return (
        <div className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-2 py-1 typography-meta">
            {label ? <span className="truncate text-muted-foreground" title={label}>{formatKey(label)}</span> : <span />}
            {renderedValue}
        </div>
    );
});

JsonSummaryValue.displayName = 'JsonSummaryValue';

export const JsonSummaryView = React.memo(({ data }: { data: unknown }) => (
    <div className="space-y-1">
        <JsonSummaryValue value={data} depth={0} />
    </div>
));

JsonSummaryView.displayName = 'JsonSummaryView';
