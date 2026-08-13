/**
 * Applies the user's explicit Small Model override (Settings → Chat → Small
 * Model) to the configuration injected into the managed OpenCode process.
 *
 * OpenCode's own session-title and summary generation reads `small_model`
 * from its config layers. Previously the OpenChamber settings override only
 * fed OpenChamber's own `/api/small-model/generate` utility service, so a
 * configured Small Model never reached OpenCode's title generation and
 * sessions kept their fallback/untitled state. Injecting the override as
 * `small_model` in the managed `OPENCODE_CONFIG_CONTENT` closes that gap for
 * the managed server.
 *
 * Only an explicit override applies (`smallModelUseDefault === false` with a
 * non-empty `smallModelOverride`). "Use default" leaves the config untouched,
 * so OpenCode's own resolution chain (config `small_model`, then its family
 * scan) stays authoritative — this mirrors the precedence documented in
 * `packages/web/server/lib/small-model/DOCUMENTATION.md`.
 *
 * Malformed user config is left untouched rather than rewritten: OpenCode's
 * own loader is the right place to surface it, and silently rewriting it
 * would hide the error.
 */
export const applySmallModelOverrideToOpenCodeConfig = ({
  configContent,
  smallModelUseDefault,
  smallModelOverride,
}) => {
  if (smallModelUseDefault !== false) {
    return configContent;
  }
  const override = typeof smallModelOverride === 'string' ? smallModelOverride.trim() : '';
  if (!override) {
    return configContent;
  }

  const current = (() => {
    if (typeof configContent !== 'string' || configContent.trim().length === 0) {
      return {};
    }
    try {
      return JSON.parse(configContent);
    } catch {
      return null;
    }
  })();
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return configContent;
  }

  return JSON.stringify({ ...current, small_model: override });
};
