/**
 * Harness (engines) public exports.
 */

export {
  HARNESS_IDS,
  HARNESS_CAPABILITIES,
  CLAUDE_CODE_MODELS,
  CLAUDE_EFFORT_LEVELS,
  isClaudeEffort,
  isKnownHarnessId,
  getHarnessDescriptor,
  listHarnessDescriptors,
  getHarnessCapabilities,
} from './registry.js';

export {
  findBinaryOnPath,
  probeClaudeLogin,
  detectClaudeCode,
  detectOpenCode,
  detectHarness,
  detectAllHarnesses,
} from './detect.js';

export {
  getSessionBinding,
  bindSession,
  updateSessionBinding,
  setForeignSessionId,
  setBindingError,
  clearSessionBinding,
  resetSessionBindings,
  listSessionBindings,
  configureSessionBindings,
  initSessionBindings,
  flushSessionBindings,
  sanitizeSessionBinding,
  resolveSessionBindingsPath,
} from './session-bindings.js';

export {
  createCanUseTool,
  replyPermission,
  rejectPendingForSession,
  resetPendingPermissions,
  getPendingPermissionCount,
  listPendingPermissions,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from './translators/claude-code/permissions.js';

export {
  applyHarnessEventToSnapshot,
  getHarnessTurnSnapshot,
  getHarnessRecentMessages,
  isHarnessSessionWorking,
  listHarnessBusyStatuses,
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';

export { mergeHarnessBusyIntoSessionStatuses } from './session-status.js';
export { mergeHarnessMessagesIntoSessionMessages } from './session-messages.js';

export { createHarnessRouter } from './router.js';
export { registerHarnessRoutes } from './routes.js';
export { createClaudeCodeTranslator, buildClaudePrompt } from './translators/claude-code/index.js';
export { buildClaudeCodeChildEnv, API_PRIORITY_ENV_KEYS } from './translators/claude-code/auth-env.js';
export {
  mapAttachmentToContentBlock,
  mapAttachmentsToContentBlocks,
  isSupportedAttachmentMime,
} from './translators/claude-code/attachments.js';
export {
  loadClaudeAgentSdk,
  probeClaudeAgentSdk,
  startClaudeQuery,
  killProcessTree,
  resetClaudeAgentSdkCache,
} from './translators/claude-code/query.js';
export {
  mapClaudeMessageToEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
} from './events/from-claude.js';
export {
  emitHarnessEvent,
  emitHarnessEvents,
  addHarnessEventObserver,
  resetHarnessEventObservers,
} from './events/emit.js';
