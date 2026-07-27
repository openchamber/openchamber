import type { HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

/** Which agent definitions Claude Code sessions inherit. */
export type ClaudeAgentsMode = 'claude' | 'opencode';

export const CLAUDE_AGENTS_MODES: readonly ClaudeAgentsMode[] = ['claude', 'opencode'] as const;

export function isClaudeAgentsMode(value: unknown): value is ClaudeAgentsMode {
  return typeof value === 'string'
    && (CLAUDE_AGENTS_MODES as readonly string[]).includes(value);
}

export type EnginesSettingsFields = {
  enginesDefaultHarnessId: HarnessId;
  enginesClaudeCodeWarnOnOpenCodeHandoff: boolean;
  enginesClaudeCodeEnabled: boolean;
  /**
   * Claude Code agent source:
   * - `opencode` — OpenChamber/OpenCode agents drive permissionMode + system prompt append
   * - `claude` — native Claude Code agents / prompts / permission settings
   */
  enginesClaudeCodeAgentsMode: ClaudeAgentsMode;
};

export const ENGINES_SETTINGS_DEFAULTS: EnginesSettingsFields = {
  enginesDefaultHarnessId: 'opencode',
  enginesClaudeCodeWarnOnOpenCodeHandoff: true,
  enginesClaudeCodeEnabled: true,
  // Preserve documented v1 behavior: OpenCode agents derive Claude permissionMode.
  enginesClaudeCodeAgentsMode: 'opencode',
};

/** In-memory mirror of the handoff billing warn toggle for send-path gates. */
let cachedWarnOnOpenCodeHandoff: boolean =
  ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeWarnOnOpenCodeHandoff;

export function getCachedWarnOnOpenCodeHandoff(): boolean {
  return cachedWarnOnOpenCodeHandoff;
}

export function setCachedWarnOnOpenCodeHandoff(enabled: boolean): void {
  cachedWarnOnOpenCodeHandoff = enabled;
}

/** In-memory mirror for Claude send-path agent inheritance (no per-send settings fetch). */
let cachedClaudeAgentsMode: ClaudeAgentsMode =
  ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeAgentsMode;

export function getCachedClaudeAgentsMode(): ClaudeAgentsMode {
  return cachedClaudeAgentsMode;
}

export function setCachedClaudeAgentsMode(mode: ClaudeAgentsMode): void {
  cachedClaudeAgentsMode = mode;
}

export type SanitizedEnginesSettings = Partial<EnginesSettingsFields>;

/**
 * Sanitize persisted engines settings fields.
 * Invalid harness ids fall back to `opencode`. Wrong-typed fields are omitted.
 */
export function sanitizeEnginesSettings(candidate: Record<string, unknown>): SanitizedEnginesSettings {
  const result: SanitizedEnginesSettings = {};

  if (candidate.enginesDefaultHarnessId !== undefined) {
    result.enginesDefaultHarnessId = isHarnessId(candidate.enginesDefaultHarnessId)
      ? candidate.enginesDefaultHarnessId
      : ENGINES_SETTINGS_DEFAULTS.enginesDefaultHarnessId;
  }

  if (typeof candidate.enginesClaudeCodeWarnOnOpenCodeHandoff === 'boolean') {
    result.enginesClaudeCodeWarnOnOpenCodeHandoff = candidate.enginesClaudeCodeWarnOnOpenCodeHandoff;
  }

  if (typeof candidate.enginesClaudeCodeEnabled === 'boolean') {
    result.enginesClaudeCodeEnabled = candidate.enginesClaudeCodeEnabled;
  }

  if (candidate.enginesClaudeCodeAgentsMode !== undefined) {
    if (isClaudeAgentsMode(candidate.enginesClaudeCodeAgentsMode)) {
      result.enginesClaudeCodeAgentsMode = candidate.enginesClaudeCodeAgentsMode;
    } else {
      result.enginesClaudeCodeAgentsMode = ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeAgentsMode;
    }
  }

  return result;
}

/** Fill missing engines settings with product defaults. */
export function withEnginesSettingsDefaults(
  partial: SanitizedEnginesSettings | null | undefined,
): EnginesSettingsFields {
  return {
    enginesDefaultHarnessId: partial?.enginesDefaultHarnessId ?? ENGINES_SETTINGS_DEFAULTS.enginesDefaultHarnessId,
    enginesClaudeCodeWarnOnOpenCodeHandoff:
      partial?.enginesClaudeCodeWarnOnOpenCodeHandoff
      ?? ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeWarnOnOpenCodeHandoff,
    enginesClaudeCodeEnabled:
      partial?.enginesClaudeCodeEnabled ?? ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeEnabled,
    enginesClaudeCodeAgentsMode:
      partial?.enginesClaudeCodeAgentsMode ?? ENGINES_SETTINGS_DEFAULTS.enginesClaudeCodeAgentsMode,
  };
}
