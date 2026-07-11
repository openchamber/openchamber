import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

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
            <details open={depth < 2} className="group/json-summary">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 typography-meta text-[var(--surface-foreground)] hover:text-[var(--surface-mutedForeground)]">
                    <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/json-summary:rotate-90" />
                    <span className="min-w-0 truncate font-medium">{summary}</span>
                </summary>
                <div className="relative ml-1 pl-3 pb-1">
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-0 top-0 w-px bg-[var(--tools-border)]" />
                    <div className="space-y-1">
                    {value.map((item, index) => <JsonSummaryValue key={index} value={item} depth={depth + 1} />)}
                    </div>
                </div>
            </details>
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
            return <div className="space-y-2">{identity ? <div className="typography-meta font-medium text-[var(--surface-foreground)]">{identity}</div> : null}{content}</div>;
        }

        return (
            <details open={depth < 2} className="group/json-summary">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 typography-meta text-[var(--surface-foreground)] hover:text-[var(--surface-mutedForeground)]">
                    <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/json-summary:rotate-90" />
                    <span className="min-w-0 truncate font-medium">{summary ?? (label ? formatKey(label) : '{}')}</span>
                </summary>
                <div className="relative ml-1 pl-3 pb-1">
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-0 top-0 w-px bg-[var(--tools-border)]" />
                    {content}
                </div>
            </details>
        );
    }

    const text = value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    const renderedValue = typeof value === 'string' && isUrl(value) ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className="truncate text-[var(--status-info)] underline underline-offset-2 hover:opacity-80" title={value}>{value}</a>
    ) : (
        <span className={cn('min-w-0 break-words', value === null ? 'text-[var(--surface-mutedForeground)]' : 'text-[var(--surface-foreground)]')}>{text}</span>
    );

    return (
        <div className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-2 py-1 typography-meta">
            {label ? <span className="truncate text-[var(--surface-mutedForeground)]" title={label}>{formatKey(label)}</span> : <span />}
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
