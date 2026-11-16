export const normalizeGitOutputPath = (value, platform = process.platform) => {
  if (platform !== 'win32') return value;
  return value.replace(/^\/([a-z])(?:\/|$)/i, (_, drive) => `${drive.toUpperCase()}:/`);
};
