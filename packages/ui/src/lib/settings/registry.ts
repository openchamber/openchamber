/**
 * The settings registry: one table that names every OpenChamber setting, who
 * owns it (`scope`), how a value is parsed at the boundary, and where the UI
 * keeps its live copy.
 *
 * Everything else about settings derives from this table: the `DesktopSettings`
 * type, the boundary sanitizer, the per-runtime mirror, the store apply step,
 * the store-subscribing auto-save, and — through the generated JSON snapshot
 * (`settings-registry.json`, see `registry-snapshot.ts`) — the server's and the
 * VS Code bridge's key lists. A key that is not here does not persist.
 *
 * Scopes (see `.opencode/plans/settings-scopes.md`):
 * - `instance`: a fact about the machine the server runs on. Never synced.
 * - `profile`: the person's preference. Synced to every client of the
 *   instance; a few are stored per surface kind (`perSurface`).
 * - `device`: state of this install/surface. Fields that still cross the wire
 *   today are listed here so Phase 2 can stop them deliberately; fields that
 *   only ever lived in the local store are in `LOCAL_DEVICE_KEYS`.
 */
import type { ProjectEntry, TerminalShell } from '@/lib/api/types';
import type { DesktopWindowControlsPosition, DesktopWindowControlsStyle } from '@/lib/desktop';
import { getDirectoryShowHidden, setDirectoryShowHidden } from '@/lib/directoryShowHidden';
import type { DraftStarterRef } from '@/lib/draftStarters';
import { sanitizeStarterRefs } from '@/lib/draftStarters';
import { getFilesViewShowGitignored, setFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { isMonoFontOption, isUiFontOption, type MonoFontOption, type UiFontOption } from '@/lib/fontOptions';
import { isInputHistoryLimit, isInputHistoryScope, type InputHistoryScope } from '@/lib/inputHistoryScope';
import { normalizeMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { isTerminalShell } from '@/lib/terminalShell';
import { sanitizeWorkStatusHiddenSections } from '@/components/chat/work-status/sections';
import { useInputHistoryStore } from '@/stores/useInputHistoryStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore, type FileEditorKeymap, type LargeTextPasteBehavior } from '@/stores/useUIStore';
import { z } from 'zod';
import {
  fromSchema,
  mapParser,
  parseBoolean,
  parseDesktopWindowControlsPosition,
  parseFiniteNumber,
  parseFollowUpBehavior,
  parseGuarded,
  parseIntegerAtLeast,
  parseIntegerInRange,
  parseManagedRemoteTunnelPresetTokens,
  parseManagedRemoteTunnelPresets,
  parseModelRefs,
  parseNonEmptyString,
  parseNonEmptyTrimmedString,
  parseNotificationTemplates,
  parseNullableFiniteNumber,
  parseNullableTrimmedPath,
  parseNullableTrimmedString,
  parseOneOf,
  parsePositiveInteger,
  parseProjects,
  parsePwaAppName,
  parseRecentEfforts,
  parseShortcutOverrides,
  parseSkillCatalogs,
  parseStringList,
  parseStringRecordOfStringLists,
  parseStringSet,
  parseSttProvider,
  parseTerminalShells,
  parseTextUpTo,
  parseTrimmedString,
  parseTrimmedStringUpTo,
  parseUsageModelGroups,
  type ManagedRemoteTunnelPreset,
  type ModelRef,
  type NotificationTemplates,
  type SettingsParser,
  type SettingsRawDocument,
  type SkillCatalogConfig,
  type UsageModelGroups,
} from './parsers';

export type SettingsScope = 'instance' | 'profile' | 'device';
export type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';

/**
 * The siblings a field's `write` may consult in the same parsed snapshot. Named
 * explicitly (not `DesktopSettings`) so the registry's type does not refer to
 * itself through the bindings; extend it when another field needs a sibling.
 */
export type SettingsSiblingView = {
  readonly draftStartersCraftGoalAdded?: boolean;
  readonly draftStartersScheduleTaskAdded?: boolean;
  readonly workStatusHiddenSectionsExplicit?: boolean;
};

/**
 * How the UI keeps a live copy of a field, when it keeps one at all. Method
 * syntax on purpose: it keeps `SettingsFieldSpec<T>` assignable to
 * `SettingsFieldSpec<unknown>`, which is what the generic loops below iterate.
 */
export type SettingsUiBinding<T> = {
  read(): T | undefined;
  write(value: T, snapshot: SettingsSiblingView): void;
  /** Send changes of the backing store to the server (store-subscribing auto-save). */
  autoSave: boolean;
};

export type SettingsFieldSpec<T> = {
  scope: SettingsScope;
  parse(value: unknown, raw: SettingsRawDocument): T | undefined;
  ui?: SettingsUiBinding<T>;
  /** Profile fields the owner chose to store per surface kind (change on a phone stays on phones). */
  perSurface?: true;
  /** Surfaces that have this field; absent means all. */
  surfaces?: readonly SettingsSurface[];
  /** Workspace pointers: adopted only on a bootstrap-grade sync (see `SettingsSyncedDetail`). */
  adopt?: 'bootstrap-only';
  /** Computed by the writer from other fields; never edited directly. */
  derived?: true;
  /** Accepted on write, never returned by a read. */
  secret?: true;
  /** Emitted by the server for this build/process; never accepted on a write, never persisted. */
  computed?: true;
};

const field = <T>(spec: SettingsFieldSpec<T>): SettingsFieldSpec<T> => spec;

type UIStoreState = ReturnType<typeof useUIStore.getState>;

/** A field whose live copy is one `useUIStore` key, written through its setter. */
const uiStore = <K extends keyof UIStoreState>(
  key: K,
  write: (value: UIStoreState[K], snapshot: SettingsSiblingView) => void,
  options: { autoSave?: boolean } = {},
): SettingsUiBinding<UIStoreState[K]> => ({
  read: () => useUIStore.getState()[key],
  write,
  autoSave: options.autoSave ?? true,
});

const setUi = <K extends keyof UIStoreState>(key: K) => (value: UIStoreState[K]): void => {
  // SAFETY: a single-key patch built from the key it is typed by.
  useUIStore.setState({ [key]: value } as Pick<UIStoreState, K>);
};

// The config store is reached through the global it registers on `window`
// (`useConfigStore` imports the shared write path, so a direct import here
// would be a load-order cycle). Absent outside the browser.
const configStore = () => globalThis.window?.__zustand_config_store__ ?? null;

type ConfigStoreState = NonNullable<ReturnType<NonNullable<ReturnType<typeof configStore>>['getState']>>;

const configField = <K extends keyof ConfigStoreState>(
  key: K,
): SettingsUiBinding<ConfigStoreState[K]> => ({
  read: () => configStore()?.getState()[key],
  write: (value) => {
    // SAFETY: a single-key patch built from the key it is typed by.
    configStore()?.setState({ [key]: value } as Pick<ConfigStoreState, K>);
  },
  // The config store's own setters write these through `updateDesktopSettings`.
  autoSave: false,
});

type SessionDisplayState = ReturnType<typeof useSessionDisplayStore.getState>;

const sessionDisplayField = <K extends keyof SessionDisplayState>(
  key: K,
): SettingsUiBinding<SessionDisplayState[K]> => ({
  read: () => useSessionDisplayStore.getState()[key],
  write: (value) => {
    // SAFETY: a single-key patch built from the key it is typed by.
    useSessionDisplayStore.setState({ [key]: value } as Pick<SessionDisplayState, K>);
  },
  autoSave: false,
});

const RESPONSE_STYLE_PRESETS = ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom'] as const;

const parseTerminalShell: SettingsParser<TerminalShell> = parseGuarded(isTerminalShell);
const parseUiFont: SettingsParser<UiFontOption> = parseGuarded(isUiFontOption);
const parseMonoFont: SettingsParser<MonoFontOption> = parseGuarded(isMonoFontOption);
const parseInputHistoryScope: SettingsParser<InputHistoryScope> = fromSchema(z.string().refine(isInputHistoryScope));
const parseInputHistoryLimit: SettingsParser<number> = fromSchema(z.number().refine(isInputHistoryLimit));
const parseMobileKeyboardModeValue = mapParser(parseTrimmedString, (value) => normalizeMobileKeyboardMode(value, undefined));
const parseDraftStarters: SettingsParser<DraftStarterRef[]> = mapParser(fromSchema(z.array(z.unknown())), sanitizeStarterRefs);
// Unknown ids are dropped rather than kept: they would hide nothing and
// accumulate forever as sections get renamed.
const parseWorkStatusHiddenSections: SettingsParser<string[]> = mapParser(fromSchema(z.array(z.unknown())), (value) => sanitizeWorkStatusHiddenSections(value));
const parseLargeTextPasteBehavior: SettingsParser<LargeTextPasteBehavior> = parseOneOf(['ask', 'attach', 'inline']);
const parseFileEditorKeymap: SettingsParser<FileEditorKeymap> = parseOneOf(['default', 'vim']);

/**
 * Removing a built-in starter must stay a durable choice, so the list is only
 * patched with the built-ins when the corresponding marker says they were
 * never offered. The markers travel with the user's edit (useDraftStarters).
 */
const withOfferedBuiltInStarters = (starters: DraftStarterRef[], snapshot: SettingsSiblingView): DraftStarterRef[] => {
  let next = starters;
  const insertAfter = (name: string, after: string) => {
    if (next.some((starter) => starter.type === 'command' && starter.name === name)) return;
    const anchor = next.findIndex((starter) => starter.type === 'command' && starter.name === after);
    const insertAt = anchor >= 0 ? anchor + 1 : next.length;
    next = [...next.slice(0, insertAt), { type: 'command', name }, ...next.slice(insertAt)];
  };
  if (snapshot.draftStartersCraftGoalAdded !== true) insertAfter('craft-goal', 'plan-feature');
  if (snapshot.draftStartersScheduleTaskAdded !== true) insertAfter('schedule-task', 'craft-goal');
  return next;
};

export const SETTINGS_REGISTRY = {
  // ── Theme (profile, per surface; ThemeSystemContext owns the live copy) ──
  themeId: field({ scope: 'profile', perSurface: true, parse: parseNonEmptyString }),
  useSystemTheme: field({ scope: 'profile', perSurface: true, parse: parseBoolean }),
  themeVariant: field({ scope: 'profile', derived: true, parse: parseOneOf(['light', 'dark']) }),
  lightThemeId: field({ scope: 'profile', perSurface: true, parse: parseNonEmptyString }),
  darkThemeId: field({ scope: 'profile', perSurface: true, parse: parseNonEmptyString }),

  // ── Workspace pointers and instance facts ──
  lastDirectory: field({ scope: 'instance', adopt: 'bootstrap-only', parse: parseNonEmptyString }),
  homeDirectory: field({ scope: 'instance', parse: parseNonEmptyString }),
  opencodeBinary: field({ scope: 'instance', parse: parseTrimmedString }),
  projects: field<ProjectEntry[]>({ scope: 'instance', parse: parseProjects }),
  activeProjectId: field({ scope: 'instance', adopt: 'bootstrap-only', parse: parseNonEmptyString }),
  securityScopedBookmarks: field({ scope: 'instance', surfaces: ['desktop'], parse: parseStringList }),
  pinnedDirectories: field({ scope: 'instance', parse: parseStringSet }),
  desktopLanAccessEnabled: field({ scope: 'instance', surfaces: ['desktop'], parse: parseBoolean }),
  desktopKeepAwakeEnabled: field({ scope: 'instance', surfaces: ['desktop'], parse: parseBoolean }),
  desktopMinimizeToTrayEnabled: field({ scope: 'instance', surfaces: ['desktop'], parse: parseBoolean }),
  desktopMacMenuBarEnabled: field({ scope: 'instance', surfaces: ['desktop'], parse: parseBoolean }),
  // Write-only: the desktop network page learns whether one is set from
  // `hasDesktopUiPassword` and sends a value only when the user types a new
  // one (or removes it with an empty string).
  desktopUiPassword: field({ scope: 'instance', secret: true, surfaces: ['desktop'], parse: parseTrimmedString }),
  hasDesktopUiPassword: field({ scope: 'instance', computed: true, surfaces: ['desktop'], parse: parseBoolean }),
  desktopLanAccessActive: field({ scope: 'instance', computed: true, surfaces: ['desktop'], parse: parseBoolean }),
  desktopLanAccessBlockedReason: field({ scope: 'instance', computed: true, surfaces: ['desktop'], parse: parseTrimmedString }),
  githubClientId: field({ scope: 'instance', parse: parseNonEmptyTrimmedString }),
  githubScopes: field({ scope: 'instance', parse: parseNonEmptyTrimmedString }),
  skillCatalogs: field<SkillCatalogConfig[]>({ scope: 'instance', parse: parseSkillCatalogs }),
  defaultGitIdentityId: field({ scope: 'instance', parse: parseTrimmedString }),
  permissionAutoAccept: field({
    scope: 'instance',
    parse: fromSchema(z.object({
      sessions: z.record(z.string().min(1), z.boolean()).catch({}),
      revision: z.number().int().nonnegative().catch(0),
    })),
  }),
  agentControlToolEnabled: field({ scope: 'instance', parse: parseBoolean, ui: uiStore('agentControlToolEnabled', (v) => useUIStore.getState().setAgentControlToolEnabled(v)) }),
  agentWebToolEnabled: field({ scope: 'instance', parse: parseBoolean, ui: uiStore('agentWebToolEnabled', (v) => useUIStore.getState().setAgentWebToolEnabled(v)) }),
  agentMemoryToolEnabled: field({ scope: 'instance', parse: parseBoolean, ui: uiStore('agentMemoryToolEnabled', (v) => useUIStore.getState().setAgentMemoryToolEnabled(v)) }),
  // Server-owned: it says whether this build has the feature at all.
  agentMemoryFeatureAvailable: field({
    scope: 'instance',
    computed: true,
    parse: parseBoolean,
    ui: uiStore('agentMemoryFeatureAvailable', (v) => useUIStore.getState().setAgentMemoryFeatureAvailable(v), { autoSave: false }),
  }),
  openCodeUpdateToastDismissedVersion: field({ scope: 'instance', parse: parseTrimmedStringUpTo(128) }),
  autoDeleteEnabled: field({ scope: 'instance', parse: parseBoolean, ui: uiStore('autoDeleteEnabled', (v) => useUIStore.getState().setAutoDeleteEnabled(v)) }),
  autoDeleteAfterDays: field({ scope: 'instance', parse: parseIntegerInRange(1, 365), ui: uiStore('autoDeleteAfterDays', (v) => useUIStore.getState().setAutoDeleteAfterDays(v)) }),
  sessionRetentionAction: field({ scope: 'instance', parse: parseOneOf(['archive', 'delete']), ui: uiStore('sessionRetentionAction', (v) => useUIStore.getState().setSessionRetentionAction(v)) }),
  terminalShell: field({ scope: 'instance', parse: parseTerminalShell, ui: uiStore('terminalShell', (v) => useUIStore.getState().setTerminalShell(v)) }),
  terminalLoginShells: field({ scope: 'instance', parse: parseTerminalShells(isTerminalShell), ui: uiStore('terminalLoginShells', (v) => useUIStore.getState().setTerminalLoginShells(v)) }),
  openInAppId: field({ scope: 'instance', parse: parseNonEmptyTrimmedString }),
  dictationEnabled: field({ scope: 'profile', parse: parseBoolean, ui: configField('dictationEnabled') }),
  sttProvider: field({ scope: 'instance', parse: parseSttProvider, ui: configField('sttProvider') }),
  sttServerUrl: field({ scope: 'instance', parse: parseTrimmedStringUpTo(2048), ui: configField('sttServerUrl') }),
  sttModel: field({ scope: 'instance', parse: parseTrimmedStringUpTo(256), ui: configField('sttModel') }),
  sttLocalModel: field({ scope: 'instance', parse: parseTrimmedStringUpTo(256), ui: configField('sttLocalModel') }),
  sttLanguage: field({ scope: 'profile', parse: parseTrimmedStringUpTo(64), ui: configField('sttLanguage') }),

  // ── Tunnels (instance) ──
  tunnelProvider: field({ scope: 'instance', parse: mapParser(parseNonEmptyTrimmedString, (value) => value.toLowerCase()) }),
  tunnelMode: field({ scope: 'instance', parse: fromSchema(z.string().transform((value) => value.trim().toLowerCase()).pipe(z.enum(['quick', 'managed-remote', 'managed-local']))) }),
  tunnelBootstrapTtlMs: field({ scope: 'instance', parse: parseNullableFiniteNumber }),
  tunnelSessionTtlMs: field({ scope: 'instance', parse: parseFiniteNumber }),
  managedLocalTunnelConfigPath: field({ scope: 'instance', parse: parseNullableTrimmedPath }),
  managedRemoteTunnelHostname: field({ scope: 'instance', parse: parseTrimmedString }),
  managedRemoteTunnelToken: field({ scope: 'instance', secret: true, parse: parseNullableTrimmedString }),
  hasManagedRemoteTunnelToken: field({ scope: 'instance', computed: true, parse: parseBoolean }),
  managedRemoteTunnelPresets: field<ManagedRemoteTunnelPreset[]>({ scope: 'instance', parse: parseManagedRemoteTunnelPresets }),
  managedRemoteTunnelSelectedPresetId: field({ scope: 'instance', parse: parseNonEmptyTrimmedString }),
  // Write-only: the tunnel page learns which presets have a token from the
  // tunnel status endpoint (`managedRemoteTunnelTokenPresetIds`), never from here.
  managedRemoteTunnelPresetTokens: field({ scope: 'instance', secret: true, parse: parseManagedRemoteTunnelPresetTokens }),

  // ── Sidebar display (profile; useSessionDisplayStore) ──
  sidebarProjectDisplayMode: field({ scope: 'profile', parse: parseOneOf(['all', 'single']), ui: sessionDisplayField('projectDisplayMode') }),
  sidebarSessionGroupingMode: field({ scope: 'profile', parse: parseOneOf(['by-worktree', 'flat']), ui: sessionDisplayField('sessionGroupingMode') }),
  sidebarProjectSortOrder: field({ scope: 'profile', parse: parseOneOf(['manual', 'a-z', 'z-a', 'date-added', 'recent']), ui: sessionDisplayField('projectSortOrder') }),
  sidebarShowRecentSection: field({ scope: 'profile', parse: parseBoolean, ui: sessionDisplayField('showRecentSection') }),

  // ── Work status ──
  workStatusPanelEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('workStatusPanelEnabled', (v) => useUIStore.getState().setWorkStatusPanelEnabled(v)) }),
  workStatusHiddenSections: field({
    scope: 'profile',
    parse: parseWorkStatusHiddenSections,
    ui: {
      read: () => useUIStore.getState().workStatusHiddenSections,
      // The explicit marker distinguishes chosen lists from the old telemetry
      // default; both land in one store update so subscribers never see the
      // list without its marker.
      write: (value, snapshot) => {
        const explicit = snapshot.workStatusHiddenSectionsExplicit === true;
        useUIStore.setState({
          workStatusHiddenSections: sanitizeWorkStatusHiddenSections(value, explicit),
          workStatusHiddenSectionsExplicit: explicit,
        });
      },
      autoSave: true,
    },
  }),
  workStatusHiddenSectionsExplicit: field({
    scope: 'profile',
    parse: parseBoolean,
    // Applied together with the list above.
    ui: uiStore('workStatusHiddenSectionsExplicit', () => undefined),
  }),

  // ── Chat and rendering (profile) ──
  showReasoningTraces: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showReasoningTraces', (v) => useUIStore.getState().setShowReasoningTraces(v)) }),
  streamingAutoFollowEnabled: field({ scope: 'profile', perSurface: true, parse: parseBoolean, ui: uiStore('streamingAutoFollowEnabled', (v) => useUIStore.getState().setStreamingAutoFollowEnabled(v)) }),
  collapsibleThinkingBlocks: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('collapsibleThinkingBlocks', (v) => useUIStore.getState().setCollapsibleThinkingBlocks(v)) }),
  showTextJustificationActivity: field({ scope: 'profile', parse: parseBoolean }),
  chatRenderMode: field({ scope: 'profile', parse: parseOneOf(['sorted', 'live']), ui: uiStore('chatRenderMode', (v) => useUIStore.getState().setChatRenderMode(v)) }),
  activityRenderMode: field({ scope: 'profile', parse: parseOneOf(['collapsed', 'summary']), ui: uiStore('activityRenderMode', (v) => useUIStore.getState().setActivityRenderMode(v)) }),
  mermaidRenderingMode: field({ scope: 'profile', parse: parseOneOf(['svg', 'ascii']), ui: uiStore('mermaidRenderingMode', (v) => useUIStore.getState().setMermaidRenderingMode(v)) }),
  userMessageRenderingMode: field({ scope: 'profile', parse: parseOneOf(['markdown', 'plain']), ui: uiStore('userMessageRenderingMode', (v) => useUIStore.getState().setUserMessageRenderingMode(v)) }),
  collapsibleUserMessages: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('collapsibleUserMessages', (v) => useUIStore.getState().setCollapsibleUserMessages(v)) }),
  stickyUserHeader: field({ scope: 'profile', perSurface: true, parse: parseBoolean, ui: uiStore('stickyUserHeader', (v) => useUIStore.getState().setStickyUserHeader(v)) }),
  promptNavigatorEnabled: field({ scope: 'profile', perSurface: true, parse: parseBoolean, ui: uiStore('promptNavigatorEnabled', (v) => useUIStore.getState().setPromptNavigatorEnabled(v)) }),
  wideChatLayoutEnabled: field({ scope: 'profile', perSurface: true, parse: parseBoolean, ui: uiStore('wideChatLayoutEnabled', (v) => useUIStore.getState().setWideChatLayoutEnabled(v)) }),
  showSplitAssistantMessageActions: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showSplitAssistantMessageActions', (v) => useUIStore.getState().setShowSplitAssistantMessageActions(v)) }),
  showToolFileIcons: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showToolFileIcons', (v) => useUIStore.getState().setShowToolFileIcons(v)) }),
  codeBlockLineWrap: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('codeBlockLineWrap', (v) => useUIStore.getState().setCodeBlockLineWrap(v)) }),
  showTurnChangedFiles: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showTurnChangedFiles', (v) => useUIStore.getState().setShowTurnChangedFiles(v)) }),
  showExpandedBashTools: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showExpandedBashTools', (v) => useUIStore.getState().setShowExpandedBashTools(v)) }),
  showExpandedEditTools: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showExpandedEditTools', (v) => useUIStore.getState().setShowExpandedEditTools(v)) }),
  toolJsonViewMode: field({ scope: 'profile', parse: parseOneOf(['summary', 'formatted', 'raw']), ui: uiStore('toolJsonViewMode', (v) => useUIStore.getState().setToolJsonViewMode(v)) }),
  timeFormatPreference: field({ scope: 'profile', parse: parseOneOf(['auto', '12h', '24h']), ui: uiStore('timeFormatPreference', (v) => useUIStore.getState().setTimeFormatPreference(v)) }),
  weekStartPreference: field({ scope: 'profile', parse: parseOneOf(['auto', 'sunday', 'monday']), ui: uiStore('weekStartPreference', (v) => useUIStore.getState().setWeekStartPreference(v)) }),
  messageStreamTransport: field({ scope: 'profile', parse: parseOneOf(['auto', 'ws', 'sse']), ui: configField('settingsMessageStreamTransport') }),
  diffLayoutPreference: field({ scope: 'profile', parse: parseOneOf(['dynamic', 'inline', 'side-by-side']), ui: uiStore('diffLayoutPreference', (v) => useUIStore.getState().setDiffLayoutPreference(v)) }),
  diffWrapLines: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('diffWrapLines', (v) => useUIStore.getState().setDiffWrapLines(v)) }),
  gitChangesViewMode: field({ scope: 'profile', parse: parseOneOf(['flat', 'tree']), ui: uiStore('gitChangesViewMode', (v) => useUIStore.getState().setGitChangesViewMode(v)) }),
  gitmojiEnabled: field({ scope: 'profile', parse: parseBoolean }),
  defaultFileViewerPreview: field({ scope: 'profile', parse: parseBoolean }),
  directoryShowHidden: field({
    scope: 'profile',
    parse: parseBoolean,
    ui: { read: getDirectoryShowHidden, write: (v) => setDirectoryShowHidden(v, { persist: false }), autoSave: false },
  }),
  filesViewShowGitignored: field({
    scope: 'profile',
    parse: parseBoolean,
    ui: { read: getFilesViewShowGitignored, write: (v) => setFilesViewShowGitignored(v, { persist: false }), autoSave: false },
  }),
  fileEditorKeymap: field({ scope: 'profile', parse: parseFileEditorKeymap, ui: uiStore('fileEditorKeymap', (v) => useUIStore.getState().setFileEditorKeymap(v)) }),
  autoSaveEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('autoSaveEnabled', (v) => useUIStore.getState().setAutoSaveEnabled(v)) }),
  autoCreateWorktree: field({ scope: 'profile', parse: parseBoolean }),
  sessionTabsEnabled: field({ scope: 'profile', surfaces: ['web', 'desktop', 'vscode'], parse: parseBoolean, ui: uiStore('sessionTabsEnabled', (v) => useUIStore.getState().setSessionTabsEnabled(v)) }),
  showOpenCodeRestartConfirm: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showOpenCodeRestartConfirm', (v) => useUIStore.getState().setShowOpenCodeRestartConfirm(v)) }),
  allowPromptingSubagentSessions: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('allowPromptingSubagentSessions', (v) => useUIStore.getState().setAllowPromptingSubagentSessions(v)) }),

  // ── Composer (profile) ──
  inputSpellcheckEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('inputSpellcheckEnabled', (v) => useUIStore.getState().setInputSpellcheckEnabled(v)) }),
  enterToSend: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('enterToSend', (v) => useUIStore.getState().setEnterToSend(v)) }),
  enterToSendConfigured: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('enterToSendConfigured', (v) => useUIStore.getState().setEnterToSendConfigured(v)) }),
  persistChatDraft: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('persistChatDraft', (v) => useUIStore.getState().setPersistChatDraft(v)) }),
  largeTextPasteBehavior: field({ scope: 'profile', parse: parseLargeTextPasteBehavior, ui: uiStore('largeTextPasteBehavior', (v) => useUIStore.getState().setLargeTextPasteBehavior(v)) }),
  followUpBehavior: field({
    scope: 'profile',
    parse: parseFollowUpBehavior,
    ui: {
      read: () => useMessageQueueStore.getState().followUpBehavior,
      write: (v) => useMessageQueueStore.getState().setFollowUpBehavior(v),
      autoSave: false,
    },
  }),
  /** Legacy boolean that `followUpBehavior` absorbs at parse time. */
  queueModeEnabled: field({ scope: 'profile', parse: parseBoolean }),
  inputHistoryScope: field({
    scope: 'profile',
    parse: parseInputHistoryScope,
    ui: { read: () => useInputHistoryStore.getState().scope, write: (v) => useInputHistoryStore.getState().applyScope(v), autoSave: false },
  }),
  inputHistoryLimit: field({
    scope: 'profile',
    parse: parseInputHistoryLimit,
    ui: { read: () => useInputHistoryStore.getState().entryLimit, write: (v) => useInputHistoryStore.getState().applyEntryLimit(v), autoSave: false },
  }),
  draftStarters: field<DraftStarterRef[]>({
    scope: 'profile',
    parse: parseDraftStarters,
    ui: {
      read: () => useUIStore.getState().globalDraftStarters ?? undefined,
      write: (value, snapshot) => useUIStore.getState().setGlobalDraftStarters(withOfferedBuiltInStarters(value, snapshot)),
      // useDraftStarters writes the list together with its markers.
      autoSave: false,
    },
  }),
  draftStartersVisible: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('draftStartersVisible', (v) => useUIStore.getState().setDraftStartersVisible(v)) }),
  draftStartersCraftGoalAdded: field({ scope: 'profile', parse: parseBoolean }),
  draftStartersScheduleTaskAdded: field({ scope: 'profile', parse: parseBoolean }),

  // ── Typography (profile; sizes per surface) ──
  fontSize: field({ scope: 'profile', perSurface: true, parse: parseFiniteNumber, ui: uiStore('fontSize', (v) => useUIStore.getState().setFontSize(v)) }),
  terminalFontSize: field({ scope: 'profile', perSurface: true, parse: parseFiniteNumber, ui: uiStore('terminalFontSize', (v) => useUIStore.getState().setTerminalFontSize(v)) }),
  editorFontSize: field({ scope: 'profile', perSurface: true, parse: parseFiniteNumber, ui: uiStore('editorFontSize', (v) => useUIStore.getState().setEditorFontSize(v)) }),
  uiFont: field({ scope: 'profile', parse: parseUiFont, ui: uiStore('uiFont', (v) => useUIStore.getState().setUiFont(v)) }),
  monoFont: field({ scope: 'profile', parse: parseMonoFont, ui: uiStore('monoFont', (v) => useUIStore.getState().setMonoFont(v)) }),
  padding: field({ scope: 'profile', perSurface: true, parse: parseFiniteNumber, ui: uiStore('padding', (v) => useUIStore.getState().setPadding(v)) }),
  cornerRadius: field({ scope: 'profile', perSurface: true, parse: parseFiniteNumber, ui: uiStore('cornerRadius', (v) => useUIStore.getState().setCornerRadius(v)) }),
  shortcutOverrides: field({
    scope: 'profile',
    parse: parseShortcutOverrides,
    ui: uiStore('shortcutOverrides', setUi('shortcutOverrides')),
  }),

  // ── Models and agents (profile) ──
  defaultModel: field({ scope: 'profile', parse: parseNonEmptyString }),
  defaultVariant: field({ scope: 'profile', parse: parseNonEmptyString }),
  defaultAgent: field({ scope: 'profile', parse: parseNonEmptyString }),
  smallModelUseDefault: field({ scope: 'profile', parse: parseBoolean }),
  smallModelOverride: field({ scope: 'profile', parse: parseNonEmptyString }),
  walkthroughModelOverride: field({ scope: 'profile', parse: parseNonEmptyString }),
  zenModel: field({ scope: 'profile', parse: parseNonEmptyTrimmedString }),
  // The model-prefs auto-save owns these six with its own debounce.
  favoriteModels: field<ModelRef[]>({ scope: 'profile', parse: parseModelRefs(64), ui: uiStore('favoriteModels', setUi('favoriteModels'), { autoSave: false }) }),
  hiddenModels: field<ModelRef[]>({ scope: 'profile', parse: parseModelRefs(1024), ui: uiStore('hiddenModels', setUi('hiddenModels'), { autoSave: false }) }),
  collapsedModelProviders: field({ scope: 'profile', parse: parseStringSet, ui: uiStore('collapsedModelProviders', setUi('collapsedModelProviders'), { autoSave: false }) }),
  recentModels: field<ModelRef[]>({ scope: 'profile', parse: parseModelRefs(16), ui: uiStore('recentModels', setUi('recentModels'), { autoSave: false }) }),
  recentAgents: field({ scope: 'profile', parse: parseStringSet, ui: uiStore('recentAgents', setUi('recentAgents'), { autoSave: false }) }),
  recentEfforts: field({ scope: 'profile', parse: parseRecentEfforts, ui: uiStore('recentEfforts', setUi('recentEfforts'), { autoSave: false }) }),
  providerOrder: field({ scope: 'profile', parse: parseStringSet, ui: uiStore('providerOrder', (v) => useUIStore.getState().setProviderOrder(v)) }),

  // ── Sessions and summaries (profile) ──
  sessionRecapEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('sessionRecapEnabled', (v) => useUIStore.getState().setSessionRecapEnabled(v)) }),
  sessionSuggestionEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('sessionSuggestionEnabled', (v) => useUIStore.getState().setSessionSuggestionEnabled(v)) }),
  sessionGoalEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('sessionGoalEnabled', (v) => useUIStore.getState().setSessionGoalEnabled(v)) }),
  sessionGoalDefaultBudgetEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('sessionGoalDefaultBudgetEnabled', (v) => useUIStore.getState().setSessionGoalDefaultBudgetEnabled(v)) }),
  sessionGoalDefaultBudget: field({ scope: 'profile', parse: parsePositiveInteger, ui: uiStore('sessionGoalDefaultBudget', (v) => useUIStore.getState().setSessionGoalDefaultBudget(v)) }),
  summarizeLastMessage: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('summarizeLastMessage', (v) => useUIStore.getState().setSummarizeLastMessage(v)) }),
  summaryThreshold: field({ scope: 'profile', parse: parseIntegerAtLeast(0), ui: uiStore('summaryThreshold', (v) => useUIStore.getState().setSummaryThreshold(v)) }),
  summaryLength: field({ scope: 'profile', parse: parseIntegerAtLeast(10), ui: uiStore('summaryLength', (v) => useUIStore.getState().setSummaryLength(v)) }),
  maxLastMessageLength: field({ scope: 'profile', parse: parseIntegerAtLeast(10), ui: uiStore('maxLastMessageLength', (v) => useUIStore.getState().setMaxLastMessageLength(v)) }),
  showDeletionDialog: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showDeletionDialog', (v) => useUIStore.getState().setShowDeletionDialog(v)) }),

  // ── Notifications (profile) ──
  nativeNotificationsEnabled: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('nativeNotificationsEnabled', (v) => useUIStore.getState().setNativeNotificationsEnabled(v)) }),
  notificationMode: field({ scope: 'profile', parse: parseOneOf(['always', 'hidden-only']), ui: uiStore('notificationMode', (v) => useUIStore.getState().setNotificationMode(v)) }),
  notifyOnSubtasks: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('notifyOnSubtasks', (v) => useUIStore.getState().setNotifyOnSubtasks(v)) }),
  notifyOnCompletion: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('notifyOnCompletion', (v) => useUIStore.getState().setNotifyOnCompletion(v)) }),
  notifyOnError: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('notifyOnError', (v) => useUIStore.getState().setNotifyOnError(v)) }),
  notifyOnQuestion: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('notifyOnQuestion', (v) => useUIStore.getState().setNotifyOnQuestion(v)) }),
  notificationTemplates: field<NotificationTemplates>({
    scope: 'profile',
    parse: parseNotificationTemplates,
    ui: uiStore('notificationTemplates', (v) => useUIStore.getState().setNotificationTemplates(v)),
  }),
  showOpenCodeUpdateNotifications: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('showOpenCodeUpdateNotifications', (v) => useUIStore.getState().setShowOpenCodeUpdateNotifications(v)) }),
  reportUsage: field({ scope: 'profile', parse: parseBoolean, ui: uiStore('reportUsage', (v) => useUIStore.getState().setReportUsage(v)) }),

  // ── Usage page (profile; the page reads and writes these itself) ──
  usageDisplayMode: field({ scope: 'profile', parse: parseOneOf(['usage', 'remaining']) }),
  usageDropdownProviders: field({ scope: 'profile', parse: parseStringList }),
  usageSelectedModels: field({ scope: 'profile', parse: parseStringRecordOfStringLists }),
  usageCollapsedFamilies: field({ scope: 'profile', parse: parseStringRecordOfStringLists }),
  usageExpandedFamilies: field({ scope: 'profile', parse: parseStringRecordOfStringLists }),
  usageModelGroups: field<UsageModelGroups>({ scope: 'profile', parse: parseUsageModelGroups }),

  // ── Behavior (profile) ──
  globalBehaviorPrompt: field({ scope: 'profile', parse: parseTextUpTo(1024 * 1024) }),
  responseStyleEnabled: field({ scope: 'profile', parse: parseBoolean }),
  responseStylePreset: field({ scope: 'profile', parse: parseOneOf(RESPONSE_STYLE_PRESETS) }),
  responseStyleCustomInstructions: field({ scope: 'profile', parse: parseTextUpTo(50_000) }),
  optimizeSystemPrompt: field({ scope: 'profile', parse: parseBoolean }),

  // The server serves the PWA manifest from these, so they are facts about
  // the instance even though only the installed web app shows them.
  pwaAppName: field({ scope: 'instance', surfaces: ['web'], parse: parsePwaAppName }),
  pwaOrientation: field({ scope: 'instance', surfaces: ['web'], parse: parseOneOf(['system', 'portrait', 'landscape']) }),

  // ── Device fields: never written to the server; an old settings.json that
  // still carries one is read once as a seed for the local store. ──
  mobileKeyboardMode: field({
    scope: 'device',
    surfaces: ['mobile'],
    parse: parseMobileKeyboardModeValue,
    ui: uiStore('mobileKeyboardMode', (v) => useUIStore.getState().setMobileKeyboardMode(v)),
  }),
  desktopWindowControlsPosition: field<DesktopWindowControlsPosition>({
    scope: 'device',
    surfaces: ['desktop'],
    parse: parseDesktopWindowControlsPosition,
    ui: uiStore('desktopWindowControlsPosition', (v) => useUIStore.getState().setDesktopWindowControlsPosition(v)),
  }),
  desktopWindowControlsStyle: field<DesktopWindowControlsStyle>({
    scope: 'device',
    surfaces: ['desktop'],
    parse: parseOneOf(['classic', 'traffic-lights']),
    ui: uiStore('desktopWindowControlsStyle', (v) => useUIStore.getState().setDesktopWindowControlsStyle(v)),
  }),
  inputBarOffset: field({ scope: 'device', surfaces: ['mobile', 'web'], parse: parseFiniteNumber, ui: uiStore('inputBarOffset', (v) => useUIStore.getState().setInputBarOffset(v)) }),
} as const;

