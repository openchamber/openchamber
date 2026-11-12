import { isPermissionMode } from '../permission-auto-accept/modes.js';
import { isBoolean, isRecord, isString } from '../shared/guards.js';

// Additions require an explicit review of both the key and its nested shape.
export const AGENT_SETTINGS_MIRROR_VERSION = 1;
const BOOLEAN_KEYS_V1 = Object.freeze([
  'messageSearchEnabled', 'messageSearchReasoningEnabled',
  'agentControlToolEnabled', 'agentScheduleToolEnabled', 'agentWebToolEnabled', 'agentNotifyToolEnabled',
  'agentRenderToolEnabled', 'agentImageToolEnabled', 'agentSecretToolEnabled', 'agentToolsCodeMode',
  'agentMemoryToolEnabled', 'agentKnowledgeToolEnabled', 'agentWorkflowToolEnabled',
  'autoDeleteEnabled', 'sessionRetentionOnlyArchived', 'mergedWorktreeCleanupEnabled', 'worktreeArchiveOnDoneEnabled',
  'autoCreateWorktree', 'allowPromptingSubagentSessions', 'queueModeEnabled', 'smallModelUseDefault',
  'sessionRecapEnabled', 'sessionSuggestionEnabled', 'sessionWorkEnabled', 'sessionReviewOfferEnabled',
  'sessionGoalEnabled', 'sessionGoalDefaultBudgetEnabled', 'responseStyleEnabled',
]);
const STRING_KEYS_V1 = Object.freeze([
  'locale', 'lastDirectory', 'activeProjectId', 'opencodeBinary', 'permissionDefaultMode', 'browserProvider', 'agentImageModel',
  'sessionRetentionAction', 'terminalShell', 'defaultGitIdentityId', 'githubClientId', 'githubScopes', 'gitlabClientId',
  'defaultModel', 'defaultVariant', 'defaultAgent', 'smallModelOverride', 'smallModelVariant',
  'walkthroughModelOverride', 'walkthroughModelVariant', 'fallbackModel', 'fallbackVariant', 'zenModel',
  'lastSelectedModel', 'sessionGoalChecker', 'prStackConflictMode', 'globalBehaviorPrompt',
  'responseStylePreset', 'responseStyleCustomInstructions', 'inputHistoryScope', 'followUpBehavior',
]);
const NUMBER_KEYS_V1 = Object.freeze([
  'autoDeleteAfterDays', 'sessionGoalMaxAutoTurns', 'sessionGoalDefaultBudget', 'inputHistoryLimit', 'liveBrowserTabLimit',
]);
const STRING_ARRAY_KEYS_V1 = Object.freeze([
  'accountSwitchProviders', 'terminalLoginShells', 'favoriteAgents', 'recentAgents', 'providerOrder',
]);
// These are wire values the agent's sanitizer accepts as a clear or reset.
// Empty model strings become an own undefined property AFTER sanitization,
// which replaces the old value in the merge and removes it from both files.
const CLEAR_VALUES_V1 = Object.freeze({
  ...Object.fromEntries([
    'lastDirectory', 'opencodeBinary', 'defaultGitIdentityId', 'defaultModel', 'defaultVariant', 'defaultAgent',
    'smallModelOverride', 'smallModelVariant', 'walkthroughModelOverride', 'walkthroughModelVariant',
    'fallbackModel', 'fallbackVariant', 'zenModel', 'globalBehaviorPrompt', 'responseStyleCustomInstructions',
  ].map((key) => [key, ''])),
  ...Object.fromEntries([...STRING_ARRAY_KEYS_V1, 'projects', 'serverBrowserOpenChamberOrigins'].map((key) => [key, Object.freeze([])])),
  permissionDefaultMode: 'ask',
  prFixLoopDefaults: Object.freeze({}),
});
export const AGENT_SETTINGS_MIRROR_KEYS_V1 = Object.freeze([
  ...BOOLEAN_KEYS_V1, ...STRING_KEYS_V1, ...NUMBER_KEYS_V1, ...STRING_ARRAY_KEYS_V1,
  'projects', 'lastUsedEfforts', 'prFixLoopDefaults', 'serverBrowserOpenChamberOrigins',
]);

