import { z } from 'zod';
import { createRequire } from 'node:module';

import { isOverviewFeatureAvailable } from '../overview/feature-flag.js';
import { isPermissionMode } from '../permission-auto-accept/modes.js';
import type { PermissionMode } from '../permission-auto-accept/modes.js';
import { asNonEmptyString } from '../shared/guards.js';
import { isBoolean, isString } from '../shared/object-guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import type { normalizeTunnelProvider, normalizeTunnelMode, normalizeOptionalPath } from '../tunnels/types.js';
import { idleStopSchema } from '../spaces/idle-stop.js';
import { sshHostSchema } from '../spaces/places/ssh-host.js';
import { PROVIDER_LOGO_MIMES } from '../appearance/provider-logo-routes.js';

const settingsDocumentSchema = z.looseObject({});
export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;
const hasSettingsFields = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isSetMember = (values: ReadonlySet<string>, value: unknown): value is string => isString(value) && values.has(value);
const hasIdleStopSetting = (value: unknown): value is z.infer<typeof idleStopSchema> => idleStopSchema.safeParse(value).success;
type UsageModelGroupInput = {
  customGroups?: unknown;
  modelAssignments?: unknown;
  renamedGroups?: unknown;
};
type UsageGroupInput = {
  id?: unknown;
  label?: unknown;
  models?: unknown;
  order?: unknown;
};
const hasUsageGroupFields = (value: unknown): value is UsageGroupInput => Boolean(value);
const hasUsageModelGroupFields = (value: unknown): value is UsageModelGroupInput => value != null;
const hasUsageGroupLabels = (value: unknown): value is { id: string; label: string; models?: unknown; order?: unknown } => {
  if (!hasUsageGroupFields(value)) return false;
  return isString(value.id) && isString(value.label);
};

interface RegistryField {
  computed?: boolean;
  local?: boolean;
  owner?: string;
  secret?: boolean;
}
const settingsRegistry: { fields: Record<string, RegistryField> } = createRequire(import.meta.url)('./settings-registry.json');

type Normalization = ReturnType<typeof createSettingsNormalizationRuntime>;
export type SettingsHelpersDependencies = Pick<Normalization,
  'normalizePathForPersistence' | 'normalizeDirectoryPath' | 'normalizeTunnelBootstrapTtlMs'
  | 'normalizeTunnelSessionTtlMs' | 'normalizeManagedRemoteTunnelHostname'
  | 'normalizeManagedRemoteTunnelPresets' | 'normalizeManagedRemoteTunnelPresetTokens'
  | 'normalizeStringArray' | 'sanitizeModelRefs' | 'sanitizeSkillCatalogs' | 'sanitizeProjects'
> & {
  normalizeTunnelProvider: typeof normalizeTunnelProvider;
  normalizeTunnelMode: typeof normalizeTunnelMode;
  normalizeOptionalPath: typeof normalizeOptionalPath;
};

const SIDEBAR_BUILTIN_SECTION_IDS = ['pages', 'chats', 'pinned', 'work', 'projects'];
const SIDEBAR_SECTIONS_STORED_MAX = 24 + SIDEBAR_BUILTIN_SECTION_IDS.length;
const sidebarSectionIdSchema = z.string().trim().min(1).max(64);
const sidebarSectionNameSchema = z.string().trim().min(1).transform((value) => value.slice(0, 60));
const sidebarChips = (values: string[]) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = z.enum(values).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
const sidebarIdList = (schema: z.ZodString) => z.array(z.unknown()).transform((entries) => (
  [...new Set(entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }))]
));
const sidebarIds = sidebarIdList(sidebarSectionIdSchema);
const sidebarProjectIds = sidebarIdList(z.string().trim().min(1).max(4096));
const sidebarSectionSchema = z.union([
  z.object({ kind: z.literal('builtin'), id: z.enum(SIDEBAR_BUILTIN_SECTION_IDS) }),
  z.object({
    kind: z.literal('custom'),
    id: sidebarSectionIdSchema,
    name: sidebarSectionNameSchema,
    grouping: z.enum(['time', 'project']).catch('time'),
    filter: z.object({
      states: sidebarChips(['running', 'needs-answer', 'unread', 'failed', 'looks-done']).catch([]),
      work: sidebarChips(['in-work', 'done']).catch([]),
      pins: sidebarIds.catch([]),
      kinds: sidebarChips(['session', 'worktree', 'space', 'run', 'scheduled']).catch([]),
      links: sidebarChips(['pr', 'issue', 'tracker', 'plan', 'goal']).catch([]),
      projectIds: sidebarProjectIds.catch([]),
      folders: sidebarIds.catch([]),
      activity: z.enum(['any', 'today', 'two-days', 'week', 'stalled']).catch('any'),
      text: z.union([z.string().transform((value) => [value]), z.array(z.unknown())]).transform((entries) => (
        [...new Set(entries.flatMap((entry) => {
          const phrase = z.string().trim().transform((value) => value.slice(0, 100)).safeParse(entry);
          return phrase.success && phrase.data ? [phrase.data] : [];
        }))].slice(0, 12)
      )).catch([]),
    }).partial().catch({}),
    claims: z.boolean().catch(false),
    hideWhenEmpty: z.boolean().catch(true),
  }),
]);

export type SidebarSection = z.infer<typeof sidebarSectionSchema>;

const sanitizeSidebarSections = (entries: readonly JsonValue[] | readonly unknown[]) => {
  const result: SidebarSection[] = [];
  const seen = new Set();
  for (const entry of entries) {
    const parsed = sidebarSectionSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= SIDEBAR_SECTIONS_STORED_MAX) continue;
    if (parsed.data.kind === 'custom' && SIDEBAR_BUILTIN_SECTION_IDS.includes(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

const keepOmittedBuiltinSections = (stored: SidebarSection[], incoming: SidebarSection[]) => {
  const result = [...incoming];
  const has = (id: string) => result.some((entry) => entry.id === id);
  stored.forEach((entry, index) => {
    if (entry?.kind !== 'builtin' || has(entry.id)) return;
    const previous = stored.slice(0, index).reverse().find((candidate) => has(candidate?.id));
    const at = previous ? result.findIndex((candidate) => candidate.id === previous.id) + 1 : 0;
    result.splice(at, 0, entry);
  });
  return result;
};

const sanitizeSidebarPinLists = (entries: readonly unknown[]) => {
  const result: { id: string; name: string }[] = [];
  const seen = new Set(['pinned']);
  for (const entry of entries) {
    const parsed = z.object({ id: sidebarSectionIdSchema, name: sidebarSectionNameSchema }).safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id) || result.length >= 24) continue;
    seen.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
};

const isPersistableSettingsKey = (key: string) => {
  const field = settingsRegistry.fields[key];
  if (!field) return false;
  if (field.computed || field.local) return false;
  if (field.owner === 'desktop-shell') return false;
  return true;
};

const SECRET_SETTINGS_KEYS = Object.freeze(
  Object.entries(settingsRegistry.fields)
    .filter(([, field]) => field.secret === true)
    .map(([key]) => key),
);

import {
  DEFAULT_INPUT_HISTORY_LIMIT,
  DEFAULT_INPUT_HISTORY_SCOPE,
  isInputHistoryLimit,
  isInputHistoryScope,
} from './input-history-scope.js';

const AGENT_TOOL_BOOLEAN_KEYS = [
  'agentControlToolEnabled', 'agentScheduleToolEnabled', 'agentMemoryToolEnabled', 'agentMemoryDreamingEnabled',
  'agentKnowledgeToolEnabled', 'agentWorkflowToolEnabled', 'agentWorkflowAutoApprove', 'agentNotifyToolEnabled',
  'agentRenderToolEnabled', 'agentImageToolEnabled', 'agentSecretToolEnabled', 'agentUsageToolEnabled', 'agentTerminalToolEnabled',
] as const;

const dreamingModelSchema = z.string().trim().refine((value) => value === '' || /^[^/\s]+\/\S+$/.test(value));

const customProviderIconsSchema = z.record(
  z.string().trim().min(1).max(128),
  z.enum(['server', 'cloud', 'database', 'terminal', 'code', 'ai']),
);
const CUSTOM_PROVIDER_ICONS_MAX = 256;
const lastSelectedModelSchema = z.string().trim().min(1).max(512);

const sanitizeCustomProviderIcons = (value: SettingsDocument[string]) => {
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) return undefined;
  const result: z.infer<typeof customProviderIconsSchema> = {};
  for (const [providerID, icon] of Object.entries(record.data).slice(0, CUSTOM_PROVIDER_ICONS_MAX)) {
    const entry = customProviderIconsSchema.safeParse({ [providerID]: icon });
    if (entry.success) Object.assign(result, entry.data);
  }
  return result;
};

const customProviderLogosSchema = z.record(
  z.string().trim().min(1).max(128),
  z.object({
    mime: z.enum(PROVIDER_LOGO_MIMES),
    updatedAt: z.number().int().positive(),
  }),
);

const sanitizeCustomProviderLogos = (value: SettingsDocument[string]) => {
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) return undefined;
  const result: z.infer<typeof customProviderLogosSchema> = {};
  for (const [providerID, logo] of Object.entries(record.data).slice(0, CUSTOM_PROVIDER_ICONS_MAX)) {
    const entry = customProviderLogosSchema.safeParse({ [providerID]: logo });
    if (entry.success) Object.assign(result, entry.data);
  }
  return result;
};

