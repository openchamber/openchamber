import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type DiffViewMode = 'side-by-side' | 'unified';

interface DiffViewToggleProps {
    mode: DiffViewMode;
    onModeChange: (mode: DiffViewMode) => void;
    className?: string;
}

export const DiffViewToggle: React.FC<DiffViewToggleProps> = ({ mode, onModeChange, className }) => {
    const { t } = useI18n();
    const label = mode === 'side-by-side' ? t('diffView.layout.switchToUnified') : t('diffView.layout.switchToSideBySide');
    const handleClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onModeChange(mode === 'side-by-side' ? 'unified' : 'side-by-side');
        },
        [mode, onModeChange]
    );

    return (
        <Button
            size="sm"
            variant="ghost"
            className={cn('h-5 w-5 p-0 opacity-60 hover:opacity-100', className)}
            onClick={handleClick}
            title={label}
            aria-label={label}
        >
            {mode === 'side-by-side' ? (
                <Icon name="align-justify" className="h-3 w-3" />
            ) : (
                <Icon name="layout-column" className="h-3 w-3" />
            )}
        </Button>
    );
};
