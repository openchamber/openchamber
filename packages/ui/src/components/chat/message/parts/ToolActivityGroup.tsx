import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { dispatchRowExpand } from '../../lib/scroll/timelineScrollIntent';
import {
    isToolActivityGroupOpen,
    setToolActivityGroupOpen,
    toolActivityPluralCategory,
    trackToolActivityGroup,
    type ToolActivityPluralCategory,
} from '../../lib/turns/toolActivityGrouping';

const GROUP_LABEL_KEYS = {
    one: 'chat.toolActivity.groupLabel.one',
    few: 'chat.toolActivity.groupLabel.few',
    many: 'chat.toolActivity.groupLabel.many',
    other: 'chat.toolActivity.groupLabel.other',
} satisfies Record<ToolActivityPluralCategory, I18nKey>;

const FAILED_KEYS = {
    one: 'chat.toolActivity.failed.one',
    few: 'chat.toolActivity.failed.few',
    many: 'chat.toolActivity.failed.many',
    other: 'chat.toolActivity.failed.other',
} satisfies Record<ToolActivityPluralCategory, I18nKey>;

// A group keeps its disclosure across remounts and membership changes; the
// registry lives with the grouping logic (`toolActivityGrouping.ts`), which
// the height estimate also reads.

export function ToolActivityGroup({
    parts,
    children,
    partial = false,
}: {
    parts: readonly ToolPart[];
    children: React.ReactNode;
    partial?: boolean;
}) {
    const [, bumpOpenVersion] = React.useState(0);
    const groupId = React.useMemo(() => trackToolActivityGroup(parts), [parts]);
    const open = isToolActivityGroupOpen(parts);

    // Native `toggle` runs after the disclosure has opened, by which point the
    // transcript has already followed the grown content. Release follow on the
    // activation inputs instead, which all run before the default action.
    const releaseFollow = (element: HTMLElement) => {
        if (!open) dispatchRowExpand(element);
    };

    return (
        <details
            className="group/tool-activity"
            data-tool-activity-group=""
            open={open}
            onToggle={(event) => {
                setToolActivityGroupOpen(groupId, event.currentTarget.open);
                bumpOpenVersion((value) => value + 1);
            }}
        >
            <summary
                className="oc-static-tool-row flex w-full cursor-pointer list-none items-center gap-1.5 pe-2 ps-px py-1.5 text-start typography-meta text-[var(--tools-description)] hover:text-[var(--tools-title)] [&::-webkit-details-marker]:hidden"
                onPointerDown={(event) => releaseFollow(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') releaseFollow(event.currentTarget);
                }}
                onClick={(event) => releaseFollow(event.currentTarget)}
            >
                <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                    <Icon name="arrow-right-s" className="h-3.5 w-3.5 group-open/tool-activity:rotate-90 rtl:group-open/tool-activity:-rotate-90" />
                </span>
                <ToolActivitySummary parts={parts} partial={partial} />
            </summary>
            {children}
        </details>
    );
}

function ToolActivitySummary({ parts, partial = false }: { parts: readonly ToolPart[]; partial?: boolean }) {
    const { t, locale } = useI18n();
    const counts = new Map<string, number>();
    let errors = 0;
    for (const part of parts) {
        counts.set(part.tool, (counts.get(part.tool) ?? 0) + 1);
        if (part.state.status === 'error') errors += 1;
    }
    const summary = Array.from(counts, ([name, count]) => (count === 1 ? name : `${name} × ${count}`)).join(' · ');
    const label = t(GROUP_LABEL_KEYS[toolActivityPluralCategory(locale, parts.length)]);

    return (
        <span className="min-w-0 whitespace-normal break-words">
            <span className="whitespace-nowrap font-medium text-[var(--tools-title)]">
                <span className="tabular-nums">{partial ? '+' : ''}{parts.length}</span>{' '}
                {label}
                {errors > 0 ? (
                    <span className="text-[var(--status-error)]">
                        {t(FAILED_KEYS[toolActivityPluralCategory(locale, errors)], { count: errors })}
                    </span>
                ) : null}
            </span>{'\u2002\u200A'}<span className="text-[var(--tools-description)]">{summary}</span>
        </span>
    );
}
