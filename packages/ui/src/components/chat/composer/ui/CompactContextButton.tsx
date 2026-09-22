import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSession, useSessionMessages } from '@/sync/sync-context';
import {
    computeCompactContextUsage,
    formatCompactContextSummary,
    getCompactContextTone,
    type CompactContextUsage,
} from './compactContextUsage';

type CompactContextButtonViewProps = {
    usage: CompactContextUsage;
    isCompacting: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    onCompact: () => void;
};

type CompactContextButtonProps = Omit<CompactContextButtonViewProps, 'usage' | 'isCompacting'> & {
    sessionId: string;
    directory?: string;
};

const contextToneClass = {
    neutral: 'text-foreground',
    warning: 'text-[var(--status-warning)]',
    error: 'text-[var(--status-error)]',
} as const;

const CompactContextButtonView: React.FC<CompactContextButtonViewProps> = ({
    usage,
    isCompacting,
    footerIconButtonClass,
    iconSizeClass,
    onCompact,
}) => {
    const { t } = useI18n();
    const compactLabel = t('chat.commandAutocomplete.command.compactDescription');
    const contextSummary = formatCompactContextSummary(usage, t);
    const ariaLabel = `${compactLabel}. ${contextSummary}`;
    const tone = getCompactContextTone(usage);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                        contextToneClass[tone],
                        'hover:bg-[var(--interactive-hover)]/40',
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={onCompact}
                    disabled={isCompacting}
                    aria-busy={isCompacting || undefined}
                    aria-label={ariaLabel}
                >
                    <Icon
                        name={isCompacting ? 'loader-4' : 'scissors'}
                        className={cn(iconSizeClass, isCompacting && 'animate-spin')}
                        aria-hidden="true"
                    />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{compactLabel}</span>
                    <span>{contextSummary}</span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
};

export const CompactContextButton: React.FC<CompactContextButtonProps> = ({
    sessionId,
    directory,
    footerIconButtonClass,
    iconSizeClass,
    onCompact,
}) => {
    const messages = useSessionMessages(sessionId, directory);
    const session = useSession(sessionId, directory);
    const { context: contextLimit } = useContextWindowLimits(sessionId, directory);
    const usage = React.useMemo(
        () => computeCompactContextUsage(messages, contextLimit),
        [contextLimit, messages],
    );

    return (
        <CompactContextButtonView
            usage={usage}
            isCompacting={Boolean(session?.time?.compacting)}
            footerIconButtonClass={footerIconButtonClass}
            iconSizeClass={iconSizeClass}
            onCompact={onCompact}
        />
    );
};
