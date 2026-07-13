/**
 * Multi-host session tree — public API.
 *
 * This module provides the MultiHostSessionTree component and its
 * supporting sub-components for displaying sessions across multiple
 * OpenChamber hosts.
 */

export { MultiHostSessionTree } from './MultiHostSessionTree';
export type { MultiHostSessionTreeProps } from './MultiHostSessionTree';

export { HostConnectionIndicator } from './HostConnectionIndicator';
export { HostStatusBadge } from './HostStatusBadge';
export { HostSessionNode } from './HostSessionNode';
export { HostProjectNode } from './HostProjectNode';
export { HostNode } from './HostNode';
export { MultiHostEmptyState } from './MultiHostEmptyState';

export type {
  DerivedSessionStatus,
  SessionExtraStatus,
  HostSummary,
  ProjectGroup,
  ProjectSession,
} from './multi-host-sidebar-types';

export {
  deriveSessionStatus,
  transportKindLabel,
  connectionStateLabel,
  transportIconName,
  hostFoldKey,
  projectFoldKey,
  FOLD_KEY_PREFIX_HOST,
  FOLD_KEY_PREFIX_PROJECT,
} from './multi-host-sidebar-types';