export type SettingsKey = keyof typeof SETTINGS_REGISTRY;

type FieldValue<S> = S extends SettingsFieldSpec<infer T> ? T : never;

/** The shared settings document as every client sees it: every registry key, optional. */
export type DesktopSettings = { -readonly [K in SettingsKey]?: FieldValue<(typeof SETTINGS_REGISTRY)[K]> };

/**
 * Device state that only ever lived in `useUIStore`'s persisted slice. Listed
 * so the registry accounts for every persisted key; none of these crosses the
 * wire, so they carry no parser. `globalDraftStarters` is the store's name for
 * the `draftStarters` field and is therefore not here.
 */
export const LOCAL_DEVICE_KEYS = [
  'theme',
  'isSidebarOpen',
  'sidebarWidth',
  'contextPanelByDirectory',
  'contextRailOrder',
  'contextRailHiddenSurfaces',
  'contextEditorTreeVisible',
  'contextEditorTreeWidth',
  'notesPanelHeight',
  'workStatusExpandedSections',
  'workStatusScrollTop',
  'isSessionSwitcherOpen',
  'sidebarSection',
  'settingsPage',
  'settingsHasOpenedOnce',
  'settingsProjectsSelectedId',
  'settingsRemoteInstancesSelectedId',
  'isSessionCreateDialogOpen',
  'autoDeleteLastRunAt',
  'messageLimit',
  'walkthroughTocWidth',
  'linearIssueListStatus',
  'linearIssueListAssignee',
  'linearIssueListTeamIdByRuntime',
  'linearIssueListPriority',
  'showTerminalQuickKeysOnDesktop',
  'dockBadgeEnabled',
  'alwaysShowScrollbars',
  'agentMemoryViewedAt',
  'projectContextSidebarWidth',
] as const;

