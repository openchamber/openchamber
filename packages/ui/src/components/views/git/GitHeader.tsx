import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { BranchSelector } from './BranchSelector';
import { WorktreeBranchDisplay } from './WorktreeBranchDisplay';
import { SyncActions } from './SyncActions';
import { NestedRepoPicker } from './NestedRepoPicker';
import type {
  GitStatus,
  GitIdentityProfile,
  GitRemote,
  GitRemoteComparison,
  GitHubPullRequest,
  GitHubChecksSummary,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { identityDisplayName } from '@/lib/source-control/identity';
import { cn } from '@/lib/utils';
import { describeIdentityApplicability, type IdentityApplicability } from '@/lib/source-control/applyIdentity';
import { useDeviceInfo } from '@/lib/device';

type SyncAction = 'fetch' | 'sync' | 'publish' | null;

interface GitHeaderProps {
  directory: string;
  status: GitStatus | null;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, { ahead?: number; behind?: number }> | undefined;
  syncAction: SyncAction;
  operationBlocked?: boolean;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onSync: (remote: GitRemote) => void;
  onPublish: () => void;
  onChooseSyncTargets: () => void;
  onRemoveRemote: (remote: GitRemote) => void;
  removingRemoteName: string | null;
  onCheckoutBranch: (branch: string) => void;
  onCreateBranch: (name: string) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  activeIdentityProfile: GitIdentityProfile | null;
  availableIdentities: GitIdentityProfile[];
  onSelectIdentity: (profile: GitIdentityProfile) => void;
  isApplyingIdentity: boolean;
  /** What the binding cannot currently do, shown beside the identity it belongs to. */
  identityAttention?: string | null;
  identityApplicability?: (identity: GitIdentityProfile) => IdentityApplicability;
  onConfigureRepository?: () => void;
  /** Called when the identity menu opens, so connected accounts can be re-read before choosing. */
  onIdentityMenuOpen?: () => void;
  isWorktreeMode: boolean;
  onOpenHistory?: () => void;
  onOpenGraph?: () => void;
  onOpenStashes?: () => void;
  onOpenUpdateBranch?: () => void;
  onOpenReintegrateCommits?: () => void;
  pullRequest?: GitHubPullRequest | null;
  prChecks?: GitHubChecksSummary | null;
  onOpenPullRequest?: () => void;
  // Nested repository picker: shown when the Git tab operates on a repository
  // nested inside a non-repository root. Options are absolute repository
  // paths; `repositoryRoot` is the root those paths are relative to.
  repositoryOptions?: string[];
  selectedRepository?: string | null;
  onSelectRepository?: (repository: string) => void;
  repositoryRoot?: string;
}

const IDENTITY_ICON_MAP: Record<string, IconName> = {
  branch: 'git-branch',
  briefcase: 'briefcase',
  house: 'home',
  graduation: 'graduation-cap',
  code: 'code',
  heart: 'heart',
  user: 'user-3',
  fingerprint: 'fingerprint',
  // Identities made from a connected account carry the provider's mark.
  github: 'github',
  gitlab: 'gitlab-fill',
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
  /**
   * Whether the repository's binding is doing what its identity says. Shown on
   * the button because the identity is the only thing naming it now: an
   * account that was revoked or a configuration changed underneath has to be
   * visible somewhere, and here it sits beside what it is about.
   */
  attention?: string | null;
  /** Opens what an identity does not carry: auxiliary grants, agent Git, reset. */
  onConfigure?: () => void;
  /**
   * Whether each identity can serve this repository's remote. One that cannot
   * — an account on another instance, a transport that cannot reach the
   * address — stays listed with the reason, so the person sees why it is not
   * offered rather than wondering where it went.
   */
  applicability?: (identity: GitIdentityProfile) => IdentityApplicability;
  /** Lets a form give the trigger a field's width and border; the panel keeps its ghost button. */
  triggerClassName?: string;
  menuAlign?: 'start' | 'end';
  /** Called when the menu opens, so connected accounts can be re-read before choosing. */
  onOpen?: () => void;
}

export const IdentityDropdown: React.FC<IdentityDropdownProps> = ({
  activeProfile,
  identities,
  onSelect,
  isApplying,
  iconOnly = false,
  attention = null,
  onConfigure,
  applicability,
  triggerClassName,
  menuAlign = 'end',
  onOpen,
}) => {
  const { t } = useI18n();
  const isDisabled = isApplying || identities.length === 0;

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) onOpen?.(); }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-8 min-w-0 max-w-[15rem] justify-start gap-1.5 px-2 py-1 typography-ui-label', triggerClassName)}
              style={{ color: getIdentityColor(activeProfile?.color) }}
              disabled={isDisabled}
              aria-label={t('gitView.header.identityTooltip')}
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
                  {activeProfile ? identityDisplayName(activeProfile, t) : t('gitView.header.noIdentity')}
                </span>
              )}
              {attention ? (
                <Icon name="close-circle" className="size-3.5 shrink-0 text-[var(--status-error)]" />
              ) : null}
              <Icon name="arrow-down-s" className="size-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{attention ?? t('gitView.header.identityTooltip')}</TooltipContent>
      </Tooltip>
      {/* The list grows with the person's identities, and a trigger low on a
          form leaves little room beneath it, so the menu scrolls inside
          whatever height it is given rather than running past its own edge. */}
      <DropdownMenuContent align={menuAlign} className="w-64 overflow-y-auto">
        {identities.length === 0 ? (
          <div className="px-2 py-1.5">
            <p className="typography-meta text-muted-foreground">
              {t('gitView.header.noProfiles')}
            </p>
          </div>
        ) : (
          identities.map((profile) => {
            const isSelected = activeProfile?.id === profile.id;
            const fit = applicability?.(profile) ?? { applicable: true as const };
            return (
              <DropdownMenuItem key={profile.id} disabled={!fit.applicable} onSelect={() => onSelect(profile)}>
                <span className="flex items-center gap-2">
                  <IdentityIcon
                    icon={profile.icon}
                    colorToken={profile.color}
                    className="size-4"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="typography-ui-label text-foreground">
                      {identityDisplayName(profile, t)}
                    </span>
                    <span className="typography-meta text-muted-foreground">
                      {!fit.applicable ? describeIdentityApplicability(fit, t)
                        : profile.userEmail || t('gitView.identity.systemNoAuthor')}
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
        {onConfigure ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onConfigure}>
              <Icon name="settings-3" className="size-4" />
              {t('gitView.context.configure')}
            </DropdownMenuItem>
          </>
        ) : null}
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
  directory,
  status,
  localBranches,
  remoteBranches,
  branchInfo,
  syncAction,
  operationBlocked = false,
  remotes,
  onFetch,
  onSync,
  onPublish,
  onChooseSyncTargets,
  onRemoveRemote,
  removingRemoteName,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  activeIdentityProfile,
  availableIdentities,
  onSelectIdentity,
  isApplyingIdentity,
  identityAttention = null,
  identityApplicability: identityApplicabilityOf,
  onConfigureRepository,
  onIdentityMenuOpen,
  isWorktreeMode,
  onOpenHistory,
  onOpenGraph,
  onOpenStashes,
  onOpenUpdateBranch,
  onOpenReintegrateCommits,
  pullRequest,
  prChecks,
  onOpenPullRequest,
  repositoryOptions,
  selectedRepository,
  onSelectRepository,
  repositoryRoot,
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  if (!status) {
    return null;
  }

  const repositoryOptionsForPicker = (repositoryOptions ?? []).filter(Boolean);

  const managementButtons = (
    <div className="flex items-center gap-1 shrink-0">
      {onOpenHistory || onOpenGraph || onOpenStashes || onOpenUpdateBranch ? (
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
                  <Icon name="more-fill" className="size-4" />
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
                <Icon name="git-branch" className="size-4" />
                {t('gitView.graph.title')}
              </DropdownMenuItem>
            ) : null}
            {onOpenStashes ? (
              <DropdownMenuItem onSelect={onOpenStashes}>
                <Icon name="archive-stack" className="size-4" />
                {t('gitView.stashes.title')}
              </DropdownMenuItem>
            ) : null}
            {onOpenUpdateBranch ? (
              <DropdownMenuItem onSelect={onOpenUpdateBranch}>
                <Icon name="git-merge" className="size-4" />
                {t('gitView.header.updateBranch')}
              </DropdownMenuItem>
            ) : null}
            {onOpenReintegrateCommits ? (
              <DropdownMenuItem onSelect={onOpenReintegrateCommits}>
                <Icon name="split-cells-horizontal" className="size-4" />
                {t('gitView.integrate.title')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );

  const prChecksColor = prChecks
    ? prChecks.state === 'success'
      ? 'var(--status-success)'
      : prChecks.state === 'failure'
        ? 'var(--status-error)'
        : 'var(--status-warning)'
    : null;

  const prVisualState = pullRequest
    ? pullRequest.state === 'merged'
      ? 'merged'
      : pullRequest.state === 'closed'
        ? 'closed'
        : pullRequest.draft
          ? 'draft'
          : prChecks?.state === 'failure'
            || pullRequest.mergeable === false
            || pullRequest.mergeableState === 'blocked'
            || pullRequest.mergeableState === 'dirty'
            ? 'blocked'
            : 'open'
    : null;

  const prChip = pullRequest && onOpenPullRequest ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenPullRequest}
          className="h-8 gap-1.5 px-2 typography-micro"
        >
          <Icon
            name="git-pull-request"
            className="size-3.5"
            style={{ color: `var(--pr-${prVisualState})` }}
          />
          <span className="tabular-nums text-foreground/80">{t('gitView.pr.numberLabel', { number: pullRequest.number })}</span>
          {prChecksColor ? (
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: prChecksColor }}
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{t('gitView.header.openPullRequest')}</TooltipContent>
    </Tooltip>
  ) : null;

  const syncButtons = (
    <SyncActions
      syncAction={syncAction}
      remotes={remotes}
      onFetch={onFetch}
      onSync={onSync}
      onPublish={onPublish}
      onChooseSyncTargets={onChooseSyncTargets}
      currentBranch={status.current}
      hasTracking={Boolean(status.tracking)}
      onRemoveRemote={onRemoveRemote}
      removingRemoteName={removingRemoteName}
      disabled={!status || operationBlocked}
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

  // The identity names the whole configuration a repository acts as, so the
  // button says which one rather than only marking that there is one.
  const identityControl = (
    <IdentityDropdown
      activeProfile={activeIdentityProfile}
      identities={availableIdentities}
      onSelect={onSelectIdentity}
      isApplying={isApplyingIdentity}
      attention={identityAttention}
      onConfigure={onConfigureRepository}
      onOpen={onIdentityMenuOpen}
      applicability={identityApplicabilityOf}
    />
  );

  return (
    <header className="@container/git-header px-3 py-2 bg-transparent">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {isWorktreeMode && !isMobile ? (
            <WorktreeBranchDisplay
              currentBranch={status.current}
              onRename={onRenameBranch}
            />
          ) : (
            <BranchSelector
              directory={directory}
              currentBranch={status.current}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              branchInfo={branchInfo}
              currentBranchAhead={status.ahead}
              onCheckout={onCheckoutBranch}
              onCreate={onCreateBranch}
              switchBlockedNotice={(status.files?.length ?? 0) > 0 ? t('gitView.branch.switchBlockedNotice') : null}
            />
          )}
          {repositoryOptionsForPicker.length > 0 && onSelectRepository ? (
            <NestedRepoPicker
              repositories={repositoryOptionsForPicker}
              selectedRepository={selectedRepository ?? null}
              onSelectRepository={onSelectRepository}
              repositoryRoot={repositoryRoot}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {identityControl}
        </div>
      </div>

      <div className="mt-3 flex h-8 min-w-0 items-center gap-2">
        {prChip ? <div className="shrink-0">{prChip}</div> : null}
        <div className="min-w-0 flex-1" />
        {upstreamStatusPill ? (
          <div className="min-w-0 shrink">{upstreamStatusPill}</div>
        ) : null}
        {managementButtons}
        <div className="shrink-0">{syncButtons}</div>
      </div>
    </header>
  );
};
