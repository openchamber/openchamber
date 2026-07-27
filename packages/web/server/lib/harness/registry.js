/**
 * Harness (engine) descriptors and capability matrix.
 * User-facing copy uses "Engine"; internal IDs use harnessId.
 */

/** @typedef {'opencode' | 'claude-code'} HarnessId */
/** @typedef {'full' | 'partial' | 'none'} CapabilityLevel */
/** @typedef {'ready' | 'needs-login' | 'missing-cli' | 'unsupported-host' | 'error'} HarnessRuntimeStatus */

/** @type {readonly HarnessId[]} */
export const HARNESS_IDS = Object.freeze(['opencode', 'claude-code']);

/** @type {readonly string[]} */
export const HARNESS_CAPABILITIES = Object.freeze([
  'prompt',
  'abort',
  'resume',
  'streaming-text',
  'streaming-tools',
  'permissions',
  'images',
  'file-attachments',
  'shell',
  'slash-commands',
  'mcp',
  'subagents',
  'multirun',
  'goal',
  'openchamber-tool',
]);

const OPENCODE_CAPABILITIES = Object.freeze({
  prompt: 'full',
  abort: 'full',
  resume: 'full',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  permissions: 'full',
  images: 'full',
  'file-attachments': 'full',
  shell: 'full',
  'slash-commands': 'full',
  mcp: 'full',
  subagents: 'full',
  multirun: 'full',
  goal: 'full',
  'openchamber-tool': 'full',
});

const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  prompt: 'full',
  abort: 'full',
  resume: 'full',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  // canUseTool ↔ permission.asked/replied with Always patterns, tool call
  // linkage, fail-closed timeout/abort, and agent-derived permissionMode.
  permissions: 'full',
  images: 'full',
  // data: embeds + sandboxed file:// / project-path attachments (images,
  // text-like, PDF); opaque binaries reject with named errors.
  'file-attachments': 'full',
  shell: 'full',
  // Claude-native slash/skills via prompt text + system/init discovery;
  // OpenCode-only commands stay blocked in the UI send path.
  'slash-commands': 'full',
  // OpenChamber MCP configs bridged into SDK mcpServers; project .mcp.json
  // still loads via settingSources; status from system/init.
  mcp: 'full',
  // Agent tool + forwardSubagentText → nested child sessions in the sidebar.
  subagents: 'full',
  // MultiRun launches Claude sessions through the shared UI shell + harness
  // prompt path (ExecutionTarget sticky bindings), same as OpenCode runs.
  multirun: 'full',
  // Goal loop uses harness turn snapshots + /api/harness/prompt continuations
  // with Claude usage mapped into assistant.info.tokens for budget accounting.
  goal: 'full',
  // Injected via Claude Agent SDK createSdkMcpServer → shared control service.
  'openchamber-tool': 'full',
});

/** Current Anthropic API resolutions for Claude Code aliases (Fable/Opus/Sonnet 5). */
const CLAUDE_MODEL_LIMIT_1M = Object.freeze({ context: 1_000_000, output: 128_000 });
/** Haiku 4.5 (and older Claude 4.5-era models) still use a 200K window. */
const CLAUDE_MODEL_LIMIT_200K = Object.freeze({ context: 200_000, output: 64_000 });
const CLAUDE_MODEL_MODALITIES = Object.freeze({
  input: Object.freeze(['text', 'image']),
  output: Object.freeze(['text']),
});

/**
 * @param {{
 *   id: string,
 *   name: string,
 *   limit: Readonly<{ context: number, output: number }>,
 *   resolvedId?: string,
 * }} entry
 */
function buildClaudeModel(entry) {
  const model = {
    id: entry.id,
    name: entry.name,
    supportsImages: true,
    supportsDocuments: true,
    reasoning: true,
    toolCall: true,
    limit: entry.limit,
    modalities: CLAUDE_MODEL_MODALITIES,
  };
  if (entry.resolvedId) model.resolvedId = entry.resolvedId;
  return Object.freeze(model);
}

