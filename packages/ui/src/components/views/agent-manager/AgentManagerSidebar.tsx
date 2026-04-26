import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiMore2Line,
  RiSearchLine,
  RiGitBranchLine,
  RiLoader4Line,
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAgentGroupsStore, type AgentGroup } from '@/stores/useAgentGroupsStore';
import { useAllSessionStatuses } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';

const formatRelativeTime = (timestamp: number): { unit: 'now' | 'minutes' | 'hours' | 'days'; count?: number } => {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));

  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: days };
};

interface AgentGroupItemProps {
  group: AgentGroup;
  isSelected: boolean;
  isBusy: boolean;
  onSelect: () => void;
}

const AgentGroupItem: React.FC<AgentGroupItemProps> = ({ group, isSelected, isBusy, onSelect }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const deleteGroupSessions = useAgentGroupsStore((s) => s.deleteGroupSessions);

  const handleDeleteGroup = React.useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    toast.info(t('agentManager.sidebar.toast.deletingGroup', { group: group.name }));
    const { failedIds, failedWorktreePaths } = await deleteGroupSessions(group.sessions, { removeWorktrees: true });
    if (failedIds.length === 0 && failedWorktreePaths.length === 0) {
      toast.success(t('agentManager.sidebar.toast.deletedGroup', { group: group.name }));
    } else {
      toast.error(t('agentManager.sidebar.toast.failedToDeleteGroup', { group: group.name }));
    }
    setIsDeleting(false);
    setConfirmOpen(false);
  }, [deleteGroupSessions, group.name, group.sessions, isDeleting, t]);

  const relativeTime = formatRelativeTime(group.lastActive);

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center rounded-md px-1.5 py-1.5 cursor-pointer',
          isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
        )}
        onClick={onSelect}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate typography-ui-label font-normal text-foreground">
                {group.name}
              </span>
              {isBusy && <RiLoader4Line className="h-3 w-3 animate-spin text-amber-500 flex-shrink-0" />}
            </div>
            <div className="flex items-center gap-2">
                <span className="typography-micro text-muted-foreground/60 flex items-center gap-1">
                  <RiGitBranchLine className="h-3 w-3" />
                  {group.sessionCount === 1
                    ? t('agentManager.sidebar.item.modelCountSingle', { count: group.sessionCount })
                    : t('agentManager.sidebar.item.modelCountPlural', { count: group.sessionCount })}
                </span>
              <span className="typography-micro text-muted-foreground/60">
                {relativeTime.unit === 'now'
                  ? t('agentManager.sidebar.relativeTime.now')
                  : relativeTime.unit === 'minutes'
                    ? t('agentManager.sidebar.relativeTime.minutes', { count: relativeTime.count ?? 0 })
                    : relativeTime.unit === 'hours'
                      ? t('agentManager.sidebar.relativeTime.hours', { count: relativeTime.count ?? 0 })
                      : t('agentManager.sidebar.relativeTime.days', { count: relativeTime.count ?? 0 })}
              </span>
            </div>
          </button>

          <div className="flex items-center gap-1.5 self-stretch">
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-3.5 w-[18px] items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    'opacity-0 group-hover:opacity-100',
                    menuOpen && 'opacity-100',
                  )}
                  aria-label={t('agentManager.sidebar.item.groupMenuAria')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <RiMore2Line className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[140px]">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setConfirmOpen(true);
                  }}
                >
                  {t('agentManager.sidebar.item.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('agentManager.sidebar.dialog.deleteGroupTitle')}</DialogTitle>
            <DialogDescription>
              {t('agentManager.sidebar.dialog.deleteGroupDescription', { group: group.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={isDeleting}>
              {t('agentManager.sidebar.dialog.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteGroup()} disabled={isDeleting}>
              {isDeleting ? t('agentManager.sidebar.dialog.deleting') : t('agentManager.sidebar.dialog.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

interface AgentManagerSidebarProps {
  className?: string;
  groups: AgentGroup[];
  selectedGroupName?: string | null;
  onGroupSelect?: (groupName: string) => void;
  onNewAgent?: () => void;
}

export const AgentManagerSidebar: React.FC<AgentManagerSidebarProps> = ({
  className,
  groups,
  selectedGroupName,
  onGroupSelect,
  onNewAgent,
}) => {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const isLoading = useAgentGroupsStore((s) => s.isLoading);

  // Session statuses for busy indicators
  const allStatuses = useAllSessionStatuses();
  const busyGroups = React.useMemo(() => {
    const set = new Set<string>();
    for (const group of groups) {
      if (group.sessions.some((s) => allStatuses[s.id]?.type === 'busy')) {
        set.add(group.name);
      }
    }
    return set;
  }, [groups, allStatuses]);

  const MAX_VISIBLE = 5;

  const filteredGroups = React.useMemo(() => {
    if (!searchQuery.trim()) return groups;
    const query = searchQuery.toLowerCase();
    return groups.filter(group =>
      group.name.toLowerCase().includes(query)
    );
  }, [searchQuery, groups]);

  const visibleGroups = showAll ? filteredGroups : filteredGroups.slice(0, MAX_VISIBLE);
  const remainingCount = filteredGroups.length - MAX_VISIBLE;

  return (
    <div className={cn('flex h-full flex-col text-foreground border-r border-border/30', className)}>
      {/* Search Input */}
      <div className="px-2.5 pt-3 pb-2">
        <div className="relative">
          <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('agentManager.sidebar.search.placeholder')}
            className="pl-8 h-8 rounded-lg border-border/40 bg-background/50 typography-meta"
          />
        </div>
      </div>

      {/* New Agent Button */}
      <div className="px-2.5 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 h-8"
          onClick={onNewAgent}
        >
          <RiAddLine className="h-4 w-4" />
          <span className="typography-ui-label">{t('agentManager.sidebar.actions.newAgentGroup')}</span>
        </Button>
      </div>

      {/* Agent Groups Section Header */}
      <div className="px-2.5 py-1.5 flex items-center gap-1">
        <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
        <span className="typography-micro font-medium text-muted-foreground uppercase tracking-wider">
          {t('agentManager.sidebar.section.agentGroups')}
        </span>
        {isLoading && (
          <span className="typography-micro text-muted-foreground/50 ml-auto">
            {t('agentManager.sidebar.state.loading')}
          </span>
        )}
      </div>

      {/* Group List */}
      <ScrollableOverlay
        outerClassName="flex-1 min-h-0"
        className="space-y-0.5 px-2.5 pb-2"
      >
        {visibleGroups.map((group) => (
          <AgentGroupItem
            key={group.name}
            group={group}
            isSelected={selectedGroupName === group.name}
            isBusy={busyGroups.has(group.name)}
            onSelect={() => onGroupSelect?.(group.name)}
          />
        ))}

        {!showAll && remainingCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-1 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left typography-micro text-muted-foreground/70 hover:text-foreground hover:underline"
          >
            {t('agentManager.sidebar.actions.more', { count: remainingCount })}
          </button>
        )}

        {showAll && filteredGroups.length > MAX_VISIBLE && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="mt-1 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left typography-micro text-muted-foreground/70 hover:text-foreground hover:underline"
          >
            {t('agentManager.sidebar.actions.showLess')}
          </button>
        )}

        {!isLoading && filteredGroups.length === 0 && (
          <div className="py-4 text-center">
            <p className="typography-meta text-muted-foreground">
              {searchQuery.trim() ? t('agentManager.sidebar.state.noGroupsFound') : t('agentManager.sidebar.state.noGroupsYet')}
            </p>
            {!searchQuery.trim() && (
              <p className="typography-micro text-muted-foreground/60 mt-1">
                {t('agentManager.sidebar.state.createToGetStarted')}
              </p>
            )}
          </div>
        )}
      </ScrollableOverlay>
    </div>
  );
};