type BooleanSettingsKey =
  | 'useSystemTheme' | 'workStatusPanelEnabled' | 'workStatusHiddenSectionsExplicit' | 'workStatusSectionOrderExplicit'
  | 'desktopLanAccessEnabled' | 'desktopKeepAwakeEnabled' | 'desktopMinimizeToTrayEnabled' | 'desktopMacMenuBarEnabled'
  | 'desktopLinuxNativeFrame' | 'messageSearchEnabled' | 'messageSearchReasoningEnabled'
  | 'sidebarKeepWorkInPlace' | 'sidebarKeepPinnedInPlace' | 'sidebarShowChatsSection' | 'sidebarShowWorkSection'
  | 'sidebarShowPinnedSection' | 'sidebarDetailedZoneRows' | 'sidebarWorktreeNameByBranch'
  | 'draftStartersVisible' | 'draftStartersCraftGoalAdded' | 'draftStartersScheduleTaskAdded'
  | 'showReasoningTraces' | 'streamingAutoFollowEnabled' | 'expandReasoningWhileStreaming'
  | 'codeBlockLineWrap' | 'tableCellWrap' | 'copyMessagesAsPlainText' | 'autoSaveEnabled' | 'fileEditorWrapLines'
  | 'confirmFileTreeMove' | 'layoutAnimations' | 'openLinksInBrowserPanel' | 'agentBrowserSharesLogins'
  | 'openTrackerLinksOnBoard' | 'diffWrapLines' | 'diffHideWhitespace' | 'allowPromptingSubagentSessions'
  | 'savePastedImagesAsFiles' | 'showOpenCodeRestartConfirm' | 'sessionTabsEnabled' | 'sessionTabsPerWorkspace'
  | 'terminalCloseOnExit' | 'terminalOpenOnProjectAction' | 'sessionRecapEnabled' | 'sessionSuggestionEnabled'
  | 'sessionWorkEnabled' | 'sessionReviewOfferEnabled' | 'sessionGoalEnabled' | 'sessionGoalDefaultBudgetEnabled'
  | 'collapsibleThinkingBlocks' | 'showTextJustificationActivity' | 'showDeletionDialog' | 'nativeNotificationsEnabled'
  | 'notifyOnSubtasks' | 'notifyOnCompletion' | 'notifyOnPullRequests' | 'notifyOnError' | 'notifyOnQuestion'
  | 'summarizeLastMessage' | 'autoDeleteEnabled' | 'sessionRetentionOnlyArchived' | 'sessionRetentionIncludeInWork'
  | 'mergedWorktreeCleanupEnabled' | 'worktreeArchiveOnDoneEnabled' | 'smallModelUseDefault' | 'autoCreateWorktree'
  | 'gitmojiEnabled' | 'defaultFileViewerPreview' | 'inputSpellcheckEnabled' | 'enterToSend' | 'enterToSendConfigured'
  | 'mobileReturnKeySends' | 'showOpenCodeUpdateNotifications' | 'agentWebToolEnabled' | 'isolatedSpacesEnabled'
  | 'showToolFileIcons' | 'showTurnChangedFiles' | 'collapsibleUserMessages' | 'stickyUserHeader'
  | 'promptNavigatorEnabled' | 'wideChatLayoutEnabled' | 'showSplitAssistantMessageActions' | 'directoryShowHidden'
  | 'filesViewShowGitignored' | 'reportUsage' | 'responseStyleEnabled' | 'dictationEnabled' | 'dictationAutoSend'
  | 'sttCorrectTranscript' | (typeof AGENT_TOOL_BOOLEAN_KEYS)[number];

type StringSettingsKey =
  | 'themeId' | 'locale' | 'lightThemeId' | 'darkThemeId' | 'splashBgLight' | 'splashFgLight' | 'splashBgDark'
  | 'splashFgDark' | 'lastDirectory' | 'homeDirectory' | 'opencodeBinary' | 'desktopUiPassword' | 'activeProjectId'
  | 'uiFont' | 'monoFont' | 'customUiFont' | 'customMonoFont' | 'uiFontWeight' | 'githubClientId' | 'githubScopes'
  | 'gitlabClientId' | 'fileEditorVimMappings' | 'tunnelProvider' | 'tunnelMode' | 'lastSelectedModel'
  | 'pwaAppName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'browserProvider' | 'agentMemoryDreamingModel'
  | 'agentMemoryDreamingVariant' | 'agentImageModel' | 'isolatedSpacesSshHost' | 'openCodeUpdateToastDismissedVersion'
  | 'terminalShell' | 'openInAppId' | 'globalBehaviorPrompt' | 'responseStylePreset' | 'responseStyleCustomInstructions'
  | 'sttServerUrl' | 'sttModel' | 'sttEndpointPath' | 'sttLocalModel' | 'sttLanguage' | 'sidebarProjectDisplayMode'
  | 'sidebarViewMode' | 'sidebarListSessionGrouping' | 'sidebarGrouping' | 'sidebarProjectSortOrder'
  | 'selectionApprovalText';

type ClearableStringSettingsKey =
  | 'managedRemoteTunnelHostname' | 'managedRemoteTunnelSelectedPresetId' | 'defaultModel' | 'defaultVariant'
  | 'defaultAgent' | 'smallModelOverride' | 'smallModelVariant' | 'walkthroughModelOverride' | 'walkthroughModelVariant'
  | 'fallbackModel' | 'fallbackVariant' | 'defaultGitIdentityId' | 'zenModel';

type NumberSettingsKey =
  | 'inputHistoryLimit' | 'sidebarSessionBatchSize' | 'liveBrowserTabLimit' | 'sessionGoalMaxAutoTurns'
  | 'sessionGoalDefaultBudget' | 'summaryThreshold' | 'summaryLength' | 'maxLastMessageLength' | 'autoDeleteAfterDays'
  | 'tunnelSessionTtlMs' | 'tunnelHttpsPort' | 'fontSize' | 'chatFontSize' | 'terminalFontSize' | 'editorFontSize'
  | 'padding' | 'cornerRadius' | 'inputBarOffset';

type StringArraySettingsKey =
  | 'workStatusHiddenSections' | 'workStatusSectionOrder' | 'sidebarHiddenSections' | 'securityScopedBookmarks'
  | 'pinnedDirectories' | 'providerOrder' | 'usageDropdownProviders' | 'accountSwitchProviders'
  | 'terminalLoginShells' | 'collapsedModelProviders' | 'recentAgents' | 'favoriteAgents';

export interface UsageModelGroups {
  customGroups?: { id: string; label: string; models: string[]; order: number }[];
  modelAssignments?: Record<string, string>;
  renamedGroups?: Record<string, string>;
}

interface AppNameFields {
  pwaAppName?: string;
}

interface DesktopSettingsFields {
  desktopLanAccessActive?: boolean;
  desktopLanAccessBlockedReason?: 'missing-password' | 'enterprise-mode' | null;
}

export type SanitizedSettings = Partial<Record<BooleanSettingsKey, boolean>>
  & Partial<Record<StringSettingsKey, string>>
  & Partial<Record<ClearableStringSettingsKey, string | undefined>>
  & Partial<Record<NumberSettingsKey, number>>
  & Partial<Record<StringArraySettingsKey, string[]>>
  & {
    themeVariant?: 'light' | 'dark';
    inputHistoryScope?: 'session' | 'global';
    desktopUpdateChannel?: 'stable' | 'canary';
    serverUpdateChannel?: 'stable' | 'canary';
    desktopWindowControlsPosition?: 'left' | 'right';
    desktopWindowControlsStyle?: 'classic' | 'traffic-lights';
    permissionAutoAccept?: { sessions: Record<string, PermissionMode | boolean>; revision: number };
    permissionDefaultMode?: PermissionMode;
    projects?: NonNullable<ReturnType<Normalization['sanitizeProjects']>>;
    sidebarSections?: SidebarSection[];
    sidebarPinLists?: { id: string; name: string }[];
    draftStarters?: { type: 'command' | 'skill'; name: string }[];
    fileTreeSide?: 'left' | 'right';
    largeTextPasteBehavior?: 'ask' | 'attach' | 'inline' | 'inline-double-paste';
    fileEditorKeymap?: 'default' | 'vim';
    sessionGoalChecker?: 'classifier' | 'small-model';
    notificationMode?: 'always' | 'hidden-only';
    notificationTemplates?: object;
    usageDisplayMode?: 'usage' | 'remaining';
    sessionRetentionAction?: 'archive' | 'delete';
    tunnelBootstrapTtlMs?: number | null;
    managedLocalTunnelConfigPath?: string | null | undefined;
    managedRemoteTunnelToken?: string | null;
    managedRemoteTunnelPresets?: NonNullable<ReturnType<Normalization['normalizeManagedRemoteTunnelPresets']>>;
    managedRemoteTunnelPresetTokens?: NonNullable<ReturnType<Normalization['normalizeManagedRemoteTunnelPresetTokens']>>;
    followUpBehavior?: 'steer' | 'queue';
    isolatedSpacesIdleStop?: z.infer<typeof idleStopSchema>;
    timeFormatPreference?: 'auto' | '12h' | '24h';
    weekStartPreference?: 'auto' | 'sunday' | 'monday';
    chatRenderMode?: 'sorted' | 'live';
    messageStreamTransport?: 'auto' | 'ws' | 'sse';
    activityRenderMode?: 'collapsed' | 'summary';
    mermaidRenderingMode?: 'svg' | 'ascii';
    userMessageRenderingMode?: 'markdown' | 'plain';
    chatWidth?: 'default' | 'wider' | 'full';
    shortcutOverrides?: Record<string, string>;
    favoriteModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    recentModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    hiddenModels?: NonNullable<ReturnType<Normalization['sanitizeModelRefs']>>;
    customProviderIcons?: z.infer<typeof customProviderIconsSchema>;
    customProviderLogos?: z.infer<typeof customProviderLogosSchema>;
    recentEfforts?: Record<string, string[]>;
    lastUsedEfforts?: Record<string, string | null>;
    diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
    gitChangesViewMode?: 'flat' | 'tree';
    toolJsonViewMode?: 'summary' | 'formatted' | 'raw';
    skillCatalogs?: NonNullable<ReturnType<Normalization['sanitizeSkillCatalogs']>>;
    usageSelectedModels?: Record<string, string[]>;
    usageCollapsedFamilies?: Record<string, string[]>;
    usageExpandedFamilies?: Record<string, string[]>;
    usageModelGroups?: Record<string, UsageModelGroups>;
    sttProvider?: 'local' | 'openai-compatible';
  };

