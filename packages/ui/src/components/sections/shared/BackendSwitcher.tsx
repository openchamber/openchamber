import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiArrowDownSLine } from '@remixicon/react';
import { BackendIcon } from '@/components/ui/BackendIcon';
import { useBackendsStore, type BackendCapabilities } from '@/stores/useBackendsStore';
import { cn } from '@/lib/utils';

interface BackendSwitcherProps {
  capability: keyof BackendCapabilities;
  selectedBackendId: string;
  onBackendChange: (backendId: string) => void;
  className?: string;
}

export const BackendSwitcher: React.FC<BackendSwitcherProps> = ({
  capability,
  selectedBackendId,
  onBackendChange,
  className,
}) => {
  const backends = useBackendsStore((state) => state.backends);

  const relevantBackends = React.useMemo(() => {
    return backends.filter((b) => b.available || b.comingSoon);
  }, [backends]);

  const selectedBackend = React.useMemo(() => {
    return relevantBackends.find((b) => b.id === selectedBackendId);
  }, [relevantBackends, selectedBackendId]);

  const label = selectedBackend?.label || selectedBackendId || 'Backend';

  if (relevantBackends.length <= 1) {
    return null;
  }

  return (
    <div className={cn(className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch backend"
            title="Switch backend"
            className={cn(
              'text-foreground border border-border/80 appearance-none flex h-8 w-full min-w-0 rounded-lg bg-transparent px-3 py-1 outline-none',
              'hover:border-input focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:border-primary/70',
              'flex items-center gap-1.5 text-left',
            )}
          >
            <BackendIcon backendId={selectedBackendId} className="h-4 w-4 opacity-70" />
            <span className="min-w-0 flex-1 truncate typography-ui-label font-medium">{label}</span>
            <RiArrowDownSLine className="size-4 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto">
          <DropdownMenuRadioGroup
            value={selectedBackendId}
            onValueChange={(value) => {
              if (!value) return;
              onBackendChange(value);
            }}
          >
            {relevantBackends.map((backend) => {
              const hasCapability = backend.capabilities[capability];
              const isDisabled = !backend.available || backend.comingSoon;
              return (
                <DropdownMenuRadioItem
                  key={backend.id}
                  value={backend.id}
                  disabled={isDisabled}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <BackendIcon backendId={backend.id} className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0 truncate typography-ui">{backend.label}</span>
                    {backend.comingSoon && (
                      <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-muted-foreground/60 bg-muted/40">
                        soon
                      </span>
                    )}
                    {!hasCapability && !backend.comingSoon && backend.available && (
                      <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-muted-foreground/60 bg-muted/40">
                        limited
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
