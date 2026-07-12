import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Text } from '@/components/ui/text';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MinDurationShineText } from './MinDurationShineText';
import type { ContextToolChildRow, ContextToolCounts, ContextToolGroupStatus } from './toolSegmentProjection';

const ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const ROW_TITLE_CLASS = cn('typography-meta font-medium', ROW_TEXT_CLASS);
const ROW_DESCRIPTION_CLASS = cn('typography-meta', ROW_TEXT_CLASS);

const TITLE_KEYS = {
    active: 'chat.toolGroup.context.title.active',
    error: 'chat.toolGroup.context.title.failed',
    done: 'chat.toolGroup.context.title.done',
} as const;

const SUMMARY_KEYS = {
    read: {
        single: 'chat.toolGroup.context.summary.readSingle',
        few: 'chat.toolGroup.context.summary.readPluralFew',
        many: 'chat.toolGroup.context.summary.readPluralMany',
    },
    search: {
        single: 'chat.toolGroup.context.summary.searchSingle',
        few: 'chat.toolGroup.context.summary.searchPluralFew',
        many: 'chat.toolGroup.context.summary.searchPluralMany',
    },
    list: {
        single: 'chat.toolGroup.context.summary.listSingle',
        few: 'chat.toolGroup.context.summary.listPluralFew',
        many: 'chat.toolGroup.context.summary.listPluralMany',
    },
} as const;

const CHILD_PRESENTATION = {
    read: { icon: 'file-text', labelKey: 'chat.toolGroup.context.child.read' },
    search: { icon: 'search', labelKey: 'chat.toolGroup.context.child.search' },
    list: { icon: 'folder', labelKey: 'chat.toolGroup.context.child.list' },
} as const;

interface ContextToolGroupRowProps {
    rowKey: string;
    status: ContextToolGroupStatus;
    counts: ContextToolCounts;
    children: ContextToolChildRow[];
    renderSignature: string;
    animateTailText: boolean;
    isExpanded: boolean;
    onToggleTool: (toolId: string) => void;
}

const ContextToolGroupRowInner: React.FC<ContextToolGroupRowProps> = ({
    rowKey,
    status,
    counts,
    children,
    animateTailText,
    isExpanded,
    onToggleTool,
}) => {
    const { locale, t } = useI18n();
    const isActive = status === 'active';
    const isError = status === 'error';
    const title = t(TITLE_KEYS[status]);
    const pluralRules = new Intl.PluralRules(locale);

    const getSummary = (kind: keyof ContextToolCounts, count: number): string | null => {
        if (count === 0) {
            return null;
        }
        const category = pluralRules.select(count);
        let form: keyof (typeof SUMMARY_KEYS)[typeof kind] = 'many';
        if (category === 'one') {
            form = 'single';
        } else if (category === 'few') {
            form = 'few';
        }
        return t(SUMMARY_KEYS[kind][form], { count });
    };
    const summaryParts = [
        getSummary('read', counts.read),
        getSummary('search', counts.search),
        getSummary('list', counts.list),
    ].filter((part): part is string => Boolean(part));
    const summary = [title, ...summaryParts].join(' ');
    const toggleLabel = isExpanded
        ? t('chat.toolGroup.context.actions.collapseWithSummary', { summary })
        : t('chat.toolGroup.context.actions.expandWithSummary', { summary });

    return (
        <Collapsible open={isExpanded} onOpenChange={() => onToggleTool(rowKey)}>
            <CollapsibleTrigger
                aria-label={toggleLabel}
                title={toggleLabel}
                className="group/context-tool w-full justify-start gap-x-1.5 rounded-xl py-1.5 pr-2 pl-px hover:bg-transparent"
                style={{ backgroundColor: 'transparent' }}
            >
                <Icon
                    name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                    className="h-3.5 w-3.5 flex-shrink-0"
                    style={{ color: isError ? 'var(--status-error)' : 'var(--tools-icon)' }}
                />
                <MinDurationShineText
                    active={isActive}
                    minDurationMs={1000}
                    className={cn(ROW_TITLE_CLASS, 'inline-flex flex-shrink-0 items-center opacity-85')}
                    style={{ color: isError ? 'var(--status-error)' : 'var(--tools-title)' }}
                    title={title}
                >
                    {title}
                </MinDurationShineText>
                {summaryParts.length > 0 ? (
                    <span className={cn('inline-flex min-w-0 items-center', ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        {summaryParts.join(' · ')}
                    </span>
                ) : null}
            </CollapsibleTrigger>
            <CollapsibleContent className="pl-5">
                <div className="space-y-1 pt-1 pb-1">
                    {children.map((child) => renderChildRow(child, animateTailText, t))}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};

const renderChildRow = (
    child: ContextToolChildRow,
    animateTailText: boolean,
    t: ReturnType<typeof useI18n>['t'],
) => {
    const childState = child.state;
    const presentation = CHILD_PRESENTATION[child.kind];
    const kindLabel = t(presentation.labelKey);
    return (
        <span
            key={child.id}
            className={cn(
                'flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5',
                childState === 'error' && 'bg-[var(--status-error-background)]'
            )}
            style={{
                color: childState === 'error' ? 'var(--status-error)' : 'var(--tools-description)',
            }}
            title={child.hint}
        >
            <Icon name={presentation.icon} className="h-3 w-3 flex-shrink-0" />
            <span className={cn('flex-shrink-0 font-medium', ROW_DESCRIPTION_CLASS)}>{kindLabel}</span>
            {childState === 'active' || childState === 'error' ? (
                <span className="flex-shrink-0 font-medium">
                    {childState === 'active' ? t('chat.toolGroup.context.child.active') : t('chat.toolGroup.context.child.error')}
                </span>
            ) : null}
            <Text
                variant={animateTailText && childState === 'active' ? 'generate-effect' : 'static'}
                className={cn('min-w-0 flex-1 truncate whitespace-nowrap', ROW_DESCRIPTION_CLASS)}
            >
                {child.hint}
            </Text>
        </span>
    );
};

export const ContextToolGroupRow = React.memo(ContextToolGroupRowInner, (prev, next) => {
    return prev.rowKey === next.rowKey
        && prev.status === next.status
        && prev.counts.read === next.counts.read
        && prev.counts.search === next.counts.search
        && prev.counts.list === next.counts.list
        && prev.renderSignature === next.renderSignature
        && prev.animateTailText === next.animateTailText
        && prev.isExpanded === next.isExpanded
        && prev.onToggleTool === next.onToggleTool;
});
