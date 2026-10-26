import type { I18nKey } from '@/lib/i18n';
import type { ChangeRequestTerm } from './providers/descriptor';

/**
 * The change-request copy (Git view, comparison, walkthrough) is written for
 * pull requests; these name the wording of each of those messages for every
 * other term, so one component speaks whichever term the provider uses.
 */
const mergeRequestCopy = new Map<I18nKey, I18nKey>([
  ['gitView.header.openPullRequest', 'gitView.mr.openMergeRequest'],
  ['gitView.pr.actions.createPr', 'gitView.mr.actions.createMr'],
  ['gitView.pr.actions.openOnProviderAria', 'gitView.mr.actions.openOnProviderAria'],
  ['gitView.pr.actions.refresh', 'gitView.mr.actions.refresh'],
  ['gitView.pr.actions.refreshAria', 'gitView.mr.actions.refreshAria'],
  ['gitView.pr.checkingStatus', 'gitView.mr.checkingStatus'],
  ['gitView.pr.history.closed', 'gitView.mr.history.closed'],
  ['gitView.pr.history.merged', 'gitView.mr.history.merged'],
  ['gitView.pr.placeholder.main', 'gitView.mr.placeholder.main'],
  ['gitView.pr.placeholder.title', 'gitView.mr.placeholder.title'],
  ['gitView.pr.statusUnavailable', 'gitView.mr.statusUnavailable'],
  ['gitView.pr.toast.createPrFailed', 'gitView.mr.toast.createMrFailed'],
  ['gitView.pr.toast.generateDescriptionFailed', 'gitView.mr.toast.generateDescriptionFailed'],
  ['gitView.pr.toast.prCreated', 'gitView.mr.toast.mrCreated'],
  ['gitView.pullRequest.availableOnFeatureBranches', 'gitView.mergeRequest.availableOnFeatureBranches'],
  ['gitView.pullRequest.title', 'gitView.mergeRequest.title'],
  ['session.githubIntegration.tabs.pullRequests', 'gitView.mr.comparison.mode'],
  ['pullRequestComparison.select', 'gitView.mr.comparison.select'],
  ['gitView.pr.actions.createDraftPr', 'gitView.mr.actions.createDraftMr'],
  ['gitView.pr.actions.pushAndCreatePr', 'gitView.mr.actions.pushAndCreateMr'],
  ['gitView.pr.actions.pushAndCreateDraftPr', 'gitView.mr.actions.pushAndCreateDraftMr'],
  ['pullRequestComparison.pickAbove', 'gitView.mr.comparison.pickAbove'],
  ['pullRequestComparison.diffUnavailable', 'gitView.mr.comparison.diffUnavailable'],
  ['pullRequestComparison.partial', 'gitView.mr.comparison.partial'],
  ['session.githubPrPicker.searchPlaceholder', 'gitView.mr.comparison.searchPlaceholder'],
  ['session.githubPrPicker.loading.pullRequests', 'gitView.mr.comparison.loading'],
  ['session.githubPrPicker.empty.noPullRequestsFound', 'gitView.mr.comparison.empty'],
  ['session.githubPrPicker.empty.notConnected', 'gitView.mr.comparison.notConnected'],
  ['session.githubPrPicker.error.runtimeUnavailable', 'gitView.mr.comparison.runtimeUnavailable'],
  ['session.githubPrPicker.toast.loadMoreFailed', 'gitView.mr.comparison.loadMoreFailed'],
  ['walkthrough.scope.pullRequest', 'gitView.mr.walkthroughScope'],
  ['gitView.pullRequest.createHint', 'gitView.mr.createHint'],
  ['session.newWorktree.mode.fromItem', 'session.newWorktree.mr.item'],
  ['session.newWorktree.item.title', 'session.newWorktree.mr.item'],
  ['session.newWorktree.start.fromItemHint', 'session.newWorktree.mr.fromItemHint'],
  ['session.newWorktree.start.fromItemUnavailable', 'session.newWorktree.mr.fromItemUnavailable'],
  ['session.newWorktree.error.changeRequestAuthorityMissing', 'session.newWorktree.mr.authorityMissing'],
  ['chat.generatedResult.pullRequest.title', 'chat.generatedResult.mergeRequest.title'],
  ['chat.chatInput.linked.pr.openInBrowserAria', 'chat.chatInput.linked.mr.openInBrowserAria'],
  ['chat.chatInput.linked.pr.removeAria', 'chat.chatInput.linked.mr.removeAria'],
  ['sessions.mergedCleanup.toast.archivedTitle', 'sessions.mergedCleanup.toast.mr.archivedTitle'],
  ['sessions.mergedCleanup.toast.failedTitle', 'sessions.mergedCleanup.toast.mr.failedTitle'],
  ['sessions.sidebar.group.pr.status.open', 'sessions.sidebar.group.mr.status.open'],
  ['sessions.sidebar.group.pr.status.draft', 'sessions.sidebar.group.mr.status.draft'],
  ['chat.chatInput.prCheckContext', 'chat.chatInput.mrCheckContext'],
  ['chat.chatInput.prCommentContext', 'chat.chatInput.mrCommentContext'],
  ['chat.message.context.prComment', 'chat.message.context.mrComment'],
  ['chat.message.context.prCheck', 'chat.message.context.mrCheck'],
  ['chat.workStatus.pr.untitled', 'chat.workStatus.mr.untitled'],
  ['chat.workStatus.action.openPr', 'chat.workStatus.action.openMr'],
  ['chat.workStatus.breakdown.prCountSingle', 'chat.workStatus.breakdown.mrCountSingle'],
  ['chat.workStatus.breakdown.prCountPlural', 'chat.workStatus.breakdown.mrCountPlural'],
]);

