import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useWaitingBlink } from '@/hooks/useDurationTicker';

type HydratingToolSkeletonRow = {
    id: string;
    titleWidth: string;
    detailWidth: string;
};

const HYDRATING_SKELETON_ITEMS: Array<{
    id: number;
    toolRows: HydratingToolSkeletonRow[];
    textWidths: [string, string, string];
}> = [
    {
        id: 1,
        toolRows: [
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-52' },
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-36' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-64' },
        ],
        textWidths: ['w-24', 'w-[92%]', 'w-[78%]'],
    },
    {
        id: 2,
        toolRows: [
            { id: 'read', titleWidth: 'w-20', detailWidth: 'w-40' },
            { id: 'search', titleWidth: 'w-24', detailWidth: 'w-48' },
        ],
        textWidths: ['w-20', 'w-[88%]', 'w-[70%]'],
    },
    {
        id: 3,
        toolRows: [
            { id: 'shell', titleWidth: 'w-28', detailWidth: 'w-44' },
            { id: 'edit', titleWidth: 'w-24', detailWidth: 'w-56' },
        ],
        textWidths: ['w-24', 'w-[84%]', 'w-[64%]'],
    },
];

export const HydrationSkeleton: React.FC<{ waiting: boolean }> = ({ waiting }) => {
    const blink = useWaitingBlink(waiting);
    return (
        <div className={cn('space-y-4', blink)}>
            {HYDRATING_SKELETON_ITEMS.map((item) => (
                <div key={item.id} className="group w-full">
                    <div className="chat-message-column">
                        <div className="space-y-2.5 px-4 py-3">
                            <div className="space-y-1.5">
                                {item.toolRows.map((row) => (
                                    <div key={`${item.id}-${row.id}`} className="flex items-center gap-2">
                                        <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
                                        <Skeleton className={cn('h-4 rounded-md', row.titleWidth)} />
                                        <Skeleton className={cn('h-4 rounded-md', row.detailWidth)} />
                                    </div>
                                ))}
                            </div>
                            <div className="space-y-1.5 pt-1">
                                {item.textWidths.map((width, index) => (
                                    <Skeleton key={`${item.id}-text-${index}`} className={cn('h-4 rounded-md', width)} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};
