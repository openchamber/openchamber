import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { PullRequestStack, PullRequestStackLayer } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { REFERENCE_META_TEXT } from './referencePickerItems';

/** How a layer is drawn: an icon in a theme colour. */
type LayerLook = { icon: IconName; color: string };

/** A layer's state in the theme's PR colours; the previewed one takes its own live look. */
const layerLook = (layer: PullRequestStackLayer): LayerLook => {
    if (layer.state === 'merged') return { icon: 'git-merge', color: 'var(--pr-merged)' };
    if (layer.state === 'closed') return { icon: 'git-close-pull-request', color: 'var(--pr-closed)' };
    if (layer.draft) return { icon: 'git-pr-draft', color: 'var(--pr-draft)' };
    return { icon: 'git-pull-request', color: 'var(--pr-open)' };
};

/**
 * A stack as GitHub's stack map draws it: the top layer first, the branch the
 * stack lands on last. Each layer is one line, its state, number and title;
 * the previewed one is marked and drawn in its live colour. A layer opens on
 * click where the surface opens items (`onOpen`).
 */
export const PullStackRows: React.FC<{
    stack: PullRequestStack;
    /** The previewed PR's number. */
    current: number;
    /** `#12`, or `!12` for a GitLab merge request. */
    numberLabel: (number: number) => string;
    /** The previewed PR's look, which follows its checks. */
    currentLook: LayerLook;
    onOpen?: (layer: PullRequestStackLayer) => void;
}> = ({ stack, current, numberLabel, currentLook, onOpen }) => {
    const { t } = useI18n();
    const layers = [...stack.layers].reverse();
    return (
        <ol className="flex min-w-0 flex-col gap-1.5 typography-meta">
            {layers.map((layer) => {
                const isCurrent = layer.number === current;
                const look = isCurrent ? currentLook : layerLook(layer);
                const content = (
                    <>
                        <Icon name={look.icon} className="size-3.5 shrink-0" style={{ color: look.color }} />
                        <span className={cn('shrink-0', isCurrent ? 'text-foreground' : REFERENCE_META_TEXT)}>{numberLabel(layer.number)}</span>
                        <span className={cn('min-w-0 truncate', isCurrent && 'font-medium text-foreground')}>{layer.title}</span>
                    </>
                );
                return (
                    <li key={layer.number} className="min-w-0">
                        {onOpen && !isCurrent ? (
                            <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-1.5 rounded-md text-start text-muted-foreground/80 hover:text-foreground"
                                title={layer.title}
                                onClick={() => onOpen(layer)}
                            >
                                {content}
                            </button>
                        ) : (
                            <span className="flex min-w-0 items-center gap-1.5" title={layer.title} aria-current={isCurrent ? 'true' : undefined}>
                                {content}
                            </span>
                        )}
                    </li>
                );
            })}
            <li className={cn('flex min-w-0 items-center gap-1.5', REFERENCE_META_TEXT)} title={t('stacks.preview.trunk')}>
                <Icon name="git-branch" className="size-3.5 shrink-0" />
                <span className="truncate font-mono">{stack.base}</span>
            </li>
        </ol>
    );
};
