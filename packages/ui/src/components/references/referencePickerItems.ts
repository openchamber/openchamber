import type { IconName } from '@/components/icon/icons';
import type {
    ChangeRequestListStatus,
    DiscussionState,
    RepositoryDiscussionReference,
    RepositoryReference,
    RepositoryReferenceDetail,
    RepositoryReferenceFilter,
    RepositoryReferencePeople,
    RepositoryReferenceState,
    RepositoryReferenceKind,
    TrackerItemSummary,
    TrackerPeopleFilter,
    TrackerPriority,
    TrackerPriorityFilter,
} from '@/lib/api/types';
import type { I18nKey } from '@/lib/i18n';
import { prVisualStateOf } from '@/lib/source-control/prVisualState';
import type { ChangeRequestTerm, SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';

/** A tracker's list, named by its tracker id; the same string names its board tab. */
export type TrackerReferenceSource = `tracker:${string}`;

/** `repository`: the project's issues and change requests, on whichever provider hosts it; a tracker's work items otherwise. */
export type ReferencePickerSource = 'repository' | TrackerReferenceSource;

export const trackerReferenceSource = (provider: string): TrackerReferenceSource => `tracker:${provider}`;

/** The tracker a source lists, or null for the repository. */
export const trackerOfSource = (source: ReferencePickerSource): string | null => (
    source.startsWith('tracker:') ? source.slice('tracker:'.length) : null
);

/** One row of the picker, from either source. */
export type ReferencePickerItem =
    /** `directory`: in a list across several repositories, the folder whose read context the item belongs to. */
    | { source: 'repository'; reference: RepositoryReference; directory?: string }
    | { source: 'tracker'; provider: string; item: TrackerItemSummary };

/** A confirmed choice: the item plus what the user set on it in the picker. */
export type ReferencePickerSelection =
    | { source: 'repository'; reference: RepositoryReference; includeDiff: boolean }
    | { source: 'tracker'; provider: string; item: TrackerItemSummary };

/** Tracker lists combine a state filter (one of the descriptor's), whose items, and a priority. */
export type TrackerReferenceFilter = {
    state: string;
    people: TrackerPeopleFilter;
    priority: TrackerPriorityFilter;
};

export const DEFAULT_TRACKER_FILTER: TrackerReferenceFilter = { state: 'open', people: 'any', priority: 'all' };

/** How the item's provider writes its number: `#12` for an issue, a discussion or a pull request, `!12` for a merge request. */
export const referenceNumberLabel = (reference: RepositoryReference, descriptor: SourceControlProviderDescriptor): string => (
    reference.kind === 'pull'
        ? formatChangeRequestReference(descriptor, reference.number)
        : `${descriptor.terminology.issuePrefix}${reference.number}`
);

const KEY_MARKERS = { pull: '!', issue: '#', discussion: '~' } as const satisfies Record<RepositoryReferenceKind, string>;

/**
 * An item's key on the picker and the board. In memory only. The kind is
 * part of it on every provider: where issues and change requests are numbered
 * apart (#1 and !1 on GitLab) they would collide otherwise, and where they
 * share one number space it changes nothing.
 */
export const referencePickerItemKey = (item: ReferencePickerItem | ReferencePickerSelection): string => {
    if (item.source === 'tracker') return `${item.provider}:${item.item.identifier.toUpperCase()}`;
    const { sourceRepo, number, kind, provider } = item.reference;
    return `${provider}:${sourceRepo.owner.toLowerCase()}/${sourceRepo.repo.toLowerCase()}${KEY_MARKERS[kind]}${number}`;
};

/** Each repository tab's icon, the same wherever a kind is named. */
export const REPOSITORY_KIND_ICONS = {
    issue: 'record-circle',
    pull: 'git-pull-request',
    discussion: 'discuss',
} as const satisfies Record<RepositoryReferenceKind, IconName>;

/** The change-request tab, named by the provider's term. */
const CHANGE_REQUEST_TAB_KEYS = {
    pullRequest: 'references.picker.tab.pulls',
    mergeRequest: 'references.picker.tab.mergeRequests',
    change: 'references.picker.tab.changes',
} as const satisfies Record<ChangeRequestTerm, I18nKey>;

/**
 * The tabs of the repository kinds a provider offers: issues, change requests
 * named by its term, and discussions where it keeps them.
 */
export const repositoryKindTabs = (
    t: (key: I18nKey) => string,
    term: ChangeRequestTerm,
    discussions: boolean,
): Array<{ id: RepositoryReferenceKind; label: string; icon: IconName }> => {
    const tabs: Array<{ id: RepositoryReferenceKind; label: string; icon: IconName }> = [
        { id: 'issue', label: t('references.picker.tab.issues'), icon: REPOSITORY_KIND_ICONS.issue },
        { id: 'pull', label: t(CHANGE_REQUEST_TAB_KEYS[term]), icon: REPOSITORY_KIND_ICONS.pull },
    ];
    if (discussions) tabs.push({ id: 'discussion', label: t('references.picker.tab.discussions'), icon: REPOSITORY_KIND_ICONS.discussion });
    return tabs;
};

/** The repository kind a tab names; anything else is issues. */
export const repositoryKindOfTab = (id: string): RepositoryReferenceKind => (id === 'pull' || id === 'discussion' ? id : 'issue');

export const DEFAULT_REPOSITORY_FILTER: RepositoryReferenceFilter = { state: 'open', people: 'any' };

/**
 * What each kind can be narrowed to: only change requests merge and get
 * review requests, only discussions wait for an answer, and nobody is
 * assigned a discussion.
 */
export const REPOSITORY_STATES = {
    issue: ['open', 'closed', 'all'],
    pull: ['open', 'merged', 'closed', 'all'],
    discussion: ['open', 'unanswered', 'closed', 'all'],
} as const satisfies Record<RepositoryReferenceKind, readonly RepositoryReferenceState[]>;
export const REPOSITORY_PEOPLE = {
    issue: ['any', 'assigned', 'created'],
    pull: ['any', 'assigned', 'created', 'reviewRequested'],
    discussion: ['any', 'created'],
} as const satisfies Record<RepositoryReferenceKind, readonly RepositoryReferencePeople[]>;


// A tracker's state filters are its descriptor's, in its menu order; people
// and priority are offered where its `filters` capabilities say so.
export const TRACKER_PEOPLE_FILTERS = ['any', 'me', 'created'] as const satisfies readonly TrackerPeopleFilter[];
export const TRACKER_PRIORITY_FILTERS = ['all', 'urgent', 'high', 'medium', 'low', 'none'] as const satisfies readonly TrackerPriorityFilter[];

const TRACKER_STATE_FILTER_LABEL_KEYS = new Map<string, I18nKey>([
    ['open', 'references.picker.filter.tracker.state.open'],
    ['all', 'references.picker.filter.tracker.state.all'],
    ['triage', 'references.picker.filter.tracker.state.triage'],
    ['backlog', 'references.picker.filter.tracker.state.backlog'],
    ['todo', 'references.picker.filter.tracker.state.todo'],
    ['in-progress', 'references.picker.filter.tracker.state.inProgress'],
    ['done', 'references.picker.filter.tracker.state.done'],
    ['canceled', 'references.picker.filter.tracker.state.canceled'],
    // Linear's own filters.
    ['inReview', 'references.picker.filter.tracker.linear.inReview'],
    ['duplicate', 'references.picker.filter.tracker.linear.duplicate'],
]);

/** The translated label of a state filter id; a filter this version has no words for shows its id. */
export const trackerStateFilterLabel = (state: string, t: (key: I18nKey) => string): string => {
    const key = TRACKER_STATE_FILTER_LABEL_KEYS.get(state);
    return key ? t(key) : state;
};

export const TRACKER_PEOPLE_LABEL_KEYS = {
    any: 'references.picker.filter.tracker.people.any',
    me: 'references.picker.filter.assigned',
    created: 'references.picker.filter.created',
} as const satisfies Record<TrackerPeopleFilter, I18nKey>;

export const TRACKER_PRIORITY_LABEL_KEYS = {
    all: 'references.picker.filter.tracker.priority.all',
    urgent: 'tracker.priority.urgent',
    high: 'tracker.priority.high',
    medium: 'tracker.priority.medium',
    low: 'tracker.priority.low',
    none: 'references.picker.filter.tracker.priority.none',
} as const satisfies Record<TrackerPriorityFilter, I18nKey>;

export const REPOSITORY_STATE_LABEL_KEYS = {
    open: 'references.picker.filter.open',
    closed: 'references.picker.filter.state.closed',
    merged: 'references.picker.filter.state.merged',
    all: 'references.picker.filter.state.all',
    unanswered: 'references.picker.filter.state.unanswered',
} as const satisfies Record<RepositoryReferenceState, I18nKey>;

export const REPOSITORY_PEOPLE_LABEL_KEYS = {
    any: 'references.picker.filter.tracker.people.any',
    assigned: 'references.picker.filter.assigned',
    created: 'references.picker.filter.created',
    reviewRequested: 'references.picker.filter.reviewRequested',
} as const satisfies Record<RepositoryReferencePeople, I18nKey>;

type StateLook = { icon: IconName; color: string; labelKey: I18nKey };

/**
 * Issue and PR states in the theme's PR colours, the way the sidebar shows
 * them: open is open, done is merged, dropped is closed. An open PR turns
 * orange on failed checks or a conflict once its status has arrived
 * (`prVisualStateOf`); until then, and while checks run, it reads as open.
 */
export const repositoryStateLook = (reference: RepositoryReference, status: ChangeRequestListStatus | null): StateLook => {
    if (reference.kind === 'discussion') return discussionStateLook(reference.state, reference.answered);
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

/**
 * A discussion's state in the same colours: open is open, and an open
 * question with its answer chosen says so; resolved is done; outdated and
 * duplicate are dropped.
 */
const discussionStateLook = (state: DiscussionState, answered: boolean | null): StateLook => {
    switch (state) {
        case 'open':
            return answered
                ? { icon: 'chat-check', color: 'var(--pr-open)', labelKey: 'references.picker.state.answered' }
                : { icon: 'discuss', color: 'var(--pr-open)', labelKey: 'references.picker.state.open' };
        case 'resolved':
            return { icon: 'chat-check', color: 'var(--pr-merged)', labelKey: 'references.picker.state.resolved' };
        case 'outdated':
            return { icon: 'chat-off', color: 'var(--pr-closed)', labelKey: 'references.picker.state.outdated' };
        case 'duplicate':
            return { icon: 'chat-off', color: 'var(--pr-closed)', labelKey: 'references.picker.state.duplicate' };
    }
};

/**
 * Whether a discussion's state can be changed: closed by someone who may
 * close it, reopened by someone who may reopen it. Until its detail says, it
 * may, and the host's own refusal explains a write it does not allow.
 */
export const canChangeDiscussionState = (
    discussion: RepositoryDiscussionReference,
    permissions: RepositoryReferenceDetail['discussion'],
): boolean => (!permissions ? true : discussion.state === 'open' ? permissions.canClose : permissions.canReopen);

/** The label of an item's priority; `none` has no label of its own on an item. */
export const TRACKER_PRIORITY_KEYS = {
    urgent: 'tracker.priority.urgent',
    high: 'tracker.priority.high',
    medium: 'tracker.priority.medium',
    low: 'tracker.priority.low',
} as const satisfies Record<Exclude<TrackerPriority, 'none'>, I18nKey>;

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
