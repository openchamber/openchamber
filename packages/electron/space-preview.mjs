/**
 * What a page from an isolated space may reach from the browser panel.
 *
 * A dev server inside a space serves whatever the agent wrote, and the panel
 * shows it on this machine. The page loads from a tunnel port of its own, so it
 * never runs under the app's origin, and it gets a session of its own, so it
 * holds no cookie of the app's or of any other previewed page. What is left is
 * where the page can send requests from here: the local API, which runs
 * without a password on the desktop, the user's own dev servers, anything on
 * the local network, and the internet. None of that is the space's. So the
 * space's session routes every request through a proxy that answers nothing,
 * and lets only the space's own tunnel ports go direct.
 *
 * The rules are text for `session.setProxy`; the live run in the stage's
 * evidence is what proves Chromium reads them as promised.
 */
const PARTITION_PREFIX = 'openchamber-space-preview:';
const SPACE_ID = /^[0-9a-f]{12}$/;
const PREVIEW_HOSTNAME = 'openchamber-preview.localhost';

export const isSpaceId = (value) => SPACE_ID.test(String(value ?? ''));

/** In memory only: the space is disposable, and so is whatever its pages stored here. */
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

/**
 * The proxy configuration of a space's session: everything to the dead proxy,
 * except the space's own tunnel ports. Manual rules, not a PAC script: Chromium
 * keeps its implicit bypass for loopback and `*.localhost` under a PAC script,
 * measured in a live run where the page still reached a port on this machine,
 * and only `<-loopback>` in manual bypass rules takes that bypass away. A
 * bypass entry may name a port, so each tunnel port is listed on its own. With
 * no port open nothing is reachable.
 */
export const spacePreviewProxyConfig = ({ deadProxyPort, localPorts }) => {
  const port = Number.parseInt(String(deadProxyPort), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('A dead proxy port is required');
  const bypass = ['<-loopback>'];
  for (const value of localPorts ?? []) {
    const localPort = Number.parseInt(String(value), 10);
    if (Number.isInteger(localPort) && localPort > 0 && localPort <= 65535) bypass.push(`${PREVIEW_HOSTNAME}:${localPort}`);
  }
  return {
    // No scheme in front: one proxy for http, https, ws and wss alike.
    proxyRules: `127.0.0.1:${port}`,
    proxyBypassRules: bypass.join(';'),
  };
};
