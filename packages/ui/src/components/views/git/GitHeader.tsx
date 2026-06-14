import React from 'react';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { BranchSelector } from './BranchSelector';
import { WorktreeBranchDisplay } from './WorktreeBranchDisplay';
import { SyncActions } from './SyncActions';
import type {
  GitStatus,
  GitIdentityProfile,
  GitRemote,
  GitRemoteComparison,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

interface GitHeaderProps {
  status: GitStatus | null;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, { ahead?: number; behind?: number }> | undefined;
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onSync: (remote: GitRemote) => void;
  onRemoveRemote: (remote: GitRemote) => void;
  removingRemoteName: string | null;
  onCheckoutBranch: (branch: string) => void;
  onCreateBranch: (name: string, remote?: GitRemote) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  onDeleteBranch?: (branch: string) => Promise<void>;
  activeIdentityProfile: GitIdentityProfile | null;
  availableIdentities: GitIdentityProfile[];
  onSelectIdentity: (profile: GitIdentityProfile) => void;
  isApplyingIdentity: boolean;
  isWorktreeMode: boolean;
  onOpenHistory?: () => void;
  onOpenGraph?: () => void;
  onOpenStashes?: () => void;
  actionTabItems?: SortableTabsStripItem[];
  activeActionTab?: string;
  onSelectActionTab?: (tabID: string) => void;
}

const IDENTITY_ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
  user: 'user-3',
};

const IDENTITY_COLOR_MAP: Record<string, string> = {
  keyword: 'var(--syntax-keyword)',
  error: 'var(--status-error)',
  string: 'var(--syntax-string)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  success: 'var(--status-success)',
  info: 'var(--status-info)',
  warning: 'var(--status-warning)',
};

function getIdentityColor(token?: string | null) {
  if (!token) {
    return 'var(--primary)';
  }
  return IDENTITY_COLOR_MAP[token] || 'var(--primary)';
}

interface IdentityIconProps {
  icon?: string | null;
  className?: string;
  colorToken?: string | null;
}

const IdentityIcon: React.FC<IdentityIconProps> = ({ icon, className, colorToken }) => {
  const iconName = IDENTITY_ICON_MAP[icon ?? 'branch'] ?? 'user-3';
  return (
    <Icon
      name={iconName}
      className={className}
      style={{ color: getIdentityColor(colorToken) }}
    />
  );
};

interface IdentityDropdownProps {
  activeProfile: GitIdentityProfile | null;
  identities: GitIdentityProfile[];
  onSelect: (profile: GitIdentityProfile) => void;
  isApplying: boolean;
  iconOnly?: boolean;
}

