// MSYS2 Git reports drive paths such as /c/repos even when called from Node.
// Convert only Git's filesystem-path output, never repository-relative files.
export const normalizeGitOutputPath = (value, platform = process.platform) => {
  if (platform !== 'win32') return value;
  return value.replace(/^\/([a-z])(?:\/|$)/i, (_, drive) => `${drive.toUpperCase()}:/`);
};