// The host installer imports this module from the unpacked package, before its dependencies exist:
// Node built-ins and this package's own files only.
const httpOrigins = (origins) => {
  const valid = Array.isArray(origins) && origins.length <= 256 && origins.every((origin) => {
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error('front_door_origins_invalid');
  return [...origins];
};
const pickFields = (source, keys, accepts) => Object.fromEntries(keys
  .filter((key) => Object.hasOwn(source, key) && accepts(source[key]))
  .map((key) => [key, source[key]]));
const strings = (value) => value.filter((entry) => isString(entry));

const projectOf = (value) => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.path)) return [];
  return [{
    ...pickFields(value, ['id', 'path', 'label', 'labelSource', 'defaultAgent', 'defaultModel', 'defaultVariant'], isString),
    ...pickFields(value, ['addedAt', 'lastOpenedAt'], Number.isFinite),
  }];
};

/** Reconstruct every object; neither raw project data nor unknown keys travel. */
export const pickAgentSettings = (settings) => {
  const source = isRecord(settings) ? settings : {};
  const picked = {
    ...pickFields(source, BOOLEAN_KEYS_V1, isBoolean),
    ...pickFields(source, STRING_KEYS_V1, isString),
    ...pickFields(source, NUMBER_KEYS_V1, Number.isFinite),
  };
  for (const key of STRING_ARRAY_KEYS_V1) {
    if (Array.isArray(source[key])) picked[key] = strings(source[key]);
  }
  if (Array.isArray(source.projects)) picked.projects = source.projects.flatMap(projectOf);
  if (!isPermissionMode(picked.permissionDefaultMode)) delete picked.permissionDefaultMode;
  if (isRecord(source.lastUsedEfforts)) {
    picked.lastUsedEfforts = Object.fromEntries(Object.entries(source.lastUsedEfforts)
      .filter(([, effort]) => isString(effort) || effort === null));
  }
  if (isRecord(source.prFixLoopDefaults)) {
    const config = source.prFixLoopDefaults;
    picked.prFixLoopDefaults = {
      ...pickFields(config, ['watch', 'ignoreSelf', 'ignoreBots', 'mentionOnly'], isBoolean),
      ...pickFields(config, ['maxIterations', 'tokenBudget'], Number.isFinite),
      ...pickFields(config, ['triggers', 'mentionText', 'pushMode'], isString),
    };
    if (config.tokenBudget === null) picked.prFixLoopDefaults.tokenBudget = null;
    for (const key of ['allowAuthors', 'blockAuthors']) {
      if (Array.isArray(config[key])) picked.prFixLoopDefaults[key] = strings(config[key]);
    }
  }
  return picked;
};

/**
 * Call start(ownerSnapshot) during boot before accepting settings mutations. `ownOrigins(settings)`
 * answers the front door's own origins: the agent's Server Browser refuses to open them.
 */
export const createSettingsMirror = ({ upstream, ownOrigins = async () => [], logger = console }) => {
  let pending = Promise.resolve();
  const enqueue = (operation) => {
    pending = pending.then(operation).catch(() => { logger.warn('agent_settings_mirror_failed'); });
    return pending;
  };
  const send = async (picked) => {
    // The response is agent-controlled and can never update the owner's file.
    await upstream.json('/api/config/settings', {
      method: 'PUT', body: JSON.stringify(picked), headers: { 'content-type': 'application/json', 'x-openchamber-settings-mirror': String(AGENT_SETTINGS_MIRROR_VERSION) },
    });
  };
  const onSettingsWritten = (settings) => {
    const picked = { ...structuredClone(CLEAR_VALUES_V1), ...pickAgentSettings(settings) };
    const snapshot = structuredClone(isRecord(settings) ? settings : {});
    // An origin list that cannot be made is a failed mirror, never a mirror without the refusal.
    return enqueue(async () => send({ ...picked, serverBrowserOpenChamberOrigins: httpOrigins(await ownOrigins(snapshot)) }));
  };
  return { start: onSettingsWritten, onSettingsWritten, flush: () => pending };
};