/** The same messages for a review host's changes. */
const changeCopy = new Map<I18nKey, I18nKey>([
  ['gitView.header.openPullRequest', 'gitView.change.openChange'],
  ['gitView.pr.actions.createPr', 'gitView.change.actions.create'],
  ['gitView.pr.actions.openOnProviderAria', 'gitView.change.actions.openOnProviderAria'],
  ['gitView.pr.actions.refresh', 'gitView.change.actions.refresh'],
  ['gitView.pr.actions.refreshAria', 'gitView.change.actions.refreshAria'],
  ['gitView.pr.checkingStatus', 'gitView.change.checkingStatus'],
  ['gitView.pr.history.closed', 'gitView.change.history.closed'],
  ['gitView.pr.history.merged', 'gitView.change.history.merged'],
  ['gitView.pr.placeholder.main', 'gitView.change.placeholder.main'],
  ['gitView.pr.placeholder.title', 'gitView.change.placeholder.title'],
  ['gitView.pr.statusUnavailable', 'gitView.change.statusUnavailable'],
  ['gitView.pr.toast.createPrFailed', 'gitView.change.toast.createFailed'],
  ['gitView.pr.toast.generateDescriptionFailed', 'gitView.change.toast.generateDescriptionFailed'],
  ['gitView.pr.toast.prCreated', 'gitView.change.toast.created'],
  ['gitView.pullRequest.availableOnFeatureBranches', 'gitView.change.availableOnFeatureBranches'],
  ['gitView.pullRequest.title', 'gitView.change.title'],
  ['session.githubIntegration.tabs.pullRequests', 'gitView.change.comparison.mode'],
  ['pullRequestComparison.select', 'gitView.change.comparison.select'],
  ['gitView.pr.actions.createDraftPr', 'gitView.change.actions.createDraft'],
  ['gitView.pr.actions.pushAndCreatePr', 'gitView.change.actions.pushAndCreate'],
  ['gitView.pr.actions.pushAndCreateDraftPr', 'gitView.change.actions.pushAndCreateDraft'],
  ['pullRequestComparison.pickAbove', 'gitView.change.comparison.pickAbove'],
  ['pullRequestComparison.partial', 'gitView.change.comparison.partial'],
  ['pullRequestComparison.diffUnavailable', 'gitView.change.comparison.diffUnavailable'],
  ['session.githubPrPicker.searchPlaceholder', 'gitView.change.comparison.searchPlaceholder'],
  ['session.githubPrPicker.loading.pullRequests', 'gitView.change.comparison.loading'],
  ['session.githubPrPicker.empty.noPullRequestsFound', 'gitView.change.comparison.empty'],
  ['session.githubPrPicker.empty.notConnected', 'gitView.change.comparison.notConnected'],
  ['session.githubPrPicker.error.runtimeUnavailable', 'gitView.change.comparison.runtimeUnavailable'],
  ['session.githubPrPicker.toast.loadMoreFailed', 'gitView.change.comparison.loadMoreFailed'],
  ['walkthrough.scope.pullRequest', 'gitView.change.walkthroughScope'],
  ['gitView.pullRequest.createHint', 'gitView.change.createHint'],
  ['session.newWorktree.mode.fromItem', 'session.newWorktree.change.item'],
  ['session.newWorktree.item.title', 'session.newWorktree.change.item'],
  ['session.newWorktree.start.fromItemHint', 'session.newWorktree.change.fromItemHint'],
  ['session.newWorktree.start.fromItemUnavailable', 'session.newWorktree.change.fromItemUnavailable'],
  ['session.newWorktree.error.changeRequestAuthorityMissing', 'session.newWorktree.change.authorityMissing'],
  ['chat.generatedResult.pullRequest.title', 'chat.generatedResult.change.title'],
  ['chat.chatInput.linked.pr.openInBrowserAria', 'chat.chatInput.linked.change.openInBrowserAria'],
  ['chat.chatInput.linked.pr.removeAria', 'chat.chatInput.linked.change.removeAria'],
  ['sessions.mergedCleanup.toast.archivedTitle', 'sessions.mergedCleanup.toast.change.archivedTitle'],
  ['sessions.mergedCleanup.toast.failedTitle', 'sessions.mergedCleanup.toast.change.failedTitle'],
  ['sessions.sidebar.group.pr.status.open', 'sessions.sidebar.group.change.status.open'],
  ['sessions.sidebar.group.pr.status.draft', 'sessions.sidebar.group.change.status.draft'],
  ['chat.chatInput.prCheckContext', 'chat.chatInput.changeCheckContext'],
  ['chat.chatInput.prCommentContext', 'chat.chatInput.changeCommentContext'],
  ['chat.message.context.prComment', 'chat.message.context.changeComment'],
  ['chat.message.context.prCheck', 'chat.message.context.changeCheck'],
  ['chat.workStatus.pr.untitled', 'chat.workStatus.change.untitled'],
  ['chat.workStatus.action.openPr', 'chat.workStatus.change.openChange'],
  ['chat.workStatus.breakdown.prCountSingle', 'chat.workStatus.change.countSingle'],
  ['chat.workStatus.breakdown.prCountPlural', 'chat.workStatus.change.countPlural'],
]);

/** Each term's wording of the pull-request messages; every term maps every message the others do. */
const TERM_COPY = {
  mergeRequest: mergeRequestCopy,
  change: changeCopy,
} satisfies Record<Exclude<ChangeRequestTerm, 'pullRequest'>, ReadonlyMap<I18nKey, I18nKey>>;

/** The pull-request messages `term` words its own way. */
export const changeRequestCopyKeys = (term: Exclude<ChangeRequestTerm, 'pullRequest'>): I18nKey[] => [...TERM_COPY[term].keys()];

/**
 * The message to show for `key` where change requests go by `term`: its
 * wording for that term where one exists, else the key itself.
 */
export const changeRequestCopy = (key: I18nKey, term: ChangeRequestTerm): I18nKey =>
  term === 'pullRequest' ? key : TERM_COPY[term].get(key) ?? key;