export const IdentityDropdown: React.FC<IdentityDropdownProps> = ({
  activeProfile,
  identities,
  onSelect,
  isApplying,
  iconOnly = false,
}) => {
  const { t } = useI18n();
  const isDisabled = isApplying || identities.length === 0;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-[15rem] justify-start gap-1.5 px-2 py-1 typography-ui-label"
              style={{ color: getIdentityColor(activeProfile?.color) }}
              disabled={isDisabled}
            >
              {isApplying ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <IdentityIcon
                  icon={activeProfile?.icon}
                  colorToken={activeProfile?.color}
                  className="size-4"
                />
              )}
              {!iconOnly && (
                <span className="git-identity-label min-w-0 flex-1 truncate text-left">
                  {activeProfile?.name || t('gitView.header.noIdentity')}
                </span>
              )}
              <Icon name="arrow-down-s" className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{t('gitView.header.identityTooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        {identities.length === 0 ? (
          <div className="px-2 py-1.5">
            <p className="typography-meta text-muted-foreground">
              {t('gitView.header.noProfiles')}
            </p>
          </div>
        ) : (
          identities.map((profile) => {
            const isSelected = activeProfile?.id === profile.id;
            return (
              <DropdownMenuItem key={profile.id} onSelect={() => onSelect(profile)}>
                <span className="flex items-center gap-2">
                  <IdentityIcon
                    icon={profile.icon}
                    colorToken={profile.color}
                    className="size-4"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {profile.name}
                    </span>
                    <span className="typography-meta text-muted-foreground">
                      {profile.userEmail}
                    </span>
                  </span>
                  {isSelected ? (
                    <Icon name="check" className="ml-auto size-4 text-foreground" />
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

interface UpstreamStatusPillProps {
  comparison: GitRemoteComparison;
  trackingBranch: string | null;
  tooltipDelayMs?: number;
}

const UpstreamStatusPill: React.FC<UpstreamStatusPillProps> = ({
  comparison,
  trackingBranch,
  tooltipDelayMs = 1000,
}) => {
  const { t } = useI18n();
  const target = `${comparison.remote}/${comparison.branch}`;
  const isSynced = comparison.ahead === 0 && comparison.behind === 0;
  const tooltipText = trackingBranch
    ? t('gitView.header.upstreamTooltipTracking', { target, tracking: trackingBranch })
    : t('gitView.header.upstreamTooltip', { target });

  return (
    <Tooltip delayDuration={tooltipDelayMs}>
      <TooltipTrigger asChild>
        <div className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 typography-micro text-muted-foreground">
          <Icon name="git-branch" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate text-foreground/80">{target}</span>
          {isSynced ? (
            <span className="tabular-nums text-muted-foreground">{t('gitView.header.upstreamSynced')}</span>
          ) : (
            <span className="inline-flex items-center gap-1 tabular-nums">
              {comparison.ahead > 0 ? (
                <span className="text-[var(--status-info)]">↑{comparison.ahead}</span>
              ) : null}
              {comparison.behind > 0 ? (
                <span className="text-[var(--status-warning)]">↓{comparison.behind}</span>
              ) : null}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{tooltipText}</TooltipContent>
    </Tooltip>
  );
};

export const GitHeader: React.FC<GitHeaderProps> = ({
  status,
  localBranches,
  remoteBranches,
  branchInfo,
  syncAction,
  remotes,
  onFetch,
  onSync,
  onRemoveRemote,
  removingRemoteName,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  onDeleteBranch,
  activeIdentityProfile,
  availableIdentities,
  onSelectIdentity,
  isApplyingIdentity,
  isWorktreeMode,
  onOpenHistory,
  onOpenGraph,
  onOpenStashes,
  actionTabItems,
  activeActionTab,
  onSelectActionTab,
}) => {
  const { t } = useI18n();
  if (!status) {
    return null;
  }

  const managementButtons = (
    <div className="flex items-center gap-1 shrink-0">
      {onOpenHistory || onOpenGraph || onOpenStashes ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 px-0"
                  aria-label={t('gitView.header.repositoryViews')}
                >
                  <Icon name="git-repository" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent sideOffset={8}>{t('gitView.header.repositoryViews')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {onOpenHistory ? (
              <DropdownMenuItem onSelect={onOpenHistory}>
                <Icon name="history" className="size-4" />
                {t('gitView.history.title')}
              </DropdownMenuItem>
            ) : null}
            {onOpenGraph ? (
              <DropdownMenuItem onSelect={onOpenGraph}>
                <Icon name="git-merge" className="size-4" />
                {t('gitView.graph.title')}
              </DropdownMenuItem>
            ) : null}
            {onOpenStashes ? (
              <DropdownMenuItem onSelect={onOpenStashes}>
                <Icon name="archive-stack" className="size-4" />
                {t('gitView.stashes.title')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );

  const syncButtons = (
    <SyncActions
      syncAction={syncAction}
      remotes={remotes}
      onFetch={onFetch}
      onSync={onSync}
      onRemoveRemote={onRemoveRemote}
      removingRemoteName={removingRemoteName}
      disabled={!status}
      iconOnly={true}

      aheadCount={status.ahead}
      behindCount={status.behind}
      trackingRemoteName={status.tracking?.split('/')[0]}
      hasUncommittedChanges={(status.files?.length ?? 0) > 0}
    />
  );

  const upstreamStatusPill = status.upstreamComparison ? (
    <UpstreamStatusPill
      comparison={status.upstreamComparison}
      trackingBranch={status.tracking}
      tooltipDelayMs={1000}
    />
  ) : null;

  const identityControl = (
    <IdentityDropdown
      activeProfile={activeIdentityProfile}
      identities={availableIdentities}
      onSelect={onSelectIdentity}
      isApplying={isApplyingIdentity}
      iconOnly={true}
    />
  );

  return (
    <header className="@container/git-header px-3 py-2 bg-transparent">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          {isWorktreeMode ? (
            <WorktreeBranchDisplay
              currentBranch={status.current}
              onRename={onRenameBranch}
            />
          ) : (
            <BranchSelector
              currentBranch={status.current}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              branchInfo={branchInfo}
              onCheckout={onCheckoutBranch}
              onCreate={onCreateBranch}
              onRename={onRenameBranch}
              onDelete={onDeleteBranch}
              remotes={remotes}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {managementButtons}
          {identityControl}
        </div>
      </div>

      {actionTabItems && activeActionTab && onSelectActionTab ? (
        <div className="mt-3 flex h-8 min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <SortableTabsStrip
              items={actionTabItems}
              activeId={activeActionTab}
              onSelect={onSelectActionTab}
              layoutMode="fit"
              variant="active-pill"
              iconOnlyActiveTab={true}
              activePillButtonClassName="h-7"
              className="h-full"
            />
          </div>
          {upstreamStatusPill ? (
            <div className="min-w-0 shrink">{upstreamStatusPill}</div>
          ) : null}
          <div className="shrink-0">{syncButtons}</div>
        </div>
      ) : null}
    </header>
  );
};
