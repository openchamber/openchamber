export const getVisiblePermissionPatterns = (patterns: string[], renderedCommand: string): string[] => {
  if (!renderedCommand) return patterns;
  const rendered = new Set(renderedCommand.split('\n'));
  return patterns.filter((pattern) => !rendered.has(pattern));
};
