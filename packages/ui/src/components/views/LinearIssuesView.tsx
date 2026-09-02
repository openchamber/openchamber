import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useUIStore, LINEAR_ISSUE_LIST_ALL_TEAMS } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { openExternalUrl } from '@/lib/url';
import { startLinearIssueSession } from '@/lib/linearStartSession';
import type {
  LinearIssue,
  LinearIssueLabel,
  LinearIssueListPriority,
  LinearIssueListStatus,
  LinearIssueSummary,
  LinearTeamMapping,
  LinearWorkflowState,
} from '@/lib/api/types';

const LINEAR_MARKDOWN_CLASS = '[&_img]:max-w-full [&_img]:h-auto';
const FILTER_TRIGGER_CLASS = 'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 typography-ui-label font-semibold text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const FILTER_COMPACT_TRIGGER_CLASS = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
// The Linear rail is 380–600px. Below this, four or five flex pickers squeeze
// labels to an ellipsis. Status keeps its label (the filter people use most);
// search and the other filters drop to icons that already identify them.
// Walkthrough uses the same icon-only idea at 680px for a wider header.
const FILTER_COMPACT_WIDTH = 520;

const workspaceLabel = (workspace: { name: string | null; urlKey: string | null; id: string }) => (
  workspace.name?.trim() || workspace.urlKey?.trim() || workspace.id
);

const LINEAR_PRIORITY_KEYS = {
  0: 'contextPanel.linear.priority.none',
  1: 'contextPanel.linear.priority.urgent',
  2: 'contextPanel.linear.priority.high',
  3: 'contextPanel.linear.priority.medium',
  4: 'contextPanel.linear.priority.low',
} as const;

const LINEAR_WORKFLOW_TYPE_RANK = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
} as const;

const linearWorkflowTypeRank = (type: string | null): number => {
  if (
    type === 'triage'
    || type === 'backlog'
    || type === 'unstarted'
    || type === 'started'
    || type === 'completed'
    || type === 'canceled'
  ) {
    return LINEAR_WORKFLOW_TYPE_RANK[type];
  }
  return 99;
};

const compareLinearWorkflowStates = (left: LinearWorkflowState, right: LinearWorkflowState): number => {
  const typeDelta = linearWorkflowTypeRank(left.type) - linearWorkflowTypeRank(right.type);
  if (typeDelta !== 0) return typeDelta;
  if (left.position !== right.position) return left.position - right.position;
  return left.name.localeCompare(right.name);
};

const linearPriorityMessageKey = (priority: number | null | undefined) => {
  if (priority !== 0 && priority !== 1 && priority !== 2 && priority !== 3 && priority !== 4) {
    return null;
  }
  return LINEAR_PRIORITY_KEYS[priority];
};

const STATUS_FILTER_ITEMS = [
  { value: 'all', labelKey: 'contextPanel.linear.filter.status.all' },
  { value: 'backlog', labelKey: 'contextPanel.linear.filter.status.backlog' },
  { value: 'todo', labelKey: 'contextPanel.linear.filter.status.todo' },
  { value: 'started', labelKey: 'contextPanel.linear.filter.status.started' },
  { value: 'inReview', labelKey: 'contextPanel.linear.filter.status.inReview' },
  { value: 'completed', labelKey: 'contextPanel.linear.filter.status.completed' },
  { value: 'canceled', labelKey: 'contextPanel.linear.filter.status.canceled' },
  { value: 'duplicate', labelKey: 'contextPanel.linear.filter.status.duplicate' },
] as const;

const isLinearIssueListStatus = (value: string): value is LinearIssueListStatus => (
  STATUS_FILTER_ITEMS.some((item) => item.value === value)
);

const PRIORITY_FILTER_ITEMS = [
  { value: 'all', labelKey: 'contextPanel.linear.filter.priority.all' },
  { value: 'urgent', labelKey: 'contextPanel.linear.priority.urgent' },
  { value: 'high', labelKey: 'contextPanel.linear.priority.high' },
  { value: 'medium', labelKey: 'contextPanel.linear.priority.medium' },
  { value: 'low', labelKey: 'contextPanel.linear.priority.low' },
  { value: 'none', labelKey: 'contextPanel.linear.priority.none' },
] as const;

const isLinearIssueListPriority = (value: string): value is LinearIssueListPriority => (
  PRIORITY_FILTER_ITEMS.some((item) => item.value === value)
);

