import { WebSocket } from 'ws';

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_MESSAGE_BYTES = 64 * 1024 * 1024;

export const connectDevToolsWebSocket = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { maxPayload: MAX_PROTOCOL_MESSAGE_BYTES });
  const timer = setTimeout(() => { socket.terminate(); reject(new Error('timeout')); }, CONNECT_TIMEOUT_MS);
  timer.unref?.();
  socket.once('open', () => { clearTimeout(timer); resolve(socket); });
  socket.once('error', () => { clearTimeout(timer); reject(new Error('connection failed')); });
});

export const getDevToolsPageSocketUrl = (browserUrl, targetId) => {
  const url = new URL(browserUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('invalid endpoint');
  url.pathname = `/devtools/page/${encodeURIComponent(targetId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
};
