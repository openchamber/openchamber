export type IssueTaskField = 'status' | 'priority' | 'assignee' | 'team';

/** One row in a guest issue view. Not a Linear, Jira, or GitHub record. */
export type IssueTask = {
  id: string;
  title: string;
  url?: string;
  identifier?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  team?: string;
  /** Upstream path, like `owner/repo`. */
  badge?: string;
  /** Secondary line, like `feature → main`. */
  subtitle?: string;
};

export type IssueFilterOption = {
  id: string;
  label: string;
};

/** Linear row: `start` grows and stays labeled. `end` packs after it and becomes an icon when the panel is narrow. */
export type IssueFilterSlot = 'start' | 'end';

export type IssueFilter = {
  id: string;
  label: string;
  field: IssueTaskField;
  value: string;
  options: readonly IssueFilterOption[];
  /** Option id that means "no filter". Defaults to `all`. */
  allValue?: string;
  /**
   * Where this control sits. Omit to follow array order: the first filter is
   * `start`, the rest are `end`.
   */
  slot?: IssueFilterSlot;
};

export type IssueViewLabels = {
  search: string;
  empty: string;
  emptyFiltered: string;
  busy: string;
  open: string;
  more: string;
};

export type IssueViewToggle = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

/** Guest passes rows. The component owns search and selected filter values. */
export type IssueViewProps = {
  items: readonly IssueTask[];
  onSelect: (item: IssueTask) => void;
  /** External-link control on a row. Omit to hide it. */
  onOpen?: (item: IssueTask) => void;
  /** Filter menus. `value` is the initial choice for that id. */
  filters?: readonly IssueFilter[];
  /** Fires when the user picks a filter. Guest remembers this if it remounts. */
  onFilterChange?: (id: string, value: string) => void;
  busy?: boolean;
  selectedId?: string;
  labels?: Partial<IssueViewLabels>;
  hasMore?: boolean;
  onMore?: () => void;
  /** One checkbox, like GitHub's include-diff. The guest owns the meaning. */
  toggle?: IssueViewToggle;
  /** Second checkbox, like create-in-worktree on the GitHub picker. */
  session?: IssueViewToggle;
  /** Page-level action, like New merge request. */
  action?: IssueViewAction;
};

export type IssueViewAction = {
  label: string;
  onClick: () => void;
};

export type IssueViewHandle = {
  update: (props: IssueViewProps) => void;
  dispose: () => void;
};

export type AttachIssuesLabels = IssueViewLabels;
export type AttachIssuesProps = IssueViewProps;
export type AttachIssuesHandle = IssueViewHandle;
export type IssuePageLabels = IssueViewLabels;
export type IssuePageProps = IssueViewProps;
export type IssuePageHandle = IssueViewHandle;

export type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  /** Icon-only until opened. Linear's rail search. */
  compact?: boolean;
};

export type SearchInputHandle = {
  update: (props: SearchInputProps) => void;
  dispose: () => void;
};

export type FilterBarProps = {
  filters: readonly IssueFilter[];
  onChange: (filterId: string, value: string) => void;
};

export type FilterBarHandle = {
  update: (props: FilterBarProps) => void;
  dispose: () => void;
};

export type IssueListProps = {
  items: readonly IssueTask[];
  onSelect: (item: IssueTask) => void;
  onOpen?: (item: IssueTask) => void;
  selectedId?: string;
  busy?: boolean;
  empty?: string;
  openLabel?: string;
  moreLabel?: string;
  hasMore?: boolean;
  onMore?: () => void;
};

export type IssueListHandle = {
  update: (props: IssueListProps) => void;
  dispose: () => void;
};

export type IssueCardChip = {
  id: string;
  name: string;
};

export type IssueCardField = {
  label: string;
  value: string;
};

export type IssueCardComment = {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
};

export type IssueCardStatus = {
  value: string;
  options: readonly IssueFilterOption[];
};

export type IssueCardAction = {
  label: string;
  onClick: () => void;
};