const labelChipStyle = (color: string | null): React.CSSProperties | undefined => {
  if (!color) {
    return { backgroundColor: 'color-mix(in srgb, var(--surface-mutedForeground) 12%, transparent)' };
  }
  return {
    color,
    backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
  };
};

const LinearIssueLabelChips: React.FC<{ labels: LinearIssueLabel[] }> = ({ labels }) => {
  if (labels.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.map((label) => (
        <span
          key={label.id}
          className="inline-flex h-5 max-w-[8rem] items-center truncate rounded-md px-1.5 typography-meta text-muted-foreground"
          style={labelChipStyle(label.color)}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
};

const LinearFilterMenu: React.FC<{
  icon: IconName;
  label: string;
  ariaLabel: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  disabled?: boolean;
  compact?: boolean;
  active?: boolean;
  onValueChange: (value: string) => void;
}> = ({ icon, label, ariaLabel, value, items, disabled, compact, active, onValueChange }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={active === true}
          className={compact ? FILTER_COMPACT_TRIGGER_CLASS : FILTER_TRIGGER_CLASS}
          aria-label={ariaLabel}
          title={compact ? label : undefined}
        >
          <Icon name={icon} className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
          {!compact ? (
            <>
              <span className="min-w-0 truncate">{label}</span>
              <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-60" />
            </>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            onValueChange(next);
            setOpen(false);
          }}
        >
          {items.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const parseLinearIssueQuery = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/linear\.app\/(?:[^/]+\/)?issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
};

const toIssueSummary = (issue: LinearIssue): LinearIssueSummary => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  state: issue.state,
  assignee: issue.assignee,
  team: issue.team,
  priority: issue.priority,
  labels: issue.labels,
});

const patchIssueInList = (issues: LinearIssueSummary[], next: LinearIssue): LinearIssueSummary[] => {
  const summary = toIssueSummary(next);
  return issues.map((issue) => (issue.id === next.id ? summary : issue));
};

export const LinearIssuesView: React.FC = () => {
  const { t } = useI18n();
  const { linear } = useRuntimeAPIs();
  const linearAuthStatus = useLinearAuthStore((state) => state.status);
  const linearAuthChecked = useLinearAuthStore((state) => state.hasChecked);
  const refreshStatus = useLinearAuthStore((state) => state.refreshStatus);
  const setLinearAuthStatus = useLinearAuthStore((state) => state.setStatus);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const listStatus = useUIStore((state) => state.linearIssueListStatus);
  const listAssignee = useUIStore((state) => state.linearIssueListAssignee);
  const listTeamId = useUIStore((state) => state.linearIssueListTeamId);
  const listPriority = useUIStore((state) => state.linearIssueListPriority);
  const linearIssueFocus = useUIStore((state) => state.linearIssueFocus);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const setListStatus = useUIStore((state) => state.setLinearIssueListStatus);
  const setListAssignee = useUIStore((state) => state.setLinearIssueListAssignee);
  const setListTeamId = useUIStore((state) => state.setLinearIssueListTeamId);
  const setListPriority = useUIStore((state) => state.setLinearIssueListPriority);
  const resetListFilters = useUIStore((state) => state.resetLinearIssueListFilters);
  const setLinearIssueFocus = useUIStore((state) => state.setLinearIssueFocus);

  const [query, setQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [issues, setIssues] = React.useState<LinearIssueSummary[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [connected, setConnected] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = React.useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = React.useState<LinearIssue | null>(null);
  const [workflowStates, setWorkflowStates] = React.useState<LinearWorkflowState[]>([]);
  const [isLoadingIssue, setIsLoadingIssue] = React.useState(false);
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [isStarting, setIsStarting] = React.useState(false);
  const [createInWorktree, setCreateInWorktree] = React.useState(false);
  const [teams, setTeams] = React.useState<LinearTeamMapping[]>([]);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = React.useState(false);
  const listRequestId = React.useRef(0);
  const listRootRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [panelWidth, setPanelWidth] = React.useState(0);

  const directIdentifier = React.useMemo(() => parseLinearIssueQuery(query), [query]);
  const debouncedQuery = useDebouncedValue(query, 350);

  // Same shape the pull request panel uses, so both context surfaces read alike.
  const formatCommentTimestamp = React.useCallback((value: string | null) => {
    if (!value) return '';
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '';
    return formatDateTimeForPreference(timestamp, timeFormatPreference, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, [timeFormatPreference]);

  const openLinearSettings = React.useCallback(() => {
    setSettingsPage('integrations');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);

  const listQuery = React.useMemo(() => ({
    query: debouncedQuery.trim() || undefined,
    status: listStatus,
    assignee: listAssignee,
    teamId: listTeamId === LINEAR_ISSUE_LIST_ALL_TEAMS ? undefined : listTeamId,
    priority: listPriority === 'all' ? undefined : listPriority,
  }), [debouncedQuery, listAssignee, listPriority, listStatus, listTeamId]);

  const workspaces = linearAuthStatus?.workspaces ?? [];
  const currentWorkspaceId = workspaces.find((workspace) => workspace.current)?.id
    || linearAuthStatus?.organization?.id
    || '';

  const refresh = React.useCallback(async () => {
    if (linearAuthChecked && linearAuthStatus?.connected === false) {
      setConnected(false);
      setIssues([]);
      setHasMore(false);
      setCursor(null);
      setError(null);
      return;
    }
    if (!linear?.issuesList) {
      setConnected(true);
      setError(t('session.linearIssuePicker.error.runtimeUnavailable'));
      return;
    }

    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    setIsLoading(true);
    setError(null);
    try {
      const next = await linear.issuesList(listQuery);
      if (requestId !== listRequestId.current) return;
      setConnected(next.connected !== false);
      if (next.connected === false) {
        setIssues([]);
        setHasMore(false);
        setCursor(null);
        return;
      }
      setIssues(next.issues ?? []);
      setCursor(next.cursor ?? null);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (requestId !== listRequestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === listRequestId.current) {
        setIsLoading(false);
      }
    }
  }, [linear, linearAuthChecked, linearAuthStatus, listQuery, t]);

  React.useEffect(() => {
    if (linear && !linearAuthChecked) {
      void refreshStatus(linear);
    }
  }, [linear, linearAuthChecked, refreshStatus]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!linear?.mappingGet || !connected) {
      setTeams([]);
      return;
    }
    let cancelled = false;
    void linear.mappingGet().then((mapping) => {
      if (cancelled) return;
      if (mapping.connected === false) {
        setTeams([]);
        return;
      }
      setTeams(mapping.teams ?? []);
    }).catch(() => {
      if (!cancelled) {
        setTeams([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connected, currentWorkspaceId, linear]);

  React.useEffect(() => {
    if (listTeamId === LINEAR_ISSUE_LIST_ALL_TEAMS || teams.length === 0) {
      return;
    }
    if (!teams.some((team) => team.id === listTeamId)) {
      setListTeamId(LINEAR_ISSUE_LIST_ALL_TEAMS);
    }
  }, [listTeamId, setListTeamId, teams]);

  const loadMore = React.useCallback(async () => {
    if (!linear?.issuesList) return;
    if (isLoadingMore || isLoading) return;
    if (!hasMore || !cursor) return;

    const requestId = listRequestId.current + 1;
    listRequestId.current = requestId;
    setIsLoadingMore(true);
    try {
      const next = await linear.issuesList({
        ...listQuery,
        cursor,
      });
      if (requestId !== listRequestId.current) return;
      setConnected(next.connected !== false);
      if (next.connected === false) {
        return;
      }
      setIssues((prev) => [...prev, ...(next.issues ?? [])]);
      setCursor(next.cursor ?? null);
      setHasMore(Boolean(next.hasMore));
    } catch (e) {
      if (requestId !== listRequestId.current) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.linearIssuePicker.toast.loadMoreFailed'), { description: message });
    } finally {
      if (requestId === listRequestId.current) {
        setIsLoadingMore(false);
      }
    }
  }, [cursor, hasMore, isLoading, isLoadingMore, linear, listQuery, t]);

  React.useEffect(() => {
    if (!selectedIssueId || !linear?.issueGet) {
      return;
    }
    let cancelled = false;
    setIsLoadingIssue(true);
    setSelectedIssue(null);
    setWorkflowStates([]);
    void (async () => {
      try {
        const issueRes = await linear.issueGet(selectedIssueId);
        if (cancelled) return;
        if (issueRes.connected === false) {
          setConnected(false);
          setSelectedIssueId(null);
          return;
        }
        const issue = issueRes.issue;
        if (!issue) {
          toast.error(t('session.linearIssuePicker.error.issueNotFound'));
          setSelectedIssueId(null);
          return;
        }
        setSelectedIssue(issue);
        const teamId = issue.team?.id;
        if (!teamId || !linear.issueStates) {
          return;
        }
        try {
          const statesRes = await linear.issueStates(teamId);
          if (cancelled) return;
          if (statesRes.connected === false) {
            setConnected(false);
            return;
          }
          setWorkflowStates(statesRes.states ?? []);
        } catch (e) {
          if (cancelled) return;
          const message = e instanceof Error ? e.message : String(e);
          toast.error(t('session.linearIssuePicker.toast.loadIssueDetailsFailed'), { description: message });
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        toast.error(t('session.linearIssuePicker.toast.loadIssueDetailsFailed'), { description: message });
        setSelectedIssueId(null);
      } finally {
        if (!cancelled) {
          setIsLoadingIssue(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linear, selectedIssueId, t]);

  React.useEffect(() => {
    if (!linearIssueFocus) return;
    setSelectedIssueId(linearIssueFocus);
    setLinearIssueFocus(null);
  }, [linearIssueFocus, setLinearIssueFocus]);

  const applyUpdatedIssue = React.useCallback((issue: LinearIssue) => {
    setSelectedIssue(issue);
    setIssues((prev) => patchIssueInList(prev, issue));
  }, []);

  const updateIssueState = React.useCallback(async (stateId: string, failedKey: 'contextPanel.linear.toast.statusUpdateFailed' | 'contextPanel.linear.toast.closeFailed') => {
    if (!linear?.issueUpdate || !selectedIssue || isUpdating) {
      return;
    }
    if (selectedIssue.state?.id === stateId) {
      return;
    }
    setIsUpdating(true);
    try {
      const result = await linear.issueUpdate({ id: selectedIssue.id, stateId });
      if (result.connected === false) {
        setConnected(false);
        toast.error(t(failedKey));
        return;
      }
      if (!result.issue) {
        toast.error(t(failedKey));
        return;
      }
      applyUpdatedIssue(result.issue);
      toast.success(t('contextPanel.linear.toast.statusUpdated'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t(failedKey), { description: message });
    } finally {
      setIsUpdating(false);
    }
  }, [applyUpdatedIssue, isUpdating, linear, selectedIssue, t]);

  const closeIssue = React.useCallback(() => {
    const completed = workflowStates.find((state) => state.type === 'completed');
    if (!completed) {
      toast.error(t('contextPanel.linear.error.noCompletedState'));
      return;
    }
    void updateIssueState(completed.id, 'contextPanel.linear.toast.closeFailed');
  }, [t, updateIssueState, workflowStates]);

  const startSession = React.useCallback(async () => {
    if (!selectedIssue || isStarting) return;
    setIsStarting(true);
    try {
      await startLinearIssueSession({
        linear,
        issueKey: selectedIssue.id,
        createInWorktree,
        t,
      });
    } finally {
      setIsStarting(false);
    }
  }, [createInWorktree, isStarting, linear, selectedIssue, t]);

  const switchWorkspace = React.useCallback(async (organizationId: string) => {
    if (!linear?.authActivate || !organizationId || organizationId === currentWorkspaceId || isSwitchingWorkspace) {
      return;
    }
    setIsSwitchingWorkspace(true);
    try {
      const payload = await linear.authActivate(organizationId);
      setLinearAuthStatus(payload);
      setSelectedIssueId(null);
      setSelectedIssue(null);
      setWorkflowStates([]);
      setListTeamId(LINEAR_ISSUE_LIST_ALL_TEAMS);
      toast.success(t('contextPanel.linear.toast.workspaceSwitched'));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('contextPanel.linear.toast.workspaceSwitchFailed'), { description: message });
    } finally {
      setIsSwitchingWorkspace(false);
    }
  }, [currentWorkspaceId, isSwitchingWorkspace, linear, setLinearAuthStatus, setListTeamId, t]);

  const statusOptions = React.useMemo(() => {
    const byId = new Map(workflowStates.map((state) => [state.id, state]));
    const currentId = selectedIssue?.state?.id;
    const currentName = selectedIssue?.state?.name;
    const states = currentId && currentName && !byId.has(currentId)
      ? [
        {
          id: currentId,
          name: currentName,
          type: selectedIssue.state?.type ?? null,
          position: 0,
        },
        ...workflowStates,
      ]
      : workflowStates;
    return [...states].sort(compareLinearWorkflowStates);
  }, [selectedIssue, workflowStates]);

  const completedState = workflowStates.find((state) => state.type === 'completed');
  const alreadyCompleted = selectedIssue?.state?.type === 'completed';
  const showDisconnected = linearAuthChecked && connected === false;
  const runtimeMissing = !linear;
  const showingDetail = Boolean(selectedIssueId);
  const usingDefaultFilters = listStatus === 'all' && listAssignee === 'any' && listTeamId === LINEAR_ISSUE_LIST_ALL_TEAMS && listPriority === 'all';
  const canUseListControls = Boolean(linear) && connected && !showDisconnected;
  const filtersDisabled = !canUseListControls || isSwitchingWorkspace;
  // Zero means the observer has not reported yet; assume there is room rather
  // than rendering a compact filter row for one frame on every open.
  const compactFilters = panelWidth > 0 && panelWidth < FILTER_COMPACT_WIDTH;
  const searchActive = query.trim().length > 0;
  const hasActiveFilters = !usingDefaultFilters || searchActive;
  const showSearchField = !compactFilters || searchOpen || searchActive;

  const closeCompactSearch = React.useCallback(() => {
    setQuery('');
    setSearchOpen(false);
  }, []);

  React.useEffect(() => {
    const element = listRootRef.current;
    if (!element || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver((entries) => {
      setPanelWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingDetail]);

  React.useEffect(() => {
    if (compactFilters && searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [compactFilters, searchOpen]);

  const worktreeToggle = (
    <div
      className="flex items-center gap-2 cursor-pointer"
      role="button"
      tabIndex={0}
      aria-pressed={createInWorktree}
      onClick={() => setCreateInWorktree((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          setCreateInWorktree((value) => !value);
        }
      }}
    >
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setCreateInWorktree((value) => !value);
        }}
        aria-label={t('session.linearIssuePicker.actions.toggleWorktreeAria')}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {createInWorktree ? (
          <Icon name="checkbox" className="h-4 w-4 text-primary" />
        ) : (
          <Icon name="checkbox-blank" className="h-4 w-4" />
        )}
      </button>
      <span className="typography-meta text-muted-foreground">{t('session.linearIssuePicker.actions.createInWorktree')}</span>
    </div>
  );

  const renderIssueRow = (issue: LinearIssueSummary) => (
    <div
      key={issue.id}
      className={cn(
        'group flex items-center gap-2 py-1.5 px-1 rounded cursor-pointer hover:bg-interactive-hover/30 transition-colors',
        selectedIssueId === issue.id && 'bg-interactive-selection/30'
      )}
      onClick={() => setSelectedIssueId(issue.id)}
    >
      <span className="typography-meta text-muted-foreground w-16 text-right flex-shrink-0">
        {issue.identifier}
      </span>
      <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
        {issue.title}
      </p>
      <div className="flex-shrink-0 h-5 flex items-center mr-1">
        <button
          type="button"
          className="hidden group-hover:flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          onClick={(event) => {
            event.stopPropagation();
            void openExternalUrl(issue.url);
          }}
          aria-label={t('session.linearIssuePicker.actions.openInLinearAria')}
        >
          <Icon name="external-link" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  if (showingDetail) {
    const assigneeName = selectedIssue?.assignee?.displayName || selectedIssue?.assignee?.name;
    const comments = selectedIssue?.comments ?? [];
    const description = selectedIssue?.description?.trim() || '';
    const statusValue = selectedIssue?.state?.id || '';
    const priorityKey = linearPriorityMessageKey(selectedIssue?.priority);
    const labels = selectedIssue?.labels ?? [];

    return (
      <div ref={listRootRef} className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => {
              setSelectedIssueId(null);
              setSelectedIssue(null);
              setWorkflowStates([]);
            }}
            aria-label={t('contextPanel.linear.actions.backToList')}
          >
            <Icon name="arrow-left-s" className="h-4 w-4" />
            {t('contextPanel.linear.actions.backToList')}
          </Button>
          {selectedIssue ? (
            <button
              type="button"
              className="ml-auto flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => void openExternalUrl(selectedIssue.url)}
              aria-label={t('session.linearIssuePicker.actions.openInLinearAria')}
            >
              <Icon name="external-link" className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <ScrollableOverlay
          as={ScrollShadow}
          outerClassName="h-full min-h-0 flex-1"
          className="px-4 py-3"
          disableHorizontal
          preventOverscroll
        >
          {isLoadingIssue && !selectedIssue ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('contextPanel.linear.loading.issue')}
            </div>
          ) : null}

          {selectedIssue ? (
            <React.Suspense fallback={
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                {t('contextPanel.linear.loading.issue')}
              </div>
            }>
            <div className="space-y-4">
              <div>
                <div className="typography-meta text-muted-foreground">{selectedIssue.identifier}</div>
                <h2 className="typography-ui-header text-foreground mt-0.5">{selectedIssue.title}</h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {statusOptions.length > 0 && statusValue ? (
                  <Select
                    value={statusValue}
                    onValueChange={(value) => {
                      void updateIssueState(value, 'contextPanel.linear.toast.statusUpdateFailed');
                    }}
                    disabled={isUpdating}
                  >
                    <SelectTrigger size="sm" className="h-7 w-auto min-w-0" aria-label={t('contextPanel.linear.label.statusAria')}>
                      <SelectValue placeholder={t('contextPanel.linear.label.status')}>
                        {(value) => statusOptions.find((state) => state.id === value)?.name ?? value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((state) => (
                        <SelectItem key={state.id} value={state.id}>
                          {state.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : selectedIssue.state?.name ? (
                  <span className="typography-meta text-muted-foreground">{selectedIssue.state.name}</span>
                ) : null}

                {completedState && !alreadyCompleted ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={closeIssue}
                    disabled={isUpdating}
                  >
                    {isUpdating ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                    {t('contextPanel.linear.actions.closeIssue')}
                  </Button>
                ) : null}
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 typography-meta">
                {selectedIssue.team?.name ? (
                  <>
                    <dt className="text-muted-foreground">{t('contextPanel.linear.label.team')}</dt>
                    <dd className="text-foreground min-w-0 truncate">{selectedIssue.team.name}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t('contextPanel.linear.label.assignee')}</dt>
                <dd className="text-foreground min-w-0 truncate">
                  {assigneeName || t('contextPanel.linear.label.unassigned')}
                </dd>
                {priorityKey ? (
                  <>
                    <dt className="text-muted-foreground">{t('contextPanel.linear.label.priority')}</dt>
                    <dd className="text-foreground min-w-0 truncate">
                      {t(priorityKey)}
                    </dd>
                  </>
                ) : null}
                {labels.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">{t('contextPanel.linear.label.labels')}</dt>
                    <dd className="min-w-0">
                      <LinearIssueLabelChips labels={labels} />
                    </dd>
                  </>
                ) : null}
              </dl>

              <div>
                {description ? (
                  <SimpleMarkdownRenderer
                    content={description}
                    className={LINEAR_MARKDOWN_CLASS}
                    enableFileReferences={false}
                  />
                ) : (
                  <p className="typography-meta text-muted-foreground">{t('contextPanel.linear.empty.noDescription')}</p>
                )}
              </div>

              <div>
                <h3 className="typography-ui-label text-foreground mb-2">{t('contextPanel.linear.label.comments')}</h3>
                {comments.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{t('contextPanel.linear.empty.noComments')}</p>
                ) : (
                  <div className="relative pl-3">
                    {comments.map((comment, index) => {
                      const author = comment.user?.displayName
                        || comment.user?.name
                        || t('contextPanel.linear.label.unassigned');
                      const avatarUrl = comment.user?.avatarUrl || null;
                      const initial = author.charAt(0).toUpperCase();
                      const isLast = index === comments.length - 1;
                      const createdLabel = formatCommentTimestamp(comment.createdAt);
                      return (
                        <div key={comment.id} className="relative pl-10 pb-5 last:pb-0">
                          {!isLast ? (
                            <div className="absolute left-4 top-[2.375rem] bottom-[0.375rem] w-px bg-border/60" />
                          ) : null}
                          <div className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated text-xs text-muted-foreground">
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt={author}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span>{initial}</span>
                            )}
                          </div>
                          <div className="rounded-lg bg-surface-elevated px-3 pt-0 pb-3 space-y-2">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
                              <span className="text-foreground whitespace-nowrap">{author}</span>
                              {createdLabel ? <span className="whitespace-nowrap">{createdLabel}</span> : null}
                            </div>
                            {comment.body.trim() ? (
                              <SimpleMarkdownRenderer
                                content={comment.body}
                                className={cn('typography-markdown-body text-foreground break-words', LINEAR_MARKDOWN_CLASS)}
                                enableFileReferences={false}
                              />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            </React.Suspense>
          ) : null}
        </ScrollableOverlay>
        {selectedIssue ? (
          <div className="shrink-0 border-t border-border px-4 py-3 flex flex-col gap-3">
            {worktreeToggle}
            <Button
              type="button"
              onClick={() => void startSession()}
              disabled={isStarting || isUpdating}
              className="w-full"
            >
              {isStarting ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
              {t('contextPanel.linear.actions.startSession')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={listRootRef} className="flex h-full min-h-0 flex-col">
      <div className="px-3 pt-3 space-y-2">
        {showSearchField ? (
          <div className="relative">
            <Icon name="search" className={cn('absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4', searchActive ? 'text-primary' : 'text-muted-foreground')} />
            <Input
              ref={searchInputRef}
              placeholder={t('session.linearIssuePicker.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && compactFilters) {
                  event.preventDefault();
                  closeCompactSearch();
                }
              }}
              className={cn('pl-9 w-full', compactFilters && 'pr-9')}
            />
            {compactFilters ? (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('contextPanel.linear.actions.closeSearch')}
                title={t('contextPanel.linear.actions.closeSearch')}
                onClick={closeCompactSearch}
              >
                <Icon name="close" className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        {canUseListControls || (compactFilters && !showSearchField) ? (
          <div className={cn('flex min-w-0 items-center', compactFilters && 'gap-0.5')}>
            {canUseListControls ? (
              <>
            <LinearFilterMenu
              icon="task"
              label={t((STATUS_FILTER_ITEMS.find((item) => item.value === listStatus) ?? STATUS_FILTER_ITEMS[0]).labelKey)}
              ariaLabel={t('contextPanel.linear.filter.statusAria')}
              value={listStatus}
              active={listStatus !== 'all'}
              disabled={filtersDisabled}
              items={STATUS_FILTER_ITEMS.map((item) => ({
                value: item.value,
                label: t(item.labelKey),
              }))}
              onValueChange={(value) => {
                if (isLinearIssueListStatus(value)) {
                  setListStatus(value);
                }
              }}
            />

            <LinearFilterMenu
              icon="error-warning"
              compact={compactFilters}
              label={t((PRIORITY_FILTER_ITEMS.find((item) => item.value === listPriority) ?? PRIORITY_FILTER_ITEMS[0]).labelKey)}
              ariaLabel={t('contextPanel.linear.filter.priorityAria')}
              value={listPriority}
              active={listPriority !== 'all'}
              disabled={filtersDisabled}
              items={PRIORITY_FILTER_ITEMS.map((item) => ({
                value: item.value,
                label: t(item.labelKey),
              }))}
              onValueChange={(value) => {
                if (isLinearIssueListPriority(value)) {
                  setListPriority(value);
                }
              }}
            />

            <LinearFilterMenu
              icon="user-3"
              compact={compactFilters}
              label={
                listAssignee === 'me'
                  ? t('contextPanel.linear.filter.assignee.me')
                  : t('contextPanel.linear.filter.assignee.any')
              }
              ariaLabel={t('contextPanel.linear.filter.assigneeAria')}
              value={listAssignee}
              active={listAssignee !== 'any'}
              disabled={filtersDisabled}
              items={[
                { value: 'any', label: t('contextPanel.linear.filter.assignee.any') },
                { value: 'me', label: t('contextPanel.linear.filter.assignee.me') },
              ]}
              onValueChange={(value) => {
                if (value === 'any' || value === 'me') {
                  setListAssignee(value);
                }
              }}
            />

            {teams.length > 0 ? (
              <LinearFilterMenu
                icon="team"
                compact={compactFilters}
                label={
                  listTeamId === LINEAR_ISSUE_LIST_ALL_TEAMS
                    ? t('contextPanel.linear.filter.team.all')
                    : (teams.find((team) => team.id === listTeamId)?.name ?? listTeamId)
                }
                ariaLabel={t('contextPanel.linear.filter.teamAria')}
                value={listTeamId}
                active={listTeamId !== LINEAR_ISSUE_LIST_ALL_TEAMS}
                disabled={filtersDisabled}
                items={[
                  { value: LINEAR_ISSUE_LIST_ALL_TEAMS, label: t('contextPanel.linear.filter.team.all') },
                  ...teams.map((team) => ({ value: team.id, label: team.name })),
                ]}
                onValueChange={setListTeamId}
              />
            ) : null}

            {workspaces.length > 1 && currentWorkspaceId ? (
              <LinearFilterMenu
                icon="briefcase"
                compact={compactFilters}
                label={workspaceLabel(workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? { id: currentWorkspaceId, name: null, urlKey: null })}
                ariaLabel={t('contextPanel.linear.label.workspaceAria')}
                value={currentWorkspaceId}
                disabled={isSwitchingWorkspace}
                items={workspaces.map((workspace) => ({
                  value: workspace.id,
                  label: workspaceLabel(workspace),
                }))}
                onValueChange={(value) => {
                  void switchWorkspace(value);
                }}
              />
            ) : null}

            {hasActiveFilters ? (
              <button
                type="button"
                className={cn(
                  compactFilters ? FILTER_COMPACT_TRIGGER_CLASS : FILTER_TRIGGER_CLASS,
                  !compactFilters && 'flex-none',
                )}
                aria-label={t('contextPanel.linear.filter.clearAria')}
                title={t('contextPanel.linear.filter.clearAria')}
                disabled={filtersDisabled}
                onClick={() => {
                  resetListFilters();
                  closeCompactSearch();
                }}
              >
                <Icon name="close" className="size-3.5 shrink-0 text-muted-foreground" />
                {!compactFilters ? (
                  <span className="min-w-0 truncate">{t('contextPanel.linear.filter.clear')}</span>
                ) : null}
              </button>
            ) : null}
              </>
            ) : null}

            {compactFilters && !showSearchField ? (
              <button
                type="button"
                className={FILTER_COMPACT_TRIGGER_CLASS}
                aria-label={t('contextPanel.linear.filter.searchAria')}
                title={t('contextPanel.linear.filter.searchAria')}
                onClick={() => setSearchOpen(true)}
              >
                <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ScrollableOverlay
        as={ScrollShadow}
        outerClassName="h-full min-h-0 flex-1"
        className="px-3 py-2"
        disableHorizontal
        preventOverscroll
      >
        {runtimeMissing ? (
          <div className="text-center text-muted-foreground py-8">{t('session.linearIssuePicker.empty.runtimeUnavailable')}</div>
        ) : null}

        {isLoading && issues.length === 0 ? (
          <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
            {t('session.linearIssuePicker.loading.issues')}
          </div>
        ) : null}

        {showDisconnected ? (
          <div className="text-center text-muted-foreground py-8 space-y-3">
            <div>{t('session.linearIssuePicker.empty.notConnected')}</div>
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={openLinearSettings}>
                {t('session.linearIssuePicker.actions.openSettings')}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
        ) : null}

        {directIdentifier && linear && connected ? (
          <div
            className="group flex items-center gap-2 py-1.5 px-1 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer"
            onClick={() => setSelectedIssueId(directIdentifier)}
          >
            <span className="typography-meta text-muted-foreground w-16 text-right flex-shrink-0">
              {directIdentifier}
            </span>
            <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
              {t('session.linearIssuePicker.actions.useIssue', { identifier: directIdentifier })}
            </p>
          </div>
        ) : null}

        {issues.length === 0 && !isLoading && connected && linear ? (
          <div className="text-center text-muted-foreground py-8">
            {debouncedQuery.trim()
              ? t('session.linearIssuePicker.empty.noIssuesFound')
              : usingDefaultFilters
                ? t('session.linearIssuePicker.empty.noOpenIssuesFound')
                : t('contextPanel.linear.empty.noMatchingIssues')}
          </div>
        ) : null}

        {issues.map(renderIssueRow)}

        {hasMore && connected && linear ? (
          <div className="py-2 flex justify-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={isLoadingMore}
              className={cn(
                'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                isLoadingMore && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
              )}
            >
              {isLoadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  {t('session.linearIssuePicker.loading.more')}
                </span>
              ) : (
                t('session.linearIssuePicker.actions.loadMore')
              )}
            </button>
          </div>
        ) : null}
      </ScrollableOverlay>
    </div>
  );
};
