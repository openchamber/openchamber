import * as React from 'react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/useLanguage';

interface GridLoaderProps {
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

const sizeConfig = {
  xs: { container: 'gap-[1px]', dot: 'h-[3px] w-[3px]' },
  sm: { container: 'gap-0.5', dot: 'h-1 w-1' },
  md: { container: 'gap-1', dot: 'h-1.5 w-1.5' },
  lg: { container: 'gap-1.5', dot: 'h-2 w-2' },
};

const getPulseDelayMs = (index: number): number => {
  return ((index % 3) + Math.floor(index / 3)) * 150;
};

const GridLoader: React.FC<GridLoaderProps> = ({ className, size = 'md' }) => {
  const { t } = useLanguage();
  const config = sizeConfig[size];

  return (
    <span
      className={cn('grid grid-cols-3 place-items-center', config.container, className)}
      style={{ width: '11px', height: '11px' }}
      aria-label={t('common.loading')}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          className={cn('shrink-0 rounded-full bg-current animate-grid-pulse', config.dot)}
          style={{ animationDelay: `${getPulseDelayMs(i)}ms` }}
        />
      ))}
    </span>
  );
};

export { GridLoader };
