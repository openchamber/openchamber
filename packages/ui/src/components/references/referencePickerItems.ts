import type { IconName } from '@/components/icon/icons';
import type {
    GitHubPullStatus,
    GitHubReference,
    RepositoryReferenceFilter,
    RepositoryReferencePeople,
    RepositoryReferenceState,
    GitHubReferenceKind,
    LinearIssueListAssignee,
    LinearIssueListPriority,
    LinearIssueListStatus,
    LinearIssueSummary,
} from '@/lib/api/types';
import type { I18nKey } from '@/lib/i18n';
import { prVisualStateOf } from '@/lib/source-control/prVisualState';

export type ReferencePickerSource = 'github' | 'linear';

/** One row of the picker, from either source. */
export type ReferencePickerItem =
    | { source: 'github'; reference: GitHubReference }
    | { source: 'linear'; issue: LinearIssueSummary };

/** A confirmed choice: the item plus what the user set on it in the picker. */
export type ReferencePickerSelection =
    | { source: 'github'; reference: GitHubReference; includeDiff: boolean }
    | { source: 'linear'; issue: LinearIssueSummary };

/** Linear lists combine a state, whose issues, and a priority. */
export type LinearReferenceFilter = {
    status: LinearIssueListStatus;
    people: LinearIssueListAssignee;
    priority: LinearIssueListPriority;
};

export const DEFAULT_LINEAR_FILTER: LinearReferenceFilter = { status: 'open', people: 'any', priority: 'all' };

/** `#12` for an issue or a GitHub PR, `!12` for a GitLab merge request. */
export const referenceNumberLabel = (reference: GitHubReference): string => (
    reference.kind === 'pull' && reference.provider === 'gitlab' ? `!${reference.number}` : `#${reference.number}`
);

export const referencePickerItemKey = (item: ReferencePickerItem | ReferencePickerSelection): string => {
    if (item.source === 'linear') return `linear:${item.issue.identifier.toUpperCase()}`;
    const { sourceRepo, number, kind, provider } = item.reference;
    // GitLab numbers issues (#1) and merge requests (!1) separately, so the
    // kind is part of the key; on GitHub both share one number space.
    const host = provider ?? 'github';
    const marker = host === 'gitlab' && kind === 'pull' ? '!' : '#';
    return `${host}:${sourceRepo.owner.toLowerCase()}/${sourceRepo.repo.toLowerCase()}${marker}${number}`;
};

export const DEFAULT_REPOSITORY_FILTER: RepositoryReferenceFilter = { state: 'open', people: 'any' };

/** What each kind can be narrowed to: only change requests merge and get review requests. */
export const REPOSITORY_STATES = {
    issue: ['open', 'closed', 'all'],
    pull: ['open', 'merged', 'closed', 'all'],
} as const satisfies Record<GitHubReferenceKind, readonly RepositoryReferenceState[]>;
export const REPOSITORY_PEOPLE = {
    issue: ['any', 'assigned', 'created'],
    pull: ['any', 'assigned', 'created', 'reviewRequested'],
} as const satisfies Record<GitHubReferenceKind, readonly RepositoryReferencePeople[]>;

export const LINEAR_STATUS_FILTERS = [
    'open', 'all', 'backlog', 'todo', 'started', 'inReview', 'completed', 'canceled', 'duplicate',
] as const satisfies readonly LinearIssueListStatus[];
export const LINEAR_PEOPLE_FILTERS = ['any', 'me', 'created'] as const satisfies readonly LinearIssueListAssignee[];
export const LINEAR_PRIORITY_FILTERS = ['all', 'urgent', 'high', 'medium', 'low', 'none'] as const satisfies readonly LinearIssueListPriority[];

export const LINEAR_STATUS_LABEL_KEYS = {
    open: 'references.picker.filter.linear.status.open',
    all: 'references.picker.filter.linear.status.all',
    backlog: 'references.picker.filter.linear.status.backlog',
    todo: 'references.picker.filter.linear.status.todo',
    started: 'references.picker.filter.linear.status.started',
    inReview: 'references.picker.filter.linear.status.inReview',
    completed: 'references.picker.filter.linear.status.completed',
    canceled: 'references.picker.filter.linear.status.canceled',
    duplicate: 'references.picker.filter.linear.status.duplicate',
} as const satisfies Record<LinearIssueListStatus, I18nKey>;

export const LINEAR_PEOPLE_LABEL_KEYS = {
    any: 'references.picker.filter.linear.people.any',
    me: 'references.picker.filter.assigned',
    created: 'references.picker.filter.created',
} as const satisfies Record<LinearIssueListAssignee, I18nKey>;

export const LINEAR_PRIORITY_LABEL_KEYS = {
    all: 'references.picker.filter.linear.priority.all',
    urgent: 'contextPanel.linear.priority.urgent',
    high: 'contextPanel.linear.priority.high',
    medium: 'contextPanel.linear.priority.medium',
    low: 'contextPanel.linear.priority.low',
    none: 'references.picker.filter.linear.priority.none',
} as const satisfies Record<LinearIssueListPriority, I18nKey>;

