/**
 * Localized toast wrapper.
 *
 * Drop-in replacement for `toast` from @/components/ui.
 * Maps known message strings to i18n keys; passes unknown strings through verbatim.
 *
 * Usage (component migration — one line change):
 *   - import { toast } from '@/components/ui'
 *   + import { toast } from '@/lib/i18n/toast'
 *
 * Messages not yet in the i18n map pass through unchanged — safe incremental adoption.
 */

import { toast as uiToast } from '@/components/ui';
import type { ExternalToast } from 'sonner';
import {
  toastFailedSelectDir,
  toastFailedAddProject,
  toastNoActiveProject,
  toastGithubNotConnected,
  toastGithubUnavailable,
  toastNotGitRepo,
  toastFailedCreateWorktree,
  toastNoActiveSession,
  toastPasskeyAdded,
  toastPasskeyCanceled,
  toastNotificationDenied,
  toastLatestVersion,
  toastFailedCopyUrl,
  commonCopied,
  ocStatusCopied,
  aboutDiagCopied,
  toastUpdateFailedApp,
  toastUpdateFailed,
  prToastFailedLoadCheckDetails,
  prToastFailedLoadComments,
  prToastOpenChatSessionFirst,
  prToastNoModelSelected,
  prToastFailedSendMessage,
  prToastNoFailedChecks,
  prToastFailedLoadChecks,
  prToastNoPRComments,
  prToastFailedLoadPRComments,
  prToastFailedGenerateDescription,
  prToastTitleRequired,
  prToastBaseBranchRequired,
  prToastBaseBranchMustDiffer,
  prToastPRCreated,
  prToastFailedCreatePR,
  prToastPRMerged,
  prToastPRNotMerged,
  prToastNotMergeable,
  prToastMergeFailed,
  prToastMarkedReady,
  prToastFailedMarkReady,
  prToastPRUpdated,
  prToastFailedUpdatePR,
  fileTreePathCopied,
  fileTreeCopyFailed,
  fileTreeFileCreated,
  fileTreeFolderCreated,
  fileTreeRenamedSuccessfully,
  fileTreeDeletedSuccessfully,
  fileTreeOperationFailed,
  fileTreeFailedToRevealPath,
  projActionOpenedUrlFromOutput,
  projActionOpenedForwardedUrl,
  projActionOpenedActionUrl,
  projActionInvalidCustomUrl,
  projActionDesktopForwardUnavailable,
  projActionNoActiveDirectory,
  projActionFailedToRunAction,
  projActionFailedToCreateTerminalSession,
  gitToastCommitHashCopied,
  gitToastRefreshFailed,
  gitToastPushedToUpstream,
  gitToastRemoteNameRequired,
  gitToastCannotRemoveOrigin,
  gitToastCommitMessageRequired,
  gitToastSelectFileToCommit,
  gitToastCommitCreated,
  gitToastCommitFailed,
  gitToastSelectFileToDescribe,
  gitToastGenerateMessageFailed,
  gitToastCreateBranchFailed,
  gitToastBranchCreatedLocally,
  gitToastIdentityApplyFailed,
  gitToastRevertFailed,
  gitToastMergeAborted,
  gitToastRebaseAborted,
  gitToastMergeCompleted,
  gitToastRebaseConflictsDetected,
  gitToastRebaseStepCompleted,
  gitToastContinueFailed,
  gitToastAbortOperationFailed,
  gitToastStashRestored,
  gitToastStashRestoreFailed,
  filesSavingNotSupported,
  filesFailedToWriteFile,
  filesSaveFailed,
  filesFailedToReadFile,
} from '@/lib/i18n/messages';

