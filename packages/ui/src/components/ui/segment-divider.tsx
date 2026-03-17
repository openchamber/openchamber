import React from 'react';
import { cn } from '@/lib/utils';

interface SegmentDividerProps {
  label: string;
  icon?: React.ReactNode;
  className?: string;
  ariaHidden?: boolean;
}

export const SegmentDivider: React.FC<SegmentDividerProps> = ({
  label,
  icon,
  className,
  ariaHidden = true,
}) => {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-1.5', className)} aria-hidden={ariaHidden}>
      <span className="h-px flex-1 bg-border/60" />
      <span className="inline-flex max-w-[80%] items-center gap-1 typography-micro text-muted-foreground">
        <span className="truncate" title={label}>{label}</span>
        {icon ?? null}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
};