/**
 * Instance facts the Electron main process writes straight into
 * `settings.json` (`mutateSettingsRoot`). The server keeps them when merging
 * and never accepts them from a client; no client reads them.
 * `desktopSplashColors` arrives over the window-theme IPC and replaces the
 * flat `splash*` keys older builds wrote through the settings document.
 */
export const DESKTOP_SHELL_KEYS = [
  'desktopSplashColors',
  'desktopHosts',
  'desktopDefaultHostId',
  'desktopInstallId',
  'desktopLocalPort',
  'desktopSshInstances',
  'desktopWindowState',
] as const;

const isSettingsKey = (key: string): key is SettingsKey => Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key);

export const SETTINGS_KEYS: SettingsKey[] = Object.keys(SETTINGS_REGISTRY).filter(isSettingsKey);

/** Keys whose value belongs to this install and therefore never goes to the server. */
export const isDeviceSettingsKey = (key: SettingsKey): boolean => SETTINGS_REGISTRY[key].scope === 'device';

type SettingsValue = DesktopSettings[SettingsKey];

/** The erased view the generic loops iterate; assignable because the bindings use method syntax. */
const specOf = (key: SettingsKey): SettingsFieldSpec<SettingsValue> => SETTINGS_REGISTRY[key];

/** Keys the client may send to the server: not computed, not this install's device state. */
export const isWritableSettingsKey = (key: SettingsKey): boolean => !SETTINGS_REGISTRY[key].computed && !isDeviceSettingsKey(key);

