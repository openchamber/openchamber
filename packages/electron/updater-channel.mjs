export const resolveUpdaterChannel = ({ platform, architecture }) => (
  platform === 'win32' && architecture === 'arm64' ? 'latest-arm64' : null
);
