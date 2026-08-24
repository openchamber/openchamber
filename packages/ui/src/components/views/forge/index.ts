/**
 * Shared rich-view sections for forge pull requests and issues.
 *
 * Every component in this directory is presentational — all data arrives via
 * props. `ForgeEntityDetailView` is the one self-loading orchestrator that owns
 * fetching through the `ForgeProvider` facade and composes the sections.
 */
export { ForgeMetadataChips } from './ForgeMetadataChips';
export { ForgeCommitsSection } from './ForgeCommitsSection';
export { ForgeFilesDiffSection } from './ForgeFilesDiffSection';
export { ForgeEntityDetailView } from './ForgeEntityDetailView';
