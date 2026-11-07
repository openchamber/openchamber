export function normalizeConversationProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return (normalized || '/').toLocaleLowerCase();
}

export function matchesConversationProjectScope(scope: string, projectPath: string, projectLabel?: string): boolean {
  const normalizedScope = normalizeConversationProjectPath(scope);
  const fallbackLabel = projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;
  return normalizedScope === normalizeConversationProjectPath(projectPath)
    || (projectLabel ?? fallbackLabel).trim().toLocaleLowerCase() === scope.trim().toLocaleLowerCase();
}