export type IssueCardLabels = {
  back: string;
  open: string;
  status: string;
  comments: string;
  emptyDescription: string;
  emptyComments: string;
  tags: string;
  action: string;
  busy: string;
};

/** Linear issue detail. Guest passes the record. Host still only sees attach. */
export type IssueCardProps = {
  item: IssueTask;
  description?: string;
  status?: IssueCardStatus;
  fields?: readonly IssueCardField[];
  tags?: readonly IssueCardChip[];
  comments?: readonly IssueCardComment[];
  onBack: () => void;
  onOpen?: (item: IssueTask) => void;
  /** http(s) markdown links in description and comments. Guest wires `host.openUrl`. */
  onOpenUrl?: (url: string) => void;
  onAction?: (item: IssueTask) => void;
  onStatusChange?: (value: string) => void;
  secondaryAction?: IssueCardAction;
  busy?: boolean;
  labels?: Partial<IssueCardLabels>;
};

export type IssueCardHandle = {
  update: (props: IssueCardProps) => void;
  dispose: () => void;
};

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';
export type PullRequestCheckState = 'success' | 'failure' | 'pending' | 'queued' | 'running';
export type PullRequestMergeMethod = 'squash' | 'merge' | 'rebase';
export type PullRequestTab = 'overview' | 'changes' | 'checks' | 'comments';

/** Guest-owned pull record. Not a GitHub PR. */
export type PullRequestRecord = {
  id: string;
  title: string;
  url?: string;
  state: PullRequestState;
  head?: string;
  base?: string;
  author?: string;
  body?: string;
  mergeable?: boolean;
};

/** One changed file in a pull. Diff is unified text. */
export type PullRequestChange = {
  path: string;
  diff: string;
};

export type PullRequestCheck = {
  id: string;
  name: string;
  state: PullRequestCheckState;
  detail?: string;
};

export type PullRequestChecksSummary = {
  success: number;
  total: number;
};

export type PullRequestCreateValues = {
  title: string;
  description: string;
  head: string;
  base: string;
  draft: boolean;
};

export type PullRequestCreateProps = {
  values?: Partial<PullRequestCreateValues>;
  /** When set, head and base are pickers. Omit to keep text fields. */
  branches?: readonly string[];
  onSubmit: (values: PullRequestCreateValues) => void;
};

export type PullRequestLabels = {
  title: string;
  open: string;
  refresh: string;
  overview: string;
  changes: string;
  checks: string;
  comments: string;
  attach: string;
  startSession: string;
  startWorktree: string;
  markReady: string;
  merge: string;
  mergeSquash: string;
  mergeMerge: string;
  mergeRebase: string;
  sendFailedChecks: string;
  sendComments: string;
  emptyDescription: string;
  emptyChanges: string;
  emptyChecks: string;
  emptyComments: string;
  notMergeable: string;
  stateOpen: string;
  stateDraft: string;
  stateMerged: string;
  stateClosed: string;
  createTitle: string;
  createDescription: string;
  createHead: string;
  createBase: string;
  createEmptyBranch: string;
  createDraft: string;
  createSubmit: string;
  save: string;
  back: string;
  busy: string;
};

export type PullRequestProps = {
  mode: 'view' | 'create';
  pull?: PullRequestRecord;
  changes?: readonly PullRequestChange[];
  checks?: readonly PullRequestCheck[];
  checksSummary?: PullRequestChecksSummary;
  comments?: readonly IssueCardComment[];
  create?: PullRequestCreateProps;
  onBack?: () => void;
  onOpen?: () => void;
  onRefresh?: () => void;
  onAttach?: () => void;
  onStartSession?: (worktree: boolean) => void;
  onReady?: () => void;
  onMerge?: (method: PullRequestMergeMethod) => void;
  onSendFailedChecks?: () => void;
  onSendComments?: () => void;
  onSaveOverview?: (title: string, body: string) => void;
  busy?: boolean;
  labels?: Partial<PullRequestLabels>;
};

export type PullRequestHandle = {
  update: (props: PullRequestProps) => void;
  dispose: () => void;
};
