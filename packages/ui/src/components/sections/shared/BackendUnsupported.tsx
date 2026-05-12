import React from 'react';
import { RiCloudOffLine } from '@remixicon/react';
import { BackendIcon } from '@/components/ui/BackendIcon';

interface BackendUnsupportedProps {
  backendId: string;
  backendLabel: string;
  featureName: string;
  comingSoon?: boolean;
}

export const BackendUnsupported: React.FC<BackendUnsupportedProps> = ({
  backendId,
  backendLabel,
  featureName,
  comingSoon,
}) => {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
      <div className="relative">
        <BackendIcon backendId={backendId} className="h-8 w-8 text-muted-foreground/30" />
        <RiCloudOffLine className="absolute -bottom-1 -right-1 h-4 w-4 text-muted-foreground/50" />
      </div>
      <div className="max-w-xs space-y-1">
        <p className="typography-ui-label font-medium text-foreground/80">
          {comingSoon
            ? `${featureName} for ${backendLabel} is coming soon`
            : `${featureName} is not supported by ${backendLabel}`}
        </p>
        {!comingSoon && (
          <p className="typography-micro text-muted-foreground/60">
            Switch to a different backend to manage {featureName.toLowerCase()}.
          </p>
        )}
      </div>
    </div>
  );
};
