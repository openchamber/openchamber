const PARTITION_PREFIX = 'openchamber-space-preview:';
const SPACE_ID = /^[0-9a-f]{12}$/;
const PREVIEW_HOSTNAME = 'openchamber-preview.localhost';

export const isSpaceId = (value) => SPACE_ID.test(String(value ?? ''));

export const spacePreviewPartition = (spaceId) => {
  if (!isSpaceId(spaceId)) throw new Error('A space id is required');
  return `${PARTITION_PREFIX}${spaceId}`;
};

export const spaceIdOfPreviewPartition = (partition) => {
  const name = String(partition ?? '');
  if (!name.startsWith(PARTITION_PREFIX)) return null;
  const spaceId = name.slice(PARTITION_PREFIX.length);
  return isSpaceId(spaceId) ? spaceId : null;
};

export const spacePreviewProxyConfig = ({ deadProxyPort, localPorts }) => {
  const port = Number.parseInt(String(deadProxyPort), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('A dead proxy port is required');
  const bypass = ['<-loopback>'];
  for (const value of localPorts ?? []) {
    const localPort = Number.parseInt(String(value), 10);
    if (Number.isInteger(localPort) && localPort > 0 && localPort <= 65535) bypass.push(`${PREVIEW_HOSTNAME}:${localPort}`);
  }
  return {
    proxyRules: `127.0.0.1:${port}`,
    proxyBypassRules: bypass.join(';'),
  };
};
