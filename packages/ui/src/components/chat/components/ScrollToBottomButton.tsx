import React from 'react';
import { RiArrowDownLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ScrollToBottomButtonProps {
    visible: boolean;
    onClick: () => void;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, onClick }) => {
    return (
        <div
            className={cn(
                'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 transition-all duration-150',
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-2 scale-95 pointer-events-none',
            )}
        >
            <Button
                variant="outline"
                size="sm"
                onClick={onClick}
                className="size-8 rounded-full [corner-shape:round] p-0 shadow-none bg-background/95 hover:bg-interactive-hover"
                aria-label="Scroll to bottom"
            >
                <RiArrowDownLine className="h-4 w-4" />
            </Button>
        </div>
    );
};

export default React.memo(ScrollToBottomButton);