/**
 * Parse an untrusted document (server response, bridge payload) into the
 * trusted shape. Keys not in the registry are dropped; a value a parser rejects
 * is dropped as if absent — never replaced by a default.
 */
const rawDocumentSchema = z.record(z.string(), z.unknown());

export const parseSettingsDocument = (payload: unknown): DesktopSettings | null => {
  const document = rawDocumentSchema.safeParse(payload);
  if (!document.success) {
    return null;
  }
  const raw = document.data;
  const result: DesktopSettings = {};
  for (const key of SETTINGS_KEYS) {
    const spec = specOf(key);
    const parsed = spec.parse(raw[key], raw);
    if (parsed !== undefined) {
      Object.assign(result, { [key]: parsed });
    }
  }
  return result;
};

const isSameValue = (left: SettingsValue, right: SettingsValue): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * Copy the fields a snapshot carries into their live stores. A field the
 * snapshot omits is left alone ("missing is not default"); a field whose
 * store already holds the value is not written again.
 */
export const applySettingsToStores = (snapshot: DesktopSettings): void => {
  for (const key of SETTINGS_KEYS) {
    const spec = specOf(key);
    if (!spec.ui) continue;
    const value = snapshot[key];
    if (value === undefined) continue;
    if (isSameValue(spec.ui.read(), value)) continue;
    spec.ui.write(value, snapshot);
  }
};

