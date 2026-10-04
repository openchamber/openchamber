import type { I18nKey } from '@/lib/i18n';
import type { SourceControlProvider } from '@/lib/api/types';

/**
 * GitLab calls a change request a merge request and numbers it with `!`. The
 * Git view's change-request copy is written for GitHub; this names the GitLab
 * wording for each of those messages so one component speaks both.
 */
const mergeRequestCopy = new Map<I18nKey, I18nKey>([
  ['gitView.header.openPullRequest', 'gitView.mr.openMergeRequest'],
  ['gitView.pr.actions.cancelEditingAria', 'gitView.mr.actions.cancelEditingAria'],
  ['gitView.pr.actions.createPr', 'gitView.mr.actions.createMr'],
  ['gitView.pr.actions.editPr', 'gitView.mr.actions.editMr'],
  ['gitView.pr.actions.editPrAria', 'gitView.mr.actions.editMrAria'],
  ['gitView.pr.actions.markReadyAria', 'gitView.mr.actions.markReadyAria'],
  ['gitView.pr.actions.mergePr', 'gitView.mr.actions.mergeMr'],
  ['gitView.pr.actions.mergePrAria', 'gitView.mr.actions.mergeMrAria'],
  ['gitView.pr.actions.openOnProviderAria', 'gitView.mr.actions.openOnProviderAria'],
  ['gitView.pr.actions.refresh', 'gitView.mr.actions.refresh'],
  ['gitView.pr.actions.refreshAria', 'gitView.mr.actions.refreshAria'],
  ['gitView.pr.actions.savePr', 'gitView.mr.actions.saveMr'],
  ['gitView.pr.actions.savePrAria', 'gitView.mr.actions.saveMrAria'],
  ['gitView.pr.actions.shareCommentsAria', 'gitView.mr.actions.shareCommentsAria'],
  ['gitView.pr.checkingStatus', 'gitView.mr.checkingStatus'],
  ['gitView.pr.createTitle', 'gitView.mr.createTitle'],
  ['gitView.pr.draftMustBeReady', 'gitView.mr.draftMustBeReady'],
  ['gitView.pr.history.closed', 'gitView.mr.history.closed'],
  ['gitView.pr.history.merged', 'gitView.mr.history.merged'],
  ['gitView.pr.noMergePermission', 'gitView.mr.noMergePermission'],
  ['gitView.pr.placeholder.main', 'gitView.mr.placeholder.main'],
  ['gitView.pr.placeholder.title', 'gitView.mr.placeholder.title'],
  ['gitView.pr.statusUnavailable', 'gitView.mr.statusUnavailable'],
  ['gitView.pr.toast.createPrFailed', 'gitView.mr.toast.createMrFailed'],
  ['gitView.pr.toast.generateDescriptionFailed', 'gitView.mr.toast.generateDescriptionFailed'],
  ['gitView.pr.toast.loadChecksFailed', 'gitView.mr.toast.loadChecksFailed'],
  ['gitView.pr.toast.loadPrCommentsFailed', 'gitView.mr.toast.loadMrCommentsFailed'],
  ['gitView.pr.toast.markReadyFailed', 'gitView.mr.toast.markReadyFailed'],
  ['gitView.pr.toast.markedReady', 'gitView.mr.toast.markedReady'],
  ['gitView.pr.toast.mergeFailed', 'gitView.mr.toast.mergeFailed'],
  ['gitView.pr.toast.noPrComments', 'gitView.mr.toast.noMrComments'],
  ['gitView.pr.toast.prCreated', 'gitView.mr.toast.mrCreated'],
  ['gitView.pr.toast.prMerged', 'gitView.mr.toast.mrMerged'],
  ['gitView.pr.toast.prNotMerged', 'gitView.mr.toast.mrNotMerged'],
  ['gitView.pr.toast.prUpdated', 'gitView.mr.toast.mrUpdated'],
  ['gitView.pr.toast.updatePrFailed', 'gitView.mr.toast.updateMrFailed'],
  ['gitView.pullRequest.availableOnFeatureBranches', 'gitView.mergeRequest.availableOnFeatureBranches'],
  ['gitView.pullRequest.title', 'gitView.mergeRequest.title'],
]);

/**
 * The message to show for `key` on a project hosted by `provider`: its GitLab
 * wording where one exists, else the key itself.
 */
export const changeRequestCopy = (key: I18nKey, provider: SourceControlProvider | null | undefined): I18nKey =>
  provider === 'gitlab' ? mergeRequestCopy.get(key) ?? key : key;
