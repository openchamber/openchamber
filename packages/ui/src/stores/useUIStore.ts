import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { UIStore } from './ui/types';
import { contextWindowPersistOptions } from './ui/persistence';
import { withContextWindowRouting } from '@/lib/contextWindow/routing';
import { createInitialUIState } from './ui/initialState';
import { createAppearanceActions } from './ui/appearanceActions';
import { createWorkspaceActions } from './ui/workspaceActions';
import { createContextTabActions } from './ui/contextTabActions';
import { createNavigationActions } from './ui/navigationActions';
import { createPreferenceActions } from './ui/preferenceActions';
import { createModelActions } from './ui/modelActions';
import { createNotificationActions } from './ui/notificationActions';
import { createAgentActions } from './ui/agentActions';

export type { PendingDiffScope } from './ui/types';
export { clampContextEditorTreeWidth } from './ui/preferences';
export type { SessionRetentionAction } from './ui/types';
export type { TimeFormatPreference } from './ui/types';
export type { MobileKeepScreenAwake } from './ui/types';
export type { FileEditorKeymap } from './ui/types';
export type { DocumentAttachBehavior, LargeTextPasteBehavior } from './ui/types';
export type { ChatWidth } from './ui/types';
export type { SessionGoalChecker } from './ui/types';
export { normalizeContextPanelDirectoryKey } from './ui/contextTabs';
export { isTrackerBranchTab } from './ui/contextTabs';
export { resolveContextZoneReturnTarget } from './ui/contextPanelState';
export { DEFAULT_SELECTION_APPROVAL_TEXT } from './ui/preferences';
export { DEFAULT_EDITOR_FONT_SIZE } from './ui/preferences';
export { DEFAULT_CONTEXT_EDITOR_TREE_WIDTH } from './ui/preferences';
export type { ContextPanelMode } from '@/lib/surfaces/modes';

export const useUIStore = create<UIStore>()(
  devtools(
    persist(
      (set, get, store) => withContextWindowRouting({
        ...createInitialUIState(),
        ...createAppearanceActions(set, get, store),
        ...createWorkspaceActions(set, get, store),
        ...createContextTabActions(set, get, store),
        ...createNavigationActions(set, get, store),
        ...createPreferenceActions(set, get, store),
        ...createModelActions(set, get, store),
        ...createNotificationActions(set, get, store),
        ...createAgentActions(set, get, store),
      }),
      contextWindowPersistOptions(),
    ),
    { name: 'ui-store' },
  ),
);
