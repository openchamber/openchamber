export const shouldUseLinuxTransparency = ({ platform, frameless, requested }) => (
  platform === 'linux' && frameless && requested === '1'
);