export const isMessageSearchEnabled = (settings: SettingsDocument | null | undefined) => settings?.messageSearchEnabled !== false;

export const createSettingsHelpers = (dependencies: SettingsHelpersDependencies) => {
  const {
    normalizePathForPersistence,
    normalizeDirectoryPath,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  } = dependencies;

  const PWA_APP_NAME_MAX_LENGTH = 64;
  const STT_SERVER_URL_MAX_LENGTH = 2048;
  const STT_ENDPOINT_PATH_MAX_LENGTH = 1024;
  const STT_MODEL_MAX_LENGTH = 256;
  const STT_LANGUAGE_MAX_LENGTH = 64;
  const VERSION_STRING_MAX_LENGTH = 128;
  const SHORTCUT_OVERRIDE_KEY_MAX_LENGTH = 128;
  const SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH = 128;
  const PWA_ORIENTATION_VALUES = new Set(['system', 'portrait', 'landscape']);
  const MOBILE_KEYBOARD_MODE_VALUES = new Set(['native', 'resize-content']);
  const UI_FONT_WEIGHT_VALUES = new Set(['regular', 'balanced', 'strong']);
  const TERMINAL_SHELL_VALUES = new Set(['auto', 'bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu']);
  const SIDEBAR_PROJECT_DISPLAY_MODE_VALUES = new Set(['all', 'single']);
  const SIDEBAR_VIEW_MODE_VALUES = new Set(['projects', 'timeline']);
  const SIDEBAR_LIST_SESSION_GROUPING_VALUES = new Set(['project', 'time']);
  const UI_LOCALE_VALUES = new Set(['en', 'de', 'fr', 'nl', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr', 'ar', 'he']);
  const SIDEBAR_PROJECT_SORT_ORDER_VALUES = new Set(['manual', 'a-z', 'z-a', 'date-added', 'recent']);
  const HIDDEN_MODELS_MAX = 1024;
  const RECENT_EFFORTS_MAX_KEYS = 128;
  const RECENT_EFFORTS_MAX_VARIANTS_PER_KEY = 5;
  const LAST_USED_EFFORTS_MAX_KEYS = 512;
  const lastUsedEffortsSchema = z.record(z.string(), z.string().trim().min(1).nullable().catch(undefined));

  const sanitizeShortcutOverrides = (value: SettingsDocument[string]) => {
    if (!hasSettingsFields(value) || Array.isArray(value)) {
      return null;
    }
    const result: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = rawKey.trim();
      const combo = isString(rawValue) ? rawValue.trim() : '';
      if (!key || !combo) continue;
      result[key.slice(0, SHORTCUT_OVERRIDE_KEY_MAX_LENGTH)] = combo.slice(0, SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH);
    }
    return result;
  };

  const sanitizeRecentEfforts = (value: SettingsDocument[string]) => {
    if (!hasSettingsFields(value) || Array.isArray(value)) {
      return null;
    }
    const result: Record<string, string[]> = {};
    const seenKeys = new Set();
    let count = 0;
    for (const [rawKey, rawVariants] of Object.entries(value)) {
      const key = rawKey.trim();
      if (!key || seenKeys.has(key)) continue;
      if (!Array.isArray(rawVariants)) continue;
      const variants = [];
      const seenVariants = new Set();
      for (const rawVariant of rawVariants) {
        const variant = isString(rawVariant) ? rawVariant.trim() : '';
        if (!variant || seenVariants.has(variant)) continue;
        seenVariants.add(variant);
        variants.push(variant);
        if (variants.length >= RECENT_EFFORTS_MAX_VARIANTS_PER_KEY) break;
      }
      if (variants.length === 0) continue;
      seenKeys.add(key);
      result[key] = variants;
      count += 1;
      if (count >= RECENT_EFFORTS_MAX_KEYS) break;
    }
    return count > 0 ? result : null;
  };

  const sanitizeLastUsedEfforts = (value: SettingsDocument[string]) => {
    const parsed = lastUsedEffortsSchema.safeParse(value);
    if (!parsed.success) return null;
    const result: Record<string, string | null> = {};
    const seenKeys = new Set();
    let count = 0;
    for (const [rawKey, effort] of Object.entries(parsed.data)) {
      const key = rawKey.trim();
      if (!key || seenKeys.has(key)) continue;
      if (effort === undefined) continue;
      seenKeys.add(key);
      result[key] = effort;
      count += 1;
      if (count >= LAST_USED_EFFORTS_MAX_KEYS) break;
    }
    return count > 0 ? result : null;
  };

  const normalizePwaAppName = (value: SettingsDocument[string], fallback = '') => {
    if (!isString(value)) {
      return fallback;
    }
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, PWA_APP_NAME_MAX_LENGTH);
  };

  const normalizePwaOrientation = (value: SettingsDocument[string], fallback = 'system') => {
    if (!isString(value)) {
      return fallback;
    }
    const normalized = value.trim();
    if (PWA_ORIENTATION_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const normalizeMobileKeyboardMode = (value: SettingsDocument[string], fallback: string | null = 'native') => {
    if (!isString(value)) {
      return fallback;
    }
    const normalized = value.trim();
    if (MOBILE_KEYBOARD_MODE_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const normalizeFollowUpBehavior = (value: SettingsDocument[string], legacyQueueModeEnabled: boolean | null = null) => {
    if (value === 'immediate') {
      return 'steer';
    }
    if (value === 'steer' || value === 'queue') {
      return value;
    }
    if (legacyQueueModeEnabled === false) {
      return 'steer';
    }
    return 'queue';
  };

  const sanitizeSettingsUpdate = (payload: JsonValue | SettingsDocument | undefined): SanitizedSettings => {
    if (!hasSettingsFields(payload)) {
      return {};
    }

    const candidate = payload;
    const result: SanitizedSettings = {};

    if (isString(candidate.themeId) && candidate.themeId.length > 0) {
      result.themeId = candidate.themeId;
    }
    if (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark') {
      result.themeVariant = candidate.themeVariant;
    }
    if (isInputHistoryScope(candidate.inputHistoryScope)) {
      result.inputHistoryScope = candidate.inputHistoryScope;
    }
    if (isInputHistoryLimit(candidate.inputHistoryLimit)) {
      result.inputHistoryLimit = candidate.inputHistoryLimit;
    }
    if (isSetMember(UI_LOCALE_VALUES, candidate.locale)) {
      result.locale = candidate.locale;
    }
    if (isBoolean(candidate.useSystemTheme)) {
      result.useSystemTheme = candidate.useSystemTheme;
    }
    if (isString(candidate.lightThemeId) && candidate.lightThemeId.length > 0) {
      result.lightThemeId = candidate.lightThemeId;
    }
    if (isString(candidate.darkThemeId) && candidate.darkThemeId.length > 0) {
      result.darkThemeId = candidate.darkThemeId;
    }
    if (isString(candidate.splashBgLight) && candidate.splashBgLight.trim().length > 0) {
      result.splashBgLight = candidate.splashBgLight.trim();
    }
    if (isString(candidate.splashFgLight) && candidate.splashFgLight.trim().length > 0) {
      result.splashFgLight = candidate.splashFgLight.trim();
    }
    if (isString(candidate.splashBgDark) && candidate.splashBgDark.trim().length > 0) {
      result.splashBgDark = candidate.splashBgDark.trim();
    }
    if (isString(candidate.splashFgDark) && candidate.splashFgDark.trim().length > 0) {
      result.splashFgDark = candidate.splashFgDark.trim();
    }
    if (candidate.lastDirectory === '') {
      result.lastDirectory = '';
    } else if (isString(candidate.lastDirectory)) {
      const normalized = normalizePathForPersistence(candidate.lastDirectory);
      if (normalized.length > 0) {
        result.lastDirectory = normalized;
      }
    }
    if (isString(candidate.homeDirectory) && candidate.homeDirectory.length > 0) {
      const normalized = normalizePathForPersistence(candidate.homeDirectory);
      if (normalized.length > 0) {
        result.homeDirectory = normalized;
      }
    }

    if (isString(candidate.opencodeBinary)) {
      const normalized = normalizeDirectoryPath(candidate.opencodeBinary).trim();
      result.opencodeBinary = normalized;
    }
    if (isBoolean(candidate.workStatusPanelEnabled)) {
      result.workStatusPanelEnabled = candidate.workStatusPanelEnabled;
    }
    if (Array.isArray(candidate.workStatusHiddenSections)) {
      result.workStatusHiddenSections = [
        ...new Set(candidate.workStatusHiddenSections.filter((entry) => isString(entry) && entry.length > 0)),
      ];
    }
    for (const key of ['workStatusHiddenSectionsExplicit', 'workStatusSectionOrderExplicit'] as const) {
      if (isBoolean(candidate[key])) result[key] = candidate[key];
    }
    if (Array.isArray(candidate.workStatusSectionOrder)) {
      result.workStatusSectionOrder = [
        ...new Set(candidate.workStatusSectionOrder.filter((entry) => isString(entry) && entry.length > 0)),
      ];
    }
    if (isBoolean(candidate.desktopLanAccessEnabled)) {
      result.desktopLanAccessEnabled = candidate.desktopLanAccessEnabled;
    }
    if (isBoolean(candidate.desktopKeepAwakeEnabled)) {
      result.desktopKeepAwakeEnabled = candidate.desktopKeepAwakeEnabled;
    }
    if (isBoolean(candidate.desktopMinimizeToTrayEnabled)) {
      result.desktopMinimizeToTrayEnabled = candidate.desktopMinimizeToTrayEnabled;
    }
    if (candidate.desktopUpdateChannel === 'stable' || candidate.desktopUpdateChannel === 'canary') {
      result.desktopUpdateChannel = candidate.desktopUpdateChannel;
    }
    if (candidate.serverUpdateChannel === 'stable' || candidate.serverUpdateChannel === 'canary') {
      result.serverUpdateChannel = candidate.serverUpdateChannel;
    }
    if (isBoolean(candidate.desktopMacMenuBarEnabled)) {
      result.desktopMacMenuBarEnabled = candidate.desktopMacMenuBarEnabled;
    }
    if (isBoolean(candidate.desktopLinuxNativeFrame)) {
      result.desktopLinuxNativeFrame = candidate.desktopLinuxNativeFrame;
    }
    if (isString(candidate.desktopWindowControlsPosition)) {
      const mode = candidate.desktopWindowControlsPosition.trim();
      if (mode === 'auto' || mode === 'right') {
        result.desktopWindowControlsPosition = 'right';
      } else if (mode === 'left') {
        result.desktopWindowControlsPosition = 'left';
      }
    }
    if (isString(candidate.desktopWindowControlsStyle)) {
      const style = candidate.desktopWindowControlsStyle.trim();
      if (style === 'classic' || style === 'traffic-lights') {
        result.desktopWindowControlsStyle = style;
      }
    }
    if (hasSettingsFields(candidate.permissionAutoAccept) && !Array.isArray(candidate.permissionAutoAccept)) {
      const sessions: Record<string, boolean | PermissionMode> = {};
      const sourceSessions = candidate.permissionAutoAccept.sessions;
      if (hasSettingsFields(sourceSessions) && !Array.isArray(sourceSessions)) {
        for (const [sessionId, mode] of Object.entries(sourceSessions)) {
          if (sessionId && (isBoolean(mode) || isPermissionMode(mode))) sessions[sessionId] = mode;
        }
      }
      result.permissionAutoAccept = {
        sessions,
        revision: isSafeInteger(candidate.permissionAutoAccept.revision)
          && candidate.permissionAutoAccept.revision >= 0
          ? candidate.permissionAutoAccept.revision
          : 0,
      };
    }
    if (isPermissionMode(candidate.permissionDefaultMode)) {
      result.permissionDefaultMode = candidate.permissionDefaultMode;
    }
    if (isBoolean(candidate.messageSearchEnabled)) {
      result.messageSearchEnabled = candidate.messageSearchEnabled;
    }
    if (isBoolean(candidate.messageSearchReasoningEnabled)) {
      result.messageSearchReasoningEnabled = candidate.messageSearchReasoningEnabled;
    }
    if (isString(candidate.desktopUiPassword)) {
      result.desktopUiPassword = candidate.desktopUiPassword.trim();
    }
    if (Array.isArray(candidate.projects)) {
      const projects = sanitizeProjects(candidate.projects);
      if (projects) {
        result.projects = projects;
      }
    }
    if (isString(candidate.activeProjectId) && candidate.activeProjectId.length > 0) {
      result.activeProjectId = candidate.activeProjectId;
    }
    if (isSetMember(SIDEBAR_PROJECT_DISPLAY_MODE_VALUES, candidate.sidebarProjectDisplayMode)) {
      result.sidebarProjectDisplayMode = candidate.sidebarProjectDisplayMode;
    }
    if (isSetMember(SIDEBAR_VIEW_MODE_VALUES, candidate.sidebarViewMode)) {
      result.sidebarViewMode = candidate.sidebarViewMode;
    }
    if (isSetMember(SIDEBAR_LIST_SESSION_GROUPING_VALUES, candidate.sidebarListSessionGrouping)) {
      result.sidebarListSessionGrouping = candidate.sidebarListSessionGrouping;
    }
    if (isSetMember(SIDEBAR_LIST_SESSION_GROUPING_VALUES, candidate.sidebarGrouping)) {
      result.sidebarGrouping = candidate.sidebarGrouping;
    }
    if (isBoolean(candidate.sidebarKeepWorkInPlace)) {
      result.sidebarKeepWorkInPlace = candidate.sidebarKeepWorkInPlace;
    }
    if (isBoolean(candidate.sidebarKeepPinnedInPlace)) {
      result.sidebarKeepPinnedInPlace = candidate.sidebarKeepPinnedInPlace;
    }
    if (isFiniteNumber(candidate.sidebarSessionBatchSize)) {
      result.sidebarSessionBatchSize = Math.max(3, Math.min(50, Math.round(candidate.sidebarSessionBatchSize)));
    }
    if (isSetMember(SIDEBAR_PROJECT_SORT_ORDER_VALUES, candidate.sidebarProjectSortOrder)) {
      result.sidebarProjectSortOrder = candidate.sidebarProjectSortOrder;
    }
    if (isBoolean(candidate.sidebarShowChatsSection)) {
      result.sidebarShowChatsSection = candidate.sidebarShowChatsSection;
    }
    if (isBoolean(candidate.sidebarShowWorkSection)) {
      result.sidebarShowWorkSection = candidate.sidebarShowWorkSection;
    }
    if (candidate.sidebarShowPinnedSection === true || candidate.sidebarShowPinnedSection === false) {
      result.sidebarShowPinnedSection = candidate.sidebarShowPinnedSection;
    }
    if (candidate.sidebarDetailedZoneRows === true || candidate.sidebarDetailedZoneRows === false) {
      result.sidebarDetailedZoneRows = candidate.sidebarDetailedZoneRows;
    }
    if (candidate.sidebarWorktreeNameByBranch === true || candidate.sidebarWorktreeNameByBranch === false) {
      result.sidebarWorktreeNameByBranch = candidate.sidebarWorktreeNameByBranch;
    }
    if (Array.isArray(candidate.sidebarSections)) {
      result.sidebarSections = sanitizeSidebarSections(candidate.sidebarSections);
    }
    if (Array.isArray(candidate.sidebarPinLists)) {
      result.sidebarPinLists = sanitizeSidebarPinLists(candidate.sidebarPinLists);
    }
    if (Array.isArray(candidate.sidebarHiddenSections)) {
      result.sidebarHiddenSections = [...new Set(candidate.sidebarHiddenSections.flatMap((entry) => {
        const parsed = sidebarSectionIdSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }))];
    }

    if (Array.isArray(candidate.securityScopedBookmarks)) {
      result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
    }
    if (Array.isArray(candidate.pinnedDirectories)) {
      result.pinnedDirectories = normalizeStringArray(
        candidate.pinnedDirectories
          .map((entry) => (isString(entry) ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => isString(entry) && entry.length > 0)
      );
    }
    if (Array.isArray(candidate.draftStarters)) {
      const seenStarters = new Set();
      const starters: { type: 'command' | 'skill'; name: string }[] = [];
      for (const entry of candidate.draftStarters) {
        if (!hasSettingsFields(entry)) continue;
        const type = entry.type === 'command' || entry.type === 'skill' ? entry.type : null;
        const name = isString(entry.name) ? entry.name.trim() : '';
        if (!type || !name) continue;
        const key = `${type}:${name}`;
        if (seenStarters.has(key)) continue;
        seenStarters.add(key);
        starters.push({ type, name });
      }
      result.draftStarters = starters;
    }
    if (isBoolean(candidate.draftStartersVisible)) {
      result.draftStartersVisible = candidate.draftStartersVisible;
    }
    if (isBoolean(candidate.draftStartersCraftGoalAdded)) {
      result.draftStartersCraftGoalAdded = candidate.draftStartersCraftGoalAdded;
    }
    if (isBoolean(candidate.draftStartersScheduleTaskAdded)) {
      result.draftStartersScheduleTaskAdded = candidate.draftStartersScheduleTaskAdded;
    }


    if (isString(candidate.uiFont) && candidate.uiFont.length > 0) {
      result.uiFont = candidate.uiFont;
    }
    if (isString(candidate.monoFont) && candidate.monoFont.length > 0) {
      result.monoFont = candidate.monoFont;
    }
    if (isString(candidate.customUiFont)) {
      result.customUiFont = candidate.customUiFont.slice(0, 100);
    }
    if (isString(candidate.customMonoFont)) {
      result.customMonoFont = candidate.customMonoFont.slice(0, 100);
    }
    if (isSetMember(UI_FONT_WEIGHT_VALUES, candidate.uiFontWeight)) {
      result.uiFontWeight = candidate.uiFontWeight;
    }
    if (isString(candidate.githubClientId)) {
      const trimmed = candidate.githubClientId.trim();
      if (trimmed.length > 0) {
        result.githubClientId = trimmed;
      }
    }
    if (isString(candidate.githubScopes)) {
      const trimmed = candidate.githubScopes.trim();
      if (trimmed.length > 0) {
        result.githubScopes = trimmed;
      }
    }
    if (isString(candidate.gitlabClientId)) {
      const trimmed = candidate.gitlabClientId.trim();
      if (trimmed.length > 0) {
        result.gitlabClientId = trimmed;
      }
    }
    if (isBoolean(candidate.showReasoningTraces)) {
      result.showReasoningTraces = candidate.showReasoningTraces;
    }
    if (isBoolean(candidate.streamingAutoFollowEnabled)) {
      result.streamingAutoFollowEnabled = candidate.streamingAutoFollowEnabled;
    }
    if (isBoolean(candidate.expandReasoningWhileStreaming)) {
      result.expandReasoningWhileStreaming = candidate.expandReasoningWhileStreaming;
    }
    if (isBoolean(candidate.codeBlockLineWrap)) {
      result.codeBlockLineWrap = candidate.codeBlockLineWrap;
    }
    if (isBoolean(candidate.tableCellWrap)) {
      result.tableCellWrap = candidate.tableCellWrap;
    }
    const selectionApprovalText = z.string().transform((value) => value.slice(0, 1000)).safeParse(candidate.selectionApprovalText);
    if (selectionApprovalText.success) {
      result.selectionApprovalText = selectionApprovalText.data;
    }
    if (isBoolean(candidate.copyMessagesAsPlainText)) {
      result.copyMessagesAsPlainText = candidate.copyMessagesAsPlainText;
    }
    if (isBoolean(candidate.autoSaveEnabled)) {
      result.autoSaveEnabled = candidate.autoSaveEnabled;
    }
    if (candidate.fileEditorWrapLines === true || candidate.fileEditorWrapLines === false) {
      result.fileEditorWrapLines = candidate.fileEditorWrapLines;
    }
    if (candidate.confirmFileTreeMove === true || candidate.confirmFileTreeMove === false) {
      result.confirmFileTreeMove = candidate.confirmFileTreeMove;
    }
    if (candidate.layoutAnimations === true || candidate.layoutAnimations === false) {
      result.layoutAnimations = candidate.layoutAnimations;
    }
    if (candidate.openLinksInBrowserPanel === true || candidate.openLinksInBrowserPanel === false) {
      result.openLinksInBrowserPanel = candidate.openLinksInBrowserPanel;
    }
    if (candidate.agentBrowserSharesLogins === true || candidate.agentBrowserSharesLogins === false) {
      result.agentBrowserSharesLogins = candidate.agentBrowserSharesLogins;
    }
    if (isInteger(candidate.liveBrowserTabLimit) && candidate.liveBrowserTabLimit >= 1 && candidate.liveBrowserTabLimit <= 20) {
      result.liveBrowserTabLimit = candidate.liveBrowserTabLimit;
    }
    if (candidate.openTrackerLinksOnBoard === true || candidate.openTrackerLinksOnBoard === false) {
      result.openTrackerLinksOnBoard = candidate.openTrackerLinksOnBoard;
    }
    if (candidate.fileTreeSide === 'left' || candidate.fileTreeSide === 'right') {
      result.fileTreeSide = candidate.fileTreeSide;
    }
    if (isBoolean(candidate.diffWrapLines)) {
      result.diffWrapLines = candidate.diffWrapLines;
    }
    if (isBoolean(candidate.diffHideWhitespace)) {
      result.diffHideWhitespace = candidate.diffHideWhitespace;
    }
    if (isBoolean(candidate.allowPromptingSubagentSessions)) {
      result.allowPromptingSubagentSessions = candidate.allowPromptingSubagentSessions;
    }
    if (candidate.savePastedImagesAsFiles === true || candidate.savePastedImagesAsFiles === false) {
      result.savePastedImagesAsFiles = candidate.savePastedImagesAsFiles;
    }
    if (isBoolean(candidate.showOpenCodeRestartConfirm)) {
      result.showOpenCodeRestartConfirm = candidate.showOpenCodeRestartConfirm;
    }
    if (isBoolean(candidate.sessionTabsEnabled)) {
      result.sessionTabsEnabled = candidate.sessionTabsEnabled;
    }
    if (candidate.sessionTabsPerWorkspace === true || candidate.sessionTabsPerWorkspace === false) {
      result.sessionTabsPerWorkspace = candidate.sessionTabsPerWorkspace;
    }
    if (candidate.terminalCloseOnExit === true || candidate.terminalCloseOnExit === false) {
      result.terminalCloseOnExit = candidate.terminalCloseOnExit;
    }
    if (candidate.terminalOpenOnProjectAction === true || candidate.terminalOpenOnProjectAction === false) {
      result.terminalOpenOnProjectAction = candidate.terminalOpenOnProjectAction;
    }
    if (isString(candidate.largeTextPasteBehavior)) {
      const mode = candidate.largeTextPasteBehavior.trim();
      if (mode === 'ask' || mode === 'attach' || mode === 'inline' || mode === 'inline-double-paste') {
        result.largeTextPasteBehavior = mode;
      }
    }
    if (isString(candidate.fileEditorKeymap)) {
      const mode = candidate.fileEditorKeymap.trim();
      if (mode === 'default' || mode === 'vim') {
        result.fileEditorKeymap = mode;
      }
    }
    if (isString(candidate.fileEditorVimMappings)) {
      result.fileEditorVimMappings = candidate.fileEditorVimMappings.slice(0, 10_000);
    }
    if (Array.isArray(candidate.providerOrder)) {
      result.providerOrder = normalizeStringArray(candidate.providerOrder);
    }
    if (isBoolean(candidate.sessionRecapEnabled)) {
      result.sessionRecapEnabled = candidate.sessionRecapEnabled;
    }
    if (isBoolean(candidate.sessionSuggestionEnabled)) {
      result.sessionSuggestionEnabled = candidate.sessionSuggestionEnabled;
    }
    if (isBoolean(candidate.sessionWorkEnabled)) {
      result.sessionWorkEnabled = candidate.sessionWorkEnabled;
    }
    if (isBoolean(candidate.sessionReviewOfferEnabled)) {
      result.sessionReviewOfferEnabled = candidate.sessionReviewOfferEnabled;
    }
    if (isBoolean(candidate.sessionGoalEnabled)) {
      result.sessionGoalEnabled = candidate.sessionGoalEnabled;
    }
    if (candidate.sessionGoalChecker === 'classifier' || candidate.sessionGoalChecker === 'small-model') {
      result.sessionGoalChecker = candidate.sessionGoalChecker;
    }
    if (isInteger(candidate.sessionGoalMaxAutoTurns) && candidate.sessionGoalMaxAutoTurns >= 1 && candidate.sessionGoalMaxAutoTurns <= 200) {
      result.sessionGoalMaxAutoTurns = candidate.sessionGoalMaxAutoTurns;
    }
    if (isBoolean(candidate.sessionGoalDefaultBudgetEnabled)) {
      result.sessionGoalDefaultBudgetEnabled = candidate.sessionGoalDefaultBudgetEnabled;
    }
    if (isNumber(candidate.sessionGoalDefaultBudget) && Number.isFinite(candidate.sessionGoalDefaultBudget) && candidate.sessionGoalDefaultBudget > 0) {
      result.sessionGoalDefaultBudget = Math.floor(candidate.sessionGoalDefaultBudget);
    }
    if (isBoolean(candidate.collapsibleThinkingBlocks)) {
      result.collapsibleThinkingBlocks = candidate.collapsibleThinkingBlocks;
    }
    if (isBoolean(candidate.showTextJustificationActivity)) {
      result.showTextJustificationActivity = candidate.showTextJustificationActivity;
    }
    if (isBoolean(candidate.showDeletionDialog)) {
      result.showDeletionDialog = candidate.showDeletionDialog;
    }
    if (isBoolean(candidate.nativeNotificationsEnabled)) {
      result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
    }
    if (isString(candidate.notificationMode)) {
      const mode = candidate.notificationMode.trim();
      if (mode === 'always' || mode === 'hidden-only') {
        result.notificationMode = mode;
      }
    }
    if (isBoolean(candidate.notifyOnSubtasks)) {
      result.notifyOnSubtasks = candidate.notifyOnSubtasks;
    }
    if (isBoolean(candidate.notifyOnCompletion)) {
      result.notifyOnCompletion = candidate.notifyOnCompletion;
    }
    if (candidate.notifyOnPullRequests === true || candidate.notifyOnPullRequests === false) {
      result.notifyOnPullRequests = candidate.notifyOnPullRequests;
    }
    if (isBoolean(candidate.notifyOnError)) {
      result.notifyOnError = candidate.notifyOnError;
    }
    if (isBoolean(candidate.notifyOnQuestion)) {
      result.notifyOnQuestion = candidate.notifyOnQuestion;
    }
    if (hasSettingsFields(candidate.notificationTemplates)) {
      result.notificationTemplates = candidate.notificationTemplates;
    }
    if (isBoolean(candidate.summarizeLastMessage)) {
      result.summarizeLastMessage = candidate.summarizeLastMessage;
    }
    if (isNumber(candidate.summaryThreshold) && Number.isFinite(candidate.summaryThreshold)) {
      result.summaryThreshold = Math.max(0, Math.round(candidate.summaryThreshold));
    }
    if (isNumber(candidate.summaryLength) && Number.isFinite(candidate.summaryLength)) {
      result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
    }
    if (isNumber(candidate.maxLastMessageLength) && Number.isFinite(candidate.maxLastMessageLength)) {
      result.maxLastMessageLength = Math.max(10, Math.round(candidate.maxLastMessageLength));
    }
    if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
      result.usageDisplayMode = candidate.usageDisplayMode;
    }
    if (Array.isArray(candidate.usageDropdownProviders)) {
      result.usageDropdownProviders = normalizeStringArray(candidate.usageDropdownProviders);
    }
    if (isBoolean(candidate.autoDeleteEnabled)) {
      result.autoDeleteEnabled = candidate.autoDeleteEnabled;
    }
    if (isNumber(candidate.autoDeleteAfterDays) && Number.isFinite(candidate.autoDeleteAfterDays)) {
      const normalizedDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)));
      result.autoDeleteAfterDays = normalizedDays;
    }
    if (candidate.sessionRetentionAction === 'archive' || candidate.sessionRetentionAction === 'delete') {
      result.sessionRetentionAction = candidate.sessionRetentionAction;
    }
    if (isBoolean(candidate.sessionRetentionOnlyArchived)) {
      result.sessionRetentionOnlyArchived = candidate.sessionRetentionOnlyArchived;
    }
    if (candidate.sessionRetentionIncludeInWork === true || candidate.sessionRetentionIncludeInWork === false) {
      result.sessionRetentionIncludeInWork = candidate.sessionRetentionIncludeInWork;
    }
    if (isBoolean(candidate.mergedWorktreeCleanupEnabled)) {
      result.mergedWorktreeCleanupEnabled = candidate.mergedWorktreeCleanupEnabled;
    }
    if (candidate.worktreeArchiveOnDoneEnabled === true || candidate.worktreeArchiveOnDoneEnabled === false) {
      result.worktreeArchiveOnDoneEnabled = candidate.worktreeArchiveOnDoneEnabled;
    }
    if (candidate.tunnelBootstrapTtlMs === null) {
      result.tunnelBootstrapTtlMs = null;
    } else if (isNumber(candidate.tunnelBootstrapTtlMs) && Number.isFinite(candidate.tunnelBootstrapTtlMs)) {
      result.tunnelBootstrapTtlMs = normalizeTunnelBootstrapTtlMs(candidate.tunnelBootstrapTtlMs);
    }
    if (isNumber(candidate.tunnelSessionTtlMs) && Number.isFinite(candidate.tunnelSessionTtlMs)) {
      result.tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(candidate.tunnelSessionTtlMs);
    }
    if (isString(candidate.tunnelProvider)) {
      const provider = normalizeTunnelProvider(candidate.tunnelProvider);
      if (provider) {
        result.tunnelProvider = provider;
      }
    }
    if (isString(candidate.tunnelMode)) {
      result.tunnelMode = normalizeTunnelMode(candidate.tunnelMode);
    }
    if (isInteger(candidate.tunnelHttpsPort) && candidate.tunnelHttpsPort >= 1 && candidate.tunnelHttpsPort <= 65535) {
      result.tunnelHttpsPort = candidate.tunnelHttpsPort;
    }
    if (candidate.managedLocalTunnelConfigPath === null) {
      result.managedLocalTunnelConfigPath = null;
    } else if (isString(candidate.managedLocalTunnelConfigPath)) {
      const trimmed = candidate.managedLocalTunnelConfigPath.trim();
      result.managedLocalTunnelConfigPath = trimmed.length > 0 ? normalizeOptionalPath(trimmed) : null;
    }
    if (isString(candidate.managedRemoteTunnelHostname)) {
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.managedRemoteTunnelHostname);
      result.managedRemoteTunnelHostname = hostname;
    }
    if (candidate.managedRemoteTunnelToken === null) {
      result.managedRemoteTunnelToken = null;
    } else if (isString(candidate.managedRemoteTunnelToken)) {
      result.managedRemoteTunnelToken = candidate.managedRemoteTunnelToken.trim();
    }
    const managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(candidate.managedRemoteTunnelPresets);
    if (managedRemoteTunnelPresets) {
      result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
    }
    const managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(candidate.managedRemoteTunnelPresetTokens);
    if (managedRemoteTunnelPresetTokens) {
      result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
    }
    if (isString(candidate.managedRemoteTunnelSelectedPresetId)) {
      const id = candidate.managedRemoteTunnelSelectedPresetId.trim();
      result.managedRemoteTunnelSelectedPresetId = id || undefined;
    }

    if (isString(candidate.defaultModel)) {
      const trimmed = candidate.defaultModel.trim();
      result.defaultModel = trimmed.length > 0 ? trimmed : undefined;
    }
    const lastSelectedModel = lastSelectedModelSchema.safeParse(candidate.lastSelectedModel);
    if (lastSelectedModel.success) {
      result.lastSelectedModel = lastSelectedModel.data;
    }
    if (isString(candidate.defaultVariant)) {
      const trimmed = candidate.defaultVariant.trim();
      result.defaultVariant = trimmed.length > 0 ? trimmed : undefined;
    }
    if (isString(candidate.defaultAgent)) {
      const trimmed = candidate.defaultAgent.trim();
      result.defaultAgent = trimmed.length > 0 ? trimmed : undefined;
    }
    if (isBoolean(candidate.smallModelUseDefault)) {
      result.smallModelUseDefault = candidate.smallModelUseDefault;
    }
    if (isString(candidate.smallModelOverride)) {
      const trimmed = candidate.smallModelOverride.trim();
      result.smallModelOverride = trimmed.length > 0 ? trimmed : undefined;
    }
    if (candidate.smallModelVariant !== undefined) {
      result.smallModelVariant = asNonEmptyString(candidate.smallModelVariant) ?? undefined;
    }
    if (isString(candidate.walkthroughModelOverride)) {
      const trimmed = candidate.walkthroughModelOverride.trim();
      result.walkthroughModelOverride = trimmed.length > 0 ? trimmed : undefined;
    }
    if (candidate.walkthroughModelVariant !== undefined) {
      result.walkthroughModelVariant = asNonEmptyString(candidate.walkthroughModelVariant) ?? undefined;
    }
    for (const key of ['fallbackModel', 'fallbackVariant'] as const) {
      const value = z.string().trim().safeParse(candidate[key]);
      if (value.success) result[key] = value.data.length > 0 ? value.data : undefined;
    }
    if (Array.isArray(candidate.accountSwitchProviders)) {
      result.accountSwitchProviders = normalizeStringArray(candidate.accountSwitchProviders);
    }
    if (isString(candidate.defaultGitIdentityId)) {
      const trimmed = candidate.defaultGitIdentityId.trim();
      result.defaultGitIdentityId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (isString(candidate.followUpBehavior)) {
      result.followUpBehavior = normalizeFollowUpBehavior(candidate.followUpBehavior);
    } else if (isBoolean(candidate.queueModeEnabled)) {
      result.followUpBehavior = normalizeFollowUpBehavior(undefined, candidate.queueModeEnabled);
    }
    if (isBoolean(candidate.autoCreateWorktree)) {
      result.autoCreateWorktree = candidate.autoCreateWorktree;
    }
    if (isBoolean(candidate.gitmojiEnabled)) {
      result.gitmojiEnabled = candidate.gitmojiEnabled;
    }
    if (isBoolean(candidate.defaultFileViewerPreview)) {
      result.defaultFileViewerPreview = candidate.defaultFileViewerPreview;
    }
    if (isString(candidate.zenModel)) {
      const trimmed = candidate.zenModel.trim();
      result.zenModel = trimmed.length > 0 ? trimmed : undefined;
    }
    if (isString(candidate.pwaAppName)) {
      result.pwaAppName = normalizePwaAppName(candidate.pwaAppName, undefined);
    }
    if (isString(candidate.pwaOrientation)) {
      result.pwaOrientation = normalizePwaOrientation(candidate.pwaOrientation, undefined);
    }
    if (isString(candidate.mobileKeyboardMode)) {
      const mode = normalizeMobileKeyboardMode(candidate.mobileKeyboardMode, null);
      if (mode) {
        result.mobileKeyboardMode = mode;
      }
    }
    if (isBoolean(candidate.inputSpellcheckEnabled)) {
      result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
    }
    if (candidate.enterToSend === true || candidate.enterToSend === false) {
      result.enterToSend = candidate.enterToSend;
    }
    if (candidate.enterToSendConfigured === true || candidate.enterToSendConfigured === false) {
      result.enterToSendConfigured = candidate.enterToSendConfigured;
    }
    if (candidate.mobileReturnKeySends === true || candidate.mobileReturnKeySends === false) {
      result.mobileReturnKeySends = candidate.mobileReturnKeySends;
    }
    if (isBoolean(candidate.showOpenCodeUpdateNotifications)) {
      result.showOpenCodeUpdateNotifications = candidate.showOpenCodeUpdateNotifications;
    }
    if (isBoolean(candidate.agentWebToolEnabled)) {
      result.agentWebToolEnabled = candidate.agentWebToolEnabled;
    }
    if (isString(candidate.browserProvider) && candidate.browserProvider.trim()) {
      result.browserProvider = candidate.browserProvider.trim();
    }
    for (const key of AGENT_TOOL_BOOLEAN_KEYS) {
      if (isBoolean(candidate[key])) result[key] = candidate[key];
    }
    const dreamingModel = dreamingModelSchema.safeParse(candidate.agentMemoryDreamingModel);
    if (dreamingModel.success) result.agentMemoryDreamingModel = dreamingModel.data;
    const dreamingVariant = z.string().trim().safeParse(candidate.agentMemoryDreamingVariant);
    if (dreamingVariant.success) result.agentMemoryDreamingVariant = dreamingVariant.data;
    const agentImageModel = asNonEmptyString(candidate.agentImageModel);
    if (agentImageModel && /^[^/\s]+\/\S+$/.test(agentImageModel)) {
      result.agentImageModel = agentImageModel;
    }
    if (isBoolean(candidate.isolatedSpacesEnabled)) {
      result.isolatedSpacesEnabled = candidate.isolatedSpacesEnabled;
    }
    if (hasIdleStopSetting(candidate.isolatedSpacesIdleStop)) {
      result.isolatedSpacesIdleStop = { ...candidate.isolatedSpacesIdleStop };
    }
    const sshHost = sshHostSchema.safeParse(candidate.isolatedSpacesSshHost);
    if (sshHost.success) result.isolatedSpacesSshHost = sshHost.data;
    if (isString(candidate.openCodeUpdateToastDismissedVersion)) {
      const version = candidate.openCodeUpdateToastDismissedVersion.trim();
      result.openCodeUpdateToastDismissedVersion = version.slice(0, VERSION_STRING_MAX_LENGTH);
    }
    if (isBoolean(candidate.showToolFileIcons)) {
      result.showToolFileIcons = candidate.showToolFileIcons;
    }
    if (isBoolean(candidate.showTurnChangedFiles)) {
      result.showTurnChangedFiles = candidate.showTurnChangedFiles;
    }
    if (isString(candidate.timeFormatPreference)) {
      const mode = candidate.timeFormatPreference.trim();
      if (mode === 'auto' || mode === '12h' || mode === '24h') {
        result.timeFormatPreference = mode;
      }
    }
    if (isString(candidate.weekStartPreference)) {
      const mode = candidate.weekStartPreference.trim();
      if (mode === 'auto' || mode === 'sunday' || mode === 'monday') {
        result.weekStartPreference = mode;
      }
    }
    if (isString(candidate.chatRenderMode)) {
      const mode = candidate.chatRenderMode.trim();
      if (mode === 'sorted' || mode === 'live') {
        result.chatRenderMode = mode;
      }
    }
    if (isString(candidate.messageStreamTransport)) {
      const mode = candidate.messageStreamTransport.trim();
      if (mode === 'auto' || mode === 'ws' || mode === 'sse') {
        result.messageStreamTransport = mode;
      }
    }
    if (isString(candidate.activityRenderMode)) {
      const mode = candidate.activityRenderMode.trim();
      if (mode === 'collapsed' || mode === 'summary') {
        result.activityRenderMode = mode;
      }
    }
    if (isString(candidate.mermaidRenderingMode)) {
      const mode = candidate.mermaidRenderingMode.trim();
      if (mode === 'svg' || mode === 'ascii') {
        result.mermaidRenderingMode = mode;
      }
    }
    if (isString(candidate.userMessageRenderingMode)) {
      const mode = candidate.userMessageRenderingMode.trim();
      if (mode === 'markdown' || mode === 'plain') {
        result.userMessageRenderingMode = mode;
      }
    }
    if (isBoolean(candidate.collapsibleUserMessages)) {
      result.collapsibleUserMessages = candidate.collapsibleUserMessages;
    }
    if (candidate.stickyUserHeader === true || candidate.stickyUserHeader === false) {
      result.stickyUserHeader = candidate.stickyUserHeader;
    }
    if (isBoolean(candidate.promptNavigatorEnabled)) {
      result.promptNavigatorEnabled = candidate.promptNavigatorEnabled;
    }
    if (candidate.chatWidth === 'default' || candidate.chatWidth === 'wider' || candidate.chatWidth === 'full') {
      result.chatWidth = candidate.chatWidth;
    }
    if (isBoolean(candidate.wideChatLayoutEnabled)) {
      result.wideChatLayoutEnabled = candidate.wideChatLayoutEnabled;
    }
    if (isBoolean(candidate.showSplitAssistantMessageActions)) {
      result.showSplitAssistantMessageActions = candidate.showSplitAssistantMessageActions;
    }
    if (isNumber(candidate.fontSize) && Number.isFinite(candidate.fontSize)) {
      result.fontSize = Math.max(50, Math.min(200, Math.round(candidate.fontSize)));
    }
    if (isFiniteNumber(candidate.chatFontSize)) {
      result.chatFontSize = Math.max(50, Math.min(200, Math.round(candidate.chatFontSize)));
    }
    if (isNumber(candidate.terminalFontSize) && Number.isFinite(candidate.terminalFontSize)) {
      result.terminalFontSize = Math.max(9, Math.min(52, Math.round(candidate.terminalFontSize)));
    }
    if (isNumber(candidate.editorFontSize) && Number.isFinite(candidate.editorFontSize)) {
      result.editorFontSize = Math.max(9, Math.min(32, Math.round(candidate.editorFontSize)));
    }
    if (isString(candidate.terminalShell)) {
      const shell = candidate.terminalShell.trim().toLowerCase();
      if (TERMINAL_SHELL_VALUES.has(shell)) result.terminalShell = shell;
    }
    if (Array.isArray(candidate.terminalLoginShells)) {
      result.terminalLoginShells = [...new Set(candidate.terminalLoginShells
        .filter(isString)
        .map((shell) => shell.trim().toLowerCase())
        .filter((shell) => TERMINAL_SHELL_VALUES.has(shell)))];
    }
    if (isNumber(candidate.padding) && Number.isFinite(candidate.padding)) {
      result.padding = Math.max(50, Math.min(200, Math.round(candidate.padding)));
    }
    if (isNumber(candidate.cornerRadius) && Number.isFinite(candidate.cornerRadius)) {
      result.cornerRadius = Math.max(0, Math.min(32, Math.round(candidate.cornerRadius)));
    }
    if (isNumber(candidate.inputBarOffset) && Number.isFinite(candidate.inputBarOffset)) {
      result.inputBarOffset = Math.max(0, Math.min(100, Math.round(candidate.inputBarOffset)));
    }

    const shortcutOverrides = sanitizeShortcutOverrides(candidate.shortcutOverrides);
    if (shortcutOverrides) {
      result.shortcutOverrides = shortcutOverrides;
    }

    const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
    if (favoriteModels) {
      result.favoriteModels = favoriteModels;
    }

    const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
    if (recentModels) {
      result.recentModels = recentModels;
    }

    const hiddenModels = sanitizeModelRefs(candidate.hiddenModels, HIDDEN_MODELS_MAX);
    if (hiddenModels) {
      result.hiddenModels = hiddenModels;
    }

    if (Array.isArray(candidate.collapsedModelProviders)) {
      result.collapsedModelProviders = normalizeStringArray(candidate.collapsedModelProviders);
    }

    const customProviderIcons = sanitizeCustomProviderIcons(candidate.customProviderIcons);
    if (customProviderIcons) {
      result.customProviderIcons = customProviderIcons;
    }

    const customProviderLogos = sanitizeCustomProviderLogos(candidate.customProviderLogos);
    if (customProviderLogos) {
      result.customProviderLogos = customProviderLogos;
    }

    if (Array.isArray(candidate.recentAgents)) {
      result.recentAgents = normalizeStringArray(candidate.recentAgents);
    }
    if (Array.isArray(candidate.favoriteAgents)) {
      result.favoriteAgents = normalizeStringArray(candidate.favoriteAgents);
    }

    const recentEfforts = sanitizeRecentEfforts(candidate.recentEfforts);
    if (recentEfforts) {
      result.recentEfforts = recentEfforts;
    }

    const lastUsedEfforts = sanitizeLastUsedEfforts(candidate.lastUsedEfforts);
    if (lastUsedEfforts) {
      result.lastUsedEfforts = lastUsedEfforts;
    }
    if (isString(candidate.diffLayoutPreference)) {
      const mode = candidate.diffLayoutPreference.trim();
      if (mode === 'dynamic' || mode === 'inline' || mode === 'side-by-side') {
        result.diffLayoutPreference = mode;
      }
    }
    if (isString(candidate.gitChangesViewMode)) {
      const mode = candidate.gitChangesViewMode.trim();
      if (mode === 'flat' || mode === 'tree') {
        result.gitChangesViewMode = mode;
      }
    }
    if (isString(candidate.toolJsonViewMode)) {
      const mode = candidate.toolJsonViewMode.trim();
      if (mode === 'summary' || mode === 'formatted' || mode === 'raw') {
        result.toolJsonViewMode = mode;
      }
    }
    if (isBoolean(candidate.directoryShowHidden)) {
      result.directoryShowHidden = candidate.directoryShowHidden;
    }
    if (isBoolean(candidate.filesViewShowGitignored)) {
      result.filesViewShowGitignored = candidate.filesViewShowGitignored;
    }
    if (isString(candidate.openInAppId)) {
      const trimmed = candidate.openInAppId.trim();
      if (trimmed.length > 0) {
        result.openInAppId = trimmed;
      }
    }

    const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
    if (skillCatalogs) {
      result.skillCatalogs = skillCatalogs;
    }

    if (hasSettingsFields(candidate.usageSelectedModels)) {
      const sanitized: Record<string, string[]> = {};
      for (const [providerId, models] of Object.entries(candidate.usageSelectedModels)) {
        if (Array.isArray(models)) {
          const validModels = models.filter((m) => isString(m) && m.length > 0);
          if (validModels.length > 0) {
            sanitized[providerId] = validModels;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageSelectedModels = sanitized;
      }
    }

    if (hasSettingsFields(candidate.usageCollapsedFamilies)) {
      const sanitized: Record<string, string[]> = {};
      for (const [providerId, families] of Object.entries(candidate.usageCollapsedFamilies)) {
        if (Array.isArray(families)) {
          const validFamilies = families.filter((f) => isString(f) && f.length > 0);
          if (validFamilies.length > 0) {
            sanitized[providerId] = validFamilies;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageCollapsedFamilies = sanitized;
      }
    }

    if (hasSettingsFields(candidate.usageExpandedFamilies)) {
      const sanitized: Record<string, string[]> = {};
      for (const [providerId, families] of Object.entries(candidate.usageExpandedFamilies)) {
        if (Array.isArray(families)) {
          const validFamilies = families.filter((f) => isString(f) && f.length > 0);
          if (validFamilies.length > 0) {
            sanitized[providerId] = validFamilies;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageExpandedFamilies = sanitized;
      }
    }

    if (hasSettingsFields(candidate.usageModelGroups)) {
      const sanitized: Record<string, UsageModelGroups> = {};
      for (const [providerId, rawConfig] of Object.entries(candidate.usageModelGroups)) {
        if (!hasUsageModelGroupFields(rawConfig)) {
          throw new TypeError(`Cannot read properties of ${rawConfig} (reading 'customGroups')`);
        }
        const config = rawConfig;

        const providerConfig: UsageModelGroups = {};

        if (Array.isArray(config.customGroups)) {
          const validGroups = config.customGroups
            .filter(hasUsageGroupLabels)
            .map((g) => ({
              id: g.id.slice(0, 64),
              label: g.label.slice(0, 128),
              models: Array.isArray(g.models)
                ? g.models.filter(isString).slice(0, 500)
                : [],
              order: isNumber(g.order) ? g.order : 0,
            }));
          if (validGroups.length > 0) {
            providerConfig.customGroups = validGroups;
          }
        }

        if (hasSettingsFields(config.modelAssignments)) {
          const assignments: Record<string, string> = {};
          for (const [model, groupId] of Object.entries(config.modelAssignments)) {
            if (isString(groupId)) {
              assignments[model] = groupId;
            }
          }
          if (Object.keys(assignments).length > 0) {
            providerConfig.modelAssignments = assignments;
          }
        }

        if (hasSettingsFields(config.renamedGroups)) {
          const renamed: Record<string, string> = {};
          for (const [groupId, label] of Object.entries(config.renamedGroups)) {
            if (isString(label)) {
              renamed[groupId] = label.slice(0, 128);
            }
          }
          if (Object.keys(renamed).length > 0) {
            providerConfig.renamedGroups = renamed;
          }
        }

        if (Object.keys(providerConfig).length > 0) {
          sanitized[providerId] = providerConfig;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageModelGroups = sanitized;
      }
    }

    if (isBoolean(candidate.reportUsage)) {
      result.reportUsage = candidate.reportUsage;
    }

    if (isString(candidate.globalBehaviorPrompt)) {
      const value = candidate.globalBehaviorPrompt;
      if (value.length <= 1024 * 1024) {
        result.globalBehaviorPrompt = value;
      }
    }

    if (isBoolean(candidate.responseStyleEnabled)) {
      result.responseStyleEnabled = candidate.responseStyleEnabled;
    }

    if (
      isString(candidate.responseStylePreset) &&
      ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom'].includes(candidate.responseStylePreset)
    ) {
      result.responseStylePreset = candidate.responseStylePreset;
    }

    if (isString(candidate.responseStyleCustomInstructions)) {
      const value = candidate.responseStyleCustomInstructions;
      if (value.length <= 50_000) {
        result.responseStyleCustomInstructions = value;
      }
    }

    if (isBoolean(candidate.dictationEnabled)) {
      result.dictationEnabled = candidate.dictationEnabled;
    }
    const dictationAutoSend = z.boolean().safeParse(candidate.dictationAutoSend);
    if (dictationAutoSend.success) result.dictationAutoSend = dictationAutoSend.data;
    if (isString(candidate.sttProvider)) {
      const provider = candidate.sttProvider.trim();
      if (provider === 'local' || provider === 'openai-compatible') {
        result.sttProvider = provider;
      } else if (provider === 'server') {
        result.sttProvider = 'openai-compatible';
      } else if (provider === 'browser' || provider === 'wasm') {
        result.sttProvider = 'local';
      }
    }
    if (isString(candidate.sttServerUrl)) {
      const trimmed = candidate.sttServerUrl.trim();
      if (trimmed.length <= STT_SERVER_URL_MAX_LENGTH) {
        result.sttServerUrl = trimmed;
      }
    }
    if (isString(candidate.sttModel)) {
      const trimmed = candidate.sttModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttModel = trimmed;
      }
    }
    const sttEndpointPath = z.string().trim().safeParse(candidate.sttEndpointPath);
    if (sttEndpointPath.success && sttEndpointPath.data.length <= STT_ENDPOINT_PATH_MAX_LENGTH) {
      result.sttEndpointPath = sttEndpointPath.data;
    }
    if (isString(candidate.sttLocalModel)) {
      const trimmed = candidate.sttLocalModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttLocalModel = trimmed;
      }
    }
    if (isString(candidate.sttLanguage)) {
      const trimmed = candidate.sttLanguage.trim();
      if (trimmed.length <= STT_LANGUAGE_MAX_LENGTH) {
        result.sttLanguage = trimmed;
      }
    }
    if (candidate.sttCorrectTranscript === true || candidate.sttCorrectTranscript === false) {
      result.sttCorrectTranscript = candidate.sttCorrectTranscript;
    }

    for (const key of Object.keys(result)) {
      if (!isPersistableSettingsKey(key)) {
        Reflect.deleteProperty(result, key);
      }
    }

    return result;
  };

  const mergePersistedSettings = (current: SettingsDocument, changes: SettingsDocument) => {
    const baseBookmarks = Array.isArray(changes.securityScopedBookmarks)
      ? changes.securityScopedBookmarks
      : Array.isArray(current.securityScopedBookmarks)
        ? current.securityScopedBookmarks
        : [];

    const next: SettingsDocument = {
      ...current,
      ...changes,
      securityScopedBookmarks: Array.from(
        new Set(
          baseBookmarks.filter((entry) => isString(entry) && entry.length > 0)
        )
      ),
    };

    if (Array.isArray(changes.sidebarSections) && Array.isArray(current.sidebarSections)) {
      next.sidebarSections = keepOmittedBuiltinSections(sanitizeSidebarSections(current.sidebarSections), changes.sidebarSections);
    }

    return next;
  };

  const formatSettingsResponse = (settings: SettingsDocument) => {
    const sanitized = sanitizeSettingsUpdate(settings);
    for (const key of SECRET_SETTINGS_KEYS) {
      Reflect.deleteProperty(sanitized, key);
    }
    const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);
    const hasManagedRemoteTunnelToken = isString(settings?.managedRemoteTunnelToken) && settings.managedRemoteTunnelToken.trim().length > 0;
    const hasDesktopUiPassword = isString(settings?.desktopUiPassword) && settings.desktopUiPassword.trim().length > 0;
    const pwaAppName = normalizePwaAppName(settings?.pwaAppName, '');
    const pwaOrientation = normalizePwaOrientation(settings?.pwaOrientation, 'system');
    const mobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode, 'native');
    const inputHistoryScope = sanitized.inputHistoryScope ?? DEFAULT_INPUT_HISTORY_SCOPE;
    const inputHistoryLimit = sanitized.inputHistoryLimit ?? DEFAULT_INPUT_HISTORY_LIMIT;

    const appNameFields: AppNameFields = {};
    if (pwaAppName) appNameFields.pwaAppName = pwaAppName;
    const desktopFields: DesktopSettingsFields = {};
    if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
      desktopFields.desktopLanAccessActive = process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE === 'true';
      desktopFields.desktopLanAccessBlockedReason =
        process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON === 'missing-password'
          || process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON === 'enterprise-mode'
          ? process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON
          : null;
    }

    return {
      ...sanitized,
      hasManagedRemoteTunnelToken,
      hasDesktopUiPassword,
      agentMemoryFeatureAvailable: true,
      agentWorkflowFeatureAvailable: true,
      overviewFeatureAvailable: isOverviewFeatureAvailable(),
      routingFeatureAvailable: true,
      ...appNameFields,
      pwaOrientation,
      mobileKeyboardMode,
      inputHistoryScope,
      inputHistoryLimit,
      messageSearchEnabled: isMessageSearchEnabled(sanitized),
      securityScopedBookmarks: bookmarks,
      pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
      ...desktopFields,
      showReasoningTraces:
        isBoolean(settings.showReasoningTraces)
          ? settings.showReasoningTraces
          : sanitized.showReasoningTraces ?? false,
      collapsibleThinkingBlocks:
        isBoolean(settings.collapsibleThinkingBlocks)
          ? settings.collapsibleThinkingBlocks
          : sanitized.collapsibleThinkingBlocks ?? true,
    };
  };

  return {
    normalizePwaAppName,
    normalizePwaOrientation,
    normalizeMobileKeyboardMode,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    formatSettingsResponse,
  };
};
