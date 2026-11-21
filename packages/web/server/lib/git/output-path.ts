export const normalizeGitOutputPath = (value: string, platform = process.platform) => {
  if (platform !== 'win32') return value;
  return value.replace(/^\/([a-z])(?:\/|$)/i, (_: string, drive: string) => `${drive.toUpperCase()}:/`);
};
