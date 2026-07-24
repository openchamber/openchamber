export const WORKSPACE_PLUGIN_PACKAGE = '@openchamber/opencode-container-workspace';

export function isWorkspacePluginSpec(spec, resolvedSpec = null) {
  return (Boolean(resolvedSpec) && spec === resolvedSpec)
    || spec === WORKSPACE_PLUGIN_PACKAGE
    || (typeof spec === 'string' && spec.includes('opencode-container-workspace'));
}

export function isWorkspacePluginEntry(entry, resolvedSpec = null) {
  return isWorkspacePluginSpec(entry?.spec, resolvedSpec);
}