export const REPOSITORY_STATE_LABEL_KEYS = {
    open: 'references.picker.filter.open',
    closed: 'references.picker.filter.state.closed',
    merged: 'references.picker.filter.state.merged',
    all: 'references.picker.filter.state.all',
} as const satisfies Record<RepositoryReferenceState, I18nKey>;

export const REPOSITORY_PEOPLE_LABEL_KEYS = {
    any: 'references.picker.filter.linear.people.any',
    assigned: 'references.picker.filter.assigned',
    created: 'references.picker.filter.created',
    reviewRequested: 'references.picker.filter.reviewRequested',
} as const satisfies Record<RepositoryReferencePeople, I18nKey>;

/** How a state is drawn: an icon in a theme colour. */
type StateGlyph = { icon: IconName; color: string };

type StateLook = StateGlyph & { labelKey: I18nKey };

/**
 * Issue and PR states in the theme's PR colours, the way the sidebar shows
 * them: open is open, done is merged, dropped is closed. An open PR turns
 * orange on failed checks or a conflict once its status has arrived
 * (`prVisualStateOf`); until then it reads as open.
 */
export const githubStateLook = (reference: GitHubReference, status: GitHubPullStatus | null): StateLook => {
    if (reference.kind === 'issue') {
        switch (reference.state) {
            case 'open':
                return { icon: 'record-circle', color: 'var(--pr-open)', labelKey: 'references.picker.state.open' };
            case 'completed':
                return { icon: 'checkbox-circle', color: 'var(--pr-merged)', labelKey: 'references.picker.state.completed' };
            case 'not_planned':
                return { icon: 'close-circle', color: 'var(--pr-closed)', labelKey: 'references.picker.state.notPlanned' };
        }
    }
    if (reference.state === 'merged') return { icon: 'git-merge', color: 'var(--pr-merged)', labelKey: 'references.picker.state.merged' };
    if (reference.state === 'closed') return { icon: 'git-close-pull-request', color: 'var(--pr-closed)', labelKey: 'references.picker.state.closed' };
    if (reference.draft) return { icon: 'git-pr-draft', color: 'var(--pr-draft)', labelKey: 'references.picker.state.draft' };
    const visual = prVisualStateOf({
        state: reference.state,
        draft: reference.draft,
        checksState: status?.checks?.state,
        mergeable: status?.mergeable,
        mergeableState: status?.mergeableState,
    });
    return { icon: 'git-pull-request', color: `var(--pr-${visual})`, labelKey: 'references.picker.state.open' };
};

/** Linear workflow types in the same colours; the state's own name is the label. */
export const linearStateLook = (issue: LinearIssueSummary): StateGlyph => linearStateTypeLook(issue.state?.type ?? null);

/** The look of a Linear workflow type, for a state that is not an issue's yet (a status menu). */
export const linearStateTypeLook = (type: string | null): StateGlyph => {
    switch (type) {
        case 'started':
            return { icon: 'record-circle', color: 'var(--pr-open)' };
        case 'completed':
            return { icon: 'checkbox-circle', color: 'var(--pr-merged)' };
        case 'canceled':
        case 'duplicate':
            return { icon: 'close-circle', color: 'var(--pr-closed)' };
        default:
            return { icon: 'checkbox-blank-circle', color: 'var(--surface-muted-foreground)' };
    }
};

export const LINEAR_PRIORITY_KEYS = {
    1: 'contextPanel.linear.priority.urgent',
    2: 'contextPanel.linear.priority.high',
    3: 'contextPanel.linear.priority.medium',
    4: 'contextPanel.linear.priority.low',
} as const satisfies Record<1 | 2 | 3 | 4, I18nKey>;

type RelativeTime =
    | { key: 'common.relative.justNow' }
    | {
        key:
            | 'common.relative.minutesAgoShort'
            | 'common.relative.hoursAgoShort'
            | 'common.relative.daysAgoShort'
            | 'common.relative.weeksAgoShort'
            | 'common.relative.yearsAgoShort';
        count: number;
    };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/** How long ago an ISO timestamp was, as a short message key; null when unknown. */
export const relativeTimeOf = (iso: string | null | undefined, now: number): RelativeTime | null => {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    const elapsed = Math.max(0, now - at);
    if (elapsed < MINUTE) return { key: 'common.relative.justNow' };
    if (elapsed < HOUR) return { key: 'common.relative.minutesAgoShort', count: Math.floor(elapsed / MINUTE) };
    if (elapsed < DAY) return { key: 'common.relative.hoursAgoShort', count: Math.floor(elapsed / HOUR) };
    if (elapsed < WEEK) return { key: 'common.relative.daysAgoShort', count: Math.floor(elapsed / DAY) };
    if (elapsed < YEAR) return { key: 'common.relative.weeksAgoShort', count: Math.floor(elapsed / WEEK) };
    return { key: 'common.relative.yearsAgoShort', count: Math.floor(elapsed / YEAR) };
};

/**
 * Ids, people, times and labels around an item. One step quieter than the
 * usual muted text, so titles and bodies stay the brightest thing on screen.
 */
export const REFERENCE_META_TEXT = 'text-muted-foreground/60';

/** GitHub label colours come as bare hex; anything else gets the neutral chip. */
export const labelColor = (color: string | null | undefined): string | null => {
    if (!color) return null;
    const hex = color.startsWith('#') ? color.slice(1) : color;
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : null;
};
