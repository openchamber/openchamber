import React from 'react';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';
import { useDraftProjectPickerOpen } from '@/hooks/useDraftProjectPicker';

export const DraftProjectName: React.FC<{ label: string; onOpenPicker?: () => void }> = ({ label, onOpenPicker }) => {
    const ref = React.useRef<HTMLSpanElement>(null);
    const pickerOpen = useDraftProjectPickerOpen();
    useWidthMorph(ref);
    const name = <span ref={ref} className="inline-block max-w-full overflow-hidden whitespace-nowrap align-top font-medium">{label}</span>;
    if (!onOpenPicker) return name;
    return (
        <button
            type="button"
            onClick={onOpenPicker}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            className="-mx-1.5 -my-2 inline-block max-w-full cursor-pointer rounded-md px-1.5 py-2 align-top text-start hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
        >
            {name}
        </button>
    );
};