/** Keys whose backing store the auto-save watches. */
export const AUTO_SAVE_KEYS = SETTINGS_KEYS.filter((key) => {
  const spec = specOf(key);
  return spec.ui?.autoSave === true;
});

/** Current store values for the auto-saved keys (undefined for unset). */
export const readAutoSaveSnapshot = (): DesktopSettings => {
  const snapshot: DesktopSettings = {};
  for (const key of AUTO_SAVE_KEYS) {
    const spec = specOf(key);
    const value = spec.ui?.read();
    if (value !== undefined) Object.assign(snapshot, { [key]: value });
  }
  return snapshot;
};

/** Keys the per-runtime browser mirror carries: everything the server owns for the user, minus secrets and computed flags. */
export const MIRRORED_KEYS = SETTINGS_KEYS.filter((key) => {
  const spec = specOf(key);
  return spec.scope !== 'device' && !spec.secret && !spec.computed;
});

/** Shape of one field in the generated JSON snapshot the server and the VS Code bridge consume. */
export type SettingsRegistrySnapshotField = {
  scope: SettingsScope;
  perSurface?: true;
  surfaces?: readonly SettingsSurface[];
  adopt?: 'bootstrap-only';
  derived?: true;
  secret?: true;
  computed?: true;
  /** Lives only in the local store; never crosses the wire. */
  local?: true;
  /** Written by the desktop shell straight into the file; never by a client. */
  owner?: 'desktop-shell';
};

export type SettingsRegistrySnapshot = {
  version: 1;
  fields: Record<string, SettingsRegistrySnapshotField>;
};

export const buildSettingsRegistrySnapshot = (): SettingsRegistrySnapshot => {
  const fields: Record<string, SettingsRegistrySnapshotField> = {};
  for (const key of SETTINGS_KEYS) {
    const spec = specOf(key);
    const entry: SettingsRegistrySnapshotField = { scope: spec.scope };
    if (spec.perSurface) entry.perSurface = true;
    if (spec.surfaces) entry.surfaces = spec.surfaces;
    if (spec.adopt) entry.adopt = spec.adopt;
    if (spec.derived) entry.derived = true;
    if (spec.secret) entry.secret = true;
    if (spec.computed) entry.computed = true;
    fields[key] = entry;
  }
  for (const key of LOCAL_DEVICE_KEYS) {
    fields[key] = { scope: 'device', local: true };
  }
  for (const key of DESKTOP_SHELL_KEYS) {
    fields[key] = { scope: 'instance', owner: 'desktop-shell', surfaces: ['desktop'] };
  }
  return { version: 1, fields };
};
