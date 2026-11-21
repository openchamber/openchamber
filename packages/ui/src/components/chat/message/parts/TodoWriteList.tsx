import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { TodoItem } from '@/lib/opencode/tools';
import { cn } from '@/lib/utils';
import { TODO_STATUS_ICON } from '../../todoStatus';

export const TodoWriteList: React.FC<{ items: TodoItem[] }> = ({ items }) => (
    <ul className="min-w-0 space-y-1">
        {items.map((item, index) => {
            const icon = TODO_STATUS_ICON[item.status];
            const settled = item.status === 'completed' || item.status === 'cancelled';
            return (
                <li key={`${index}-${item.content}`} className="flex min-w-0 items-start gap-2 typography-meta">
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
