import React from 'react';
import type { GuestTone } from '@openchamber/sdk';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { GuestToolCardResult, GuestToolCardView } from '@/lib/guests/tool-presentation';
import { cn } from '@/lib/utils';

import { ChatExternalLink } from './ChatExternalLink';

// Written out in full: the stylesheet is built from the class names it finds in the source.
const STATUS_TONE_CLASS = {
    neutral: 'oc-tile-inset text-muted-foreground',
    info: 'bg-[var(--status-info-background)] text-[var(--status-info-text)]',
    success: 'bg-[var(--status-success-background)] text-[var(--status-success-text)]',
    warning: 'bg-[var(--status-warning-background)] text-[var(--status-warning-text)]',
    error: 'bg-[var(--status-error-background)] text-[var(--status-error-text)]',
} satisfies Record<GuestTone, string>;

// Every text here is the tool's or the manifest's, in a language of its own:
// it takes its own direction and keeps the interface's alignment.

const StatusBadge: React.FC<{ status: NonNullable<GuestToolCardView['status']> }> = ({ status }) => (
    <span
        dir="auto"
        className={cn('max-w-[45%] shrink-0 truncate rounded px-1.5 py-0.5 typography-micro font-medium', STATUS_TONE_CLASS[status.tone])}
        title={status.text}
    >
        {status.text}
    </span>
);

const SingleCard: React.FC<{ card: GuestToolCardView }> = ({ card }) => {
    const hasHeader = card.label !== null || card.status !== null;
    const hasBody = card.title !== null || card.fields.length > 0 || card.link !== null;

    return (
        <div className="oc-tile w-full max-w-[560px] overflow-hidden rounded-lg">
            {hasHeader ? (
                <div className={cn('flex items-center gap-2 px-3 py-2', hasBody && 'border-b border-edge')}>
                    <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align font-mono typography-code text-muted-foreground" title={card.label ?? undefined}>
                        {card.label}
                    </span>
                    {card.status ? <StatusBadge status={card.status} /> : null}
                </div>
            ) : null}
            {hasBody ? (
                <div className="flex flex-col gap-3 px-3 py-3">
                    {card.title !== null ? (
                        <div dir="auto" className="oc-ui-start-align typography-ui-label font-semibold text-foreground [overflow-wrap:anywhere]">{card.title}</div>
                    ) : null}
                    {card.fields.length > 0 ? (
                        <dl className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-2.5">
                            {card.fields.map((field, index) => (
                                <div key={index} className="min-w-0">
                                    <dt dir="auto" className="truncate oc-ui-start-align typography-micro uppercase tracking-[0.12em] text-muted-foreground">{field.label}</dt>
                                    <dd dir="auto" className="oc-ui-start-align typography-meta text-foreground [overflow-wrap:anywhere]">{field.value}</dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}
                    {card.link ? (
                        <ChatExternalLink
                            href={card.link.url}
                            title={card.link.url}
                            className="ms-auto inline-flex max-w-full items-center gap-1 typography-meta text-primary hover:underline"
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <span dir="auto" className="truncate">{card.link.label}</span>
                            <Icon name="external-link" className="h-3 w-3 shrink-0" />
                        </ChatExternalLink>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

const ListRow: React.FC<{ row: GuestToolCardView; last: boolean }> = ({ row, last }) => {
    const field = row.fields[0];
    const fieldTitle = field ? `${field.label}: ${field.value}` : undefined;
    // Without a title the first field is the row's text, at every width: its own column hides in a narrow chat.
    const fieldLeads = row.title === null && field !== undefined;
    return (
        <li className={cn('flex items-center gap-3 px-3 py-2', !last && 'border-b border-edge')}>
            {row.label !== null ? (
                <span dir="auto" className="max-w-[35%] shrink-0 truncate font-mono typography-code text-muted-foreground" title={row.label}>{row.label}</span>
            ) : null}
            <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align typography-meta text-foreground" title={fieldLeads ? fieldTitle : row.title ?? undefined}>
                {fieldLeads ? field.value : row.title}
            </span>
            {field && !fieldLeads ? (
                <span
                    dir="auto"
                    className="hidden max-w-[30%] shrink-0 truncate typography-meta text-muted-foreground @[420px]:inline"
                    title={fieldTitle}
                >
                    {field.value}
                </span>
            ) : null}
            {row.status ? <StatusBadge status={row.status} /> : null}
        </li>
    );
};

/**
 * The expanded body of a tool call an extension declared as a card: one card
 * for an object, a compact list for an array, one row per item. Everything
 * shown was resolved by `resolveGuestToolCard`; this only draws it.
 */
export const GuestToolCard: React.FC<{ result: GuestToolCardResult }> = ({ result }) => {
    const { t } = useI18n();
    if (result.kind === 'card') return <SingleCard card={result.card} />;

    return (
        <div className="@container flex w-full flex-col gap-1">
            <ul className="oc-tile overflow-hidden rounded-lg">
                {result.rows.map((row, index) => (
                    <ListRow key={index} row={row} last={index === result.rows.length - 1} />
                ))}
            </ul>
            {result.hidden > 0 ? (
                <div className="typography-micro text-muted-foreground">
                    {t('chat.toolPart.moreRows', { count: result.hidden })}
                </div>
            ) : null}
        </div>
    );
};