/**
 * Claude Code model source rows for v1 (no provider nesting). Alias rows use
 * current Anthropic API resolutions; pinned full IDs keep older versions
 * selectable after aliases move forward.
 */
const CLAUDE_CODE_ALIAS_MODELS = Object.freeze([
  buildClaudeModel({ id: 'fable', name: 'Fable 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'opus', name: 'Opus 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'sonnet', name: 'Sonnet 5', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({
    id: 'haiku',
    name: 'Haiku 4.5',
    resolvedId: 'claude-haiku-4-5',
    limit: CLAUDE_MODEL_LIMIT_200K,
  }),
]);

const CLAUDE_CODE_PINNED_MODELS = Object.freeze([
  buildClaudeModel({ id: 'claude-opus-4-8', name: 'Opus 4.8', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', limit: CLAUDE_MODEL_LIMIT_1M }),
  buildClaudeModel({ id: 'claude-haiku-4-5', name: 'Haiku 4.5', limit: CLAUDE_MODEL_LIMIT_200K }),
]);

/**
 * @returns {ReadonlyArray<ReturnType<typeof buildClaudeModel>>}
 */
function buildClaudeCodeModels() {
  const aliasResolvedIds = new Set(
    CLAUDE_CODE_ALIAS_MODELS
      .map((model) => model.resolvedId)
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const aliasNames = new Set(CLAUDE_CODE_ALIAS_MODELS.map((model) => model.name));
  const visiblePins = CLAUDE_CODE_PINNED_MODELS.filter((model) => (
    !aliasResolvedIds.has(model.id) && !aliasNames.has(model.name)
  ));

  return Object.freeze([
    ...CLAUDE_CODE_ALIAS_MODELS,
    ...visiblePins,
  ]);
}

/** Visible Claude Code model catalog for picker/API responses. */
export const CLAUDE_CODE_MODELS = buildClaudeCodeModels();

/** Named Claude Agent SDK effort levels accepted on ExecutionTarget. */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * @param {unknown} value
 * @returns {value is typeof CLAUDE_EFFORT_LEVELS[number]}
 */
export function isClaudeEffort(value) {
  return typeof value === 'string' && CLAUDE_EFFORT_LEVELS.includes(value);
}

const DESCRIPTORS = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode',
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    auth: Object.freeze({ mode: 'opencode-providers' }),
    capabilities: OPENCODE_CAPABILITIES,
    install: Object.freeze({
      binaryNames: Object.freeze([]),
      docsUrl: 'https://opencode.ai/docs',
    }),
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    displayName: 'Claude Code',
    shortName: 'Claude',
    auth: Object.freeze({ mode: 'subscription-cli' }),
    capabilities: CLAUDE_CODE_CAPABILITIES,
    install: Object.freeze({
      binaryNames: Object.freeze(['claude']),
      docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    }),
  }),
});

/**
 * @param {string} harnessId
 * @returns {boolean}
 */
export function isKnownHarnessId(harnessId) {
  return Object.prototype.hasOwnProperty.call(DESCRIPTORS, harnessId);
}

/**
 * @param {string} harnessId
 * @returns {typeof DESCRIPTORS[keyof typeof DESCRIPTORS] | null}
 */
export function getHarnessDescriptor(harnessId) {
  if (!isKnownHarnessId(harnessId)) return null;
  return DESCRIPTORS[harnessId];
}

/**
 * @returns {Array<typeof DESCRIPTORS[keyof typeof DESCRIPTORS]>}
 */
export function listHarnessDescriptors() {
  return HARNESS_IDS.map((id) => DESCRIPTORS[id]);
}

/**
 * @param {string} harnessId
 * @returns {typeof CLAUDE_CODE_CAPABILITIES | typeof OPENCODE_CAPABILITIES | null}
 */
export function getHarnessCapabilities(harnessId) {
  const descriptor = getHarnessDescriptor(harnessId);
  return descriptor ? descriptor.capabilities : null;
}
