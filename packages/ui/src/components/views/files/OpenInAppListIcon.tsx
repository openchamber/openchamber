import React from 'react';
import { cn } from '@/lib/utils';

export const OpenInAppListIcon = ({ label, iconDataUrl }: { label: string; iconDataUrl?: string }) => {
  const [failed, setFailed] = React.useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  if (iconDataUrl && !failed) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        className="size-4 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        'size-4 rounded-sm flex items-center justify-center',
        'bg-[var(--surface-muted)] text-[9px] font-medium text-muted-foreground'
      )}
    >
      {initial}
    </span>
  );
};