// Map of known English strings → i18n functions
const MESSAGE_MAP: Record<string, () => string> = {
  'Failed to select directory': toastFailedSelectDir,
  'Failed to add project': toastFailedAddProject,
  'No active project': toastNoActiveProject,
  'Copy failed': fileTreeCopyFailed,
  'Operation failed': fileTreeOperationFailed,
  'GitHub not connected': toastGithubNotConnected,
  'GitHub runtime API unavailable': toastGithubUnavailable,
  'Not a Git repository': toastNotGitRepo,
  'Failed to create worktree': toastFailedCreateWorktree,
  'No active session': toastNoActiveSession,
  'Passkey added': toastPasskeyAdded,
  'Passkey setup canceled': toastPasskeyCanceled,
  'Notification permission denied': toastNotificationDenied,
  'You are on the latest version': toastLatestVersion,
  'Failed to copy URL': toastFailedCopyUrl,
  'Copied': commonCopied,
  'OpenCode status copied to clipboard.': ocStatusCopied,
  'Diagnostics copied': aboutDiagCopied,
  'Failed to install update': toastUpdateFailedApp,
  'Update failed': toastUpdateFailed,
  'Failed to load check details': prToastFailedLoadCheckDetails,
  'Failed to load comments': prToastFailedLoadComments,
  'Open a chat session first.': prToastOpenChatSessionFirst,
  'No model selected': prToastNoModelSelected,
  'Failed to send message': prToastFailedSendMessage,
  'No failed checks': prToastNoFailedChecks,
  'Failed to load checks': prToastFailedLoadChecks,
  'No PR comments': prToastNoPRComments,
  'Failed to load PR comments': prToastFailedLoadPRComments,
  'Failed to generate description': prToastFailedGenerateDescription,
  'Title is required': prToastTitleRequired,
  'Base branch is required': prToastBaseBranchRequired,
  'Base branch must differ from head branch': prToastBaseBranchMustDiffer,
  'PR created': prToastPRCreated,
  'Failed to create PR': prToastFailedCreatePR,
  'PR merged': prToastPRMerged,
  'PR not merged': prToastPRNotMerged,
  'Not mergeable': prToastNotMergeable,
  'Merge failed': prToastMergeFailed,
  'Marked ready for review': prToastMarkedReady,
  'Failed to mark ready': prToastFailedMarkReady,
  'PR updated': prToastPRUpdated,
  'Failed to update PR': prToastFailedUpdatePR,
  'Path copied': fileTreePathCopied,
  'File created': fileTreeFileCreated,
  'Folder created': fileTreeFolderCreated,
  'Renamed successfully': fileTreeRenamedSuccessfully,
  'Deleted successfully': fileTreeDeletedSuccessfully,
  'Failed to reveal path': fileTreeFailedToRevealPath,
  'Opened URL from action output': projActionOpenedUrlFromOutput,
  'Opened forwarded URL': projActionOpenedForwardedUrl,
  'Opened action URL': projActionOpenedActionUrl,
  'Invalid custom URL format': projActionInvalidCustomUrl,
  'Selected desktop SSH forward is unavailable': projActionDesktopForwardUnavailable,
  'No active directory for action': projActionNoActiveDirectory,
  'Failed to run action': projActionFailedToRunAction,
  'Failed to create terminal session': projActionFailedToCreateTerminalSession,
  'Commit hash copied': gitToastCommitHashCopied,
  'Failed to refresh repository state': gitToastRefreshFailed,
  'Pushed to upstream': gitToastPushedToUpstream,
  'Remote name is required': gitToastRemoteNameRequired,
  'Cannot remove origin remote': gitToastCannotRemoveOrigin,
  'Please enter a commit message': gitToastCommitMessageRequired,
  'Select at least one file to commit': gitToastSelectFileToCommit,
  'Commit created successfully': gitToastCommitCreated,
  'Failed to create commit': gitToastCommitFailed,
  'Select at least one file to describe': gitToastSelectFileToDescribe,
  'Failed to generate commit message': gitToastGenerateMessageFailed,
  'Failed to create branch': gitToastCreateBranchFailed,
  'Branch created locally': gitToastBranchCreatedLocally,
  'Failed to apply git identity': gitToastIdentityApplyFailed,
  'Failed to revert changes': gitToastRevertFailed,
  'Merge aborted': gitToastMergeAborted,
  'Rebase aborted': gitToastRebaseAborted,
  'Merge completed': gitToastMergeCompleted,
  'Rebase conflicts detected': gitToastRebaseConflictsDetected,
  'Rebase step completed': gitToastRebaseStepCompleted,
  'Failed to continue operation': gitToastContinueFailed,
  'Failed to abort operation': gitToastAbortOperationFailed,
  'Stashed changes restored': gitToastStashRestored,
  'Failed to restore stashed changes': gitToastStashRestoreFailed,
  'Saving not supported': filesSavingNotSupported,
  'Failed to write file': filesFailedToWriteFile,
  'Save failed': filesSaveFailed,
  'Failed to read file': filesFailedToReadFile,
};

/**
 * Localize a toast message if we have a mapping for it.
 * Unknown strings pass through unchanged — safe for incremental adoption.
 */
function localizeMessage(message: string | React.ReactNode): string | React.ReactNode {
  if (typeof message !== 'string') {
    return message;
  }
  const fn = MESSAGE_MAP[message];
  return fn ? fn() : message;
}

// Re-export the toast API with message localization
export const toast = {
  success: (message: string | React.ReactNode, data?: ExternalToast) => {
    return uiToast.success(localizeMessage(message), data);
  },
  error: (message: string | React.ReactNode, data?: ExternalToast) => {
    return uiToast.error(localizeMessage(message), data);
  },
  info: (message: string | React.ReactNode, data?: ExternalToast) => {
    return uiToast.info(localizeMessage(message), data);
  },
  warning: (message: string | React.ReactNode, data?: ExternalToast) => {
    return uiToast.warning(localizeMessage(message), data);
  },
  message: (message: string | React.ReactNode, data?: ExternalToast) => {
    return uiToast.message(localizeMessage(message), data);
  },
  // Pass through methods that don't take message strings
  promise: uiToast.promise,
  loading: uiToast.loading,
  custom: uiToast.custom,
  dismiss: uiToast.dismiss,
};