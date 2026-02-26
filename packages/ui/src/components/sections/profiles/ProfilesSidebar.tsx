import React, { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useModelProfilesStore } from '@/stores/useModelProfilesStore';
import { ButtonSmall } from '@/components/ui/button-small';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiAddLine, RiAppsLine, RiLoader4Line } from '@remixicon/react';

interface ProfilesSidebarProps {
  onItemSelect?: () => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

export const ProfilesSidebar: React.FC<ProfilesSidebarProps> = ({ onItemSelect }) => {
  const {
    profiles,
    selectedProfileId,
    isLoading,
    loadProfiles,
    selectProfile,
    createFromCurrent,
  } = useModelProfilesStore();

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSaveCurrentConfig = async () => {
    const name = window.prompt('Profile name:');
    if (name && name.trim()) {
      const success = await createFromCurrent(name.trim());
      if (success) {
        onItemSelect?.();
      }
    }
  };

  const handleCreateNew = () => {
    selectProfile(null);
    onItemSelect?.();
  };

  const handleSelectProfile = (id: string) => {
    selectProfile(id);
    onItemSelect?.();
  };

  const bgClass = 'bg-background';

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">Model Profiles</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">Total {profiles.length}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ButtonSmall
                variant="ghost"
                className="h-7 w-7 px-0 -my-1 text-muted-foreground"
              >
                <RiAddLine className="h-3.5 w-3.5" />
              </ButtonSmall>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleSaveCurrentConfig}>
                Save Current Config
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCreateNew}>
                Create New
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {isLoading && profiles.length === 0 ? (
          <div className="py-12 px-4 flex justify-center text-muted-foreground">
            <RiLoader4Line className="h-6 w-6 animate-spin" />
          </div>
        ) : profiles.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiAppsLine className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">No profiles yet</p>
            <ButtonSmall
              variant="outline"
              className="mt-4 mx-auto"
              onClick={handleCreateNew}
            >
              Create Profile
            </ButtonSmall>
          </div>
        ) : (
          <>
            {profiles.map((profile) => {
              const isSelected = selectedProfileId === profile.id;
              const agentCount = Object.keys(profile.agentModels).length;
              return (
                <div
                  key={profile.id}
                  className={cn(
                    'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
                    isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center">
                    <button
                      onClick={() => handleSelectProfile(profile.id)}
                      className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      tabIndex={0}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="typography-ui-label font-normal truncate text-foreground">
                          {profile.name}
                        </span>
                      </div>
                      <div className="typography-micro text-muted-foreground/60 truncate leading-tight flex justify-between w-full mt-0.5">
                        <span>{agentCount} agent{agentCount !== 1 ? 's' : ''}</span>
                        <span>{formatRelativeTime(profile.updatedAt)}</span>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};
