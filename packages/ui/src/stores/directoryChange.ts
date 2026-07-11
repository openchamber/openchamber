export const shouldApplyDirectoryChange = (currentDirectory: string, resolvedDirectory: string): boolean => (
  currentDirectory !== resolvedDirectory
);
