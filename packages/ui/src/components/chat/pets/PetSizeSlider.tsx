import React from 'react';
import { useI18n } from '@/lib/i18n';

interface PetSizeSliderProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
}

export const PetSizeSlider: React.FC<PetSizeSliderProps> = ({
    value,
    onChange,
    min = 0.5,
    max = 1.5,
    step = 0.05,
}) => {
    const { t } = useI18n();
    const percentage = Math.round(value * 100);

    return (
        <div className="flex items-center gap-4">
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-[var(--surface-muted)] accent-foreground"
                aria-label={t('settings.page.pets.field.petSize')}
            />
            <span className="w-12 text-right text-sm tabular-nums">{percentage}%</span>
        </div>
    );
};
