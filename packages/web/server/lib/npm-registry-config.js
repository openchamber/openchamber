const DEFAULT_NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * Resolve the npm registry base URL for direct package-metadata lookups.
 *
 * Honors the user's configured registry (`npm_config_registry`, which npm sets
 * for lifecycle scripts, or an explicit `NPM_CONFIG_REGISTRY`) and falls back to
 * the public npm registry. Resolved at call time so the current process
 * environment is always respected. Trailing slashes are trimmed so the result
 * concatenates with `/<package>` without producing a double slash.
 *
 * @returns {string}
 */
export function resolveNpmRegistryBase() {
  const configured = (process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || '').trim();
  if (!configured) {
    return DEFAULT_NPM_REGISTRY_BASE;
  }
  return configured.replace(/\/+$/, '') || DEFAULT_NPM_REGISTRY_BASE;
}
