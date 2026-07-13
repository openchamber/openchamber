import React from 'react';
import { Icon } from '@/components/icon/Icon';

export function MultiHostEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
      <Icon
        name="computer"
        className="h-8 w-8 text-muted-foreground/50 mb-2"
      />
      <p className="typography-ui-label font-semibold text-muted-foreground">
        No hosts connected
      </p>
      <p className="typography-meta mt-1 text-muted-foreground/70">
        Add a remote host to see its sessions here
      </p>
    </div>
  );
}
