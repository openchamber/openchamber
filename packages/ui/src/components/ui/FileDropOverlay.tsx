import React from 'react';

import { cn } from '@/lib/utils';

type FileDropOverlayProps = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  rounded?: boolean;
  pointerEventsNone?: boolean;
};

export const FileDropOverlay: React.FC<FileDropOverlayProps> = ({
  title,
  subtitle,
  icon,
  action,
  className,
  contentClassName,
  titleClassName,
  subtitleClassName,
  rounded = false,
  pointerEventsNone = false,
}) => {
  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm',
        rounded && 'rounded-xl',
        pointerEventsNone && 'pointer-events-none',
        className,
      )}
    >
      <div className={cn('text-center', contentClassName)}>
        {action ? <div className="inline-flex justify-center">{action}</div> : icon}
        <div className={cn('typography-ui font-medium text-foreground', titleClassName)}>{title}</div>
        {subtitle ? (
          <div className={cn('mt-1 typography-meta text-muted-foreground', subtitleClassName)}>
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
};
