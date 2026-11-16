import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { TodoItem } from '@/lib/opencode/tools';
import { cn } from '@/lib/utils';
import { TODO_STATUS_ICON } from '../../todoStatus';

/**
 * The list a `todowrite` call set, in the agent's order: the order is the
 * plan, and this row is a record of that one call. Each item wraps, since the
 * whole point of opening the row is to read the items. Done and cancelled
 * items are muted and struck through, as in the Tasks section.
 */
export const TodoWriteList: React.FC<{ items: TodoItem[] }> = ({ items }) => (
    <ul className="min-w-0 space-y-1">
        {items.map((item, index) => {
            const icon = TODO_STATUS_ICON[item.status];
            const settled = item.status === 'completed' || item.status === 'cancelled';
            return (
                <li key={`${index}-${item.content}`} className="flex min-w-0 items-start gap-2 typography-meta">
                    {/* One line box tall, so the icon centers on the first line of a wrapped item. */}
                    <span className="flex h-[1lh] shrink-0 items-center">
                        <Icon name={icon.name} className={cn('size-3.5', !icon.color && 'text-muted-foreground')} style={icon.color ? { color: icon.color } : undefined} />
                    </span>
                    <span dir="auto" className={cn('min-w-0 whitespace-pre-wrap break-words', settled ? 'text-muted-foreground line-through' : 'text-foreground')}>
                        {item.content}
                    </span>
                </li>
            );
        })}
    </ul>
);
