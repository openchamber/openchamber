import React from 'react';

import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';

export type DiffViewMode = 'side-by-side' | 'unified';

interface DiffViewToggleProps {
    mode: DiffViewMode;
    onModeChange: (mode: DiffViewMode) => void;
    className?: string;
    iconClassName?: string;
}

export const DiffViewToggle: React.FC<DiffViewToggleProps> = ({ mode, onModeChange, className, iconClassName }) => {
    const { t } = useI18n();
    const handleClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            onModeChange(mode === 'side-by-side' ? 'unified' : 'side-by-side');
        },
        [mode, onModeChange]
    );

    return (
        <ToolbarTooltipButton
            label={t('diffView.layout.sideBySide')}
            icon="layout-column"
            pressed={mode === 'side-by-side'}
            className={className}
            iconClassName={iconClassName}
            onClick={handleClick}
        />
    );
};
