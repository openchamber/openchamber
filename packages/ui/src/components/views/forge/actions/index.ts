/**
 * Write-action UI for forge issues and pull requests.
 *
 * Every component is capability- and method-gated: it renders nothing (or a
 * sub-affordance) unless the provider implements the underlying write method
 * and its capability flag is set. Components call the facade directly, toast
 * stable i18n messages on failure (never raw error text), and report success
 * through `onChanged`/`onPosted` callbacks so the owning view can refetch or
 * update local state.
 */
export { ForgeCommentComposer } from './ForgeCommentComposer';
export { ForgeThreadReply } from './ForgeThreadReply';
export { ForgeStateActions } from './ForgeStateActions';
export { ForgeReviewActions } from './ForgeReviewActions';
export { ForgeDraftToggle } from './ForgeDraftToggle';
export { ForgeMetadataEditor } from './ForgeMetadataEditor';
export { ForgeEditForm } from './ForgeEditForm';
export { ForgeEntityActions } from './ForgeEntityActions';
