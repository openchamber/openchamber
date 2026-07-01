import crypto from 'node:crypto';
import { BROWSER_TOOL_DEFINITIONS } from './tool-catalog.js';
import { BROWSER_MCP_HTTP_PATH } from './ensure-mcp-registration.js';

/**
 * Hand-rolled MCP server (JSON-RPC 2.0 over HTTP) at BROWSER_MCP_HTTP_PATH.
 *
 * Mounted OUTSIDE /api so it bypasses the UI-session guard (the OpenCode
 * subprocess has no cookie). It enforces its own gate instead: loopback-only AND
 * a constant-time match of the persisted per-install bearer token. tools/call is
 * forwarded into the runtime's dispatch(), where capability + consent policy is
 * enforced — this endpoint is pure transport.
 *
 * No @modelcontextprotocol/sdk dependency: the JSON-RPC surface is implemented
 * directly (initialize / tools/list / tools/call / ping).
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'openchamber-browser', version: '1.0.0' };
const JSON_LIMIT = '32mb';

const isLoopbackRequest = (req) => {
  const addr = (req.socket && req.socket.remoteAddress) || req.ip || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
};

const tokenMatches = (req, expected) => {
  if (!expected) return false;
  const header = req.headers && req.headers.authorization ? String(req.headers.authorization) : '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  try {
    return crypto.timingSafeEqual(provided, wanted);
  } catch {
    return false;
  }
};

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/** Shape a runtime dispatch envelope into an MCP tools/call result. */
const formatToolResult = (envelope) => {
  if (!envelope || envelope.ok !== true) {
    const code = envelope?.code || 'EXEC_ERROR';
    const message = envelope?.message || 'Browser command failed';
    return { content: [{ type: 'text', text: `Error [${code}]: ${message}` }], isError: true };
  }

  const value = envelope.value;
  const content = [];

  // Surface screenshots as image content when present.
  const img = value && typeof value === 'object' ? value : null;
  const base64 = img && (img.base64 || (typeof img.dataUrl === 'string' && img.dataUrl.includes(',') ? img.dataUrl.split(',')[1] : null));
  const mime = img && (img.mime || img.mimeType || (typeof img.dataUrl === 'string' && /^data:([^;]+)/.exec(img.dataUrl)?.[1]) || 'image/png');
  if (base64) {
    content.push({ type: 'image', data: base64, mimeType: mime });
  }

  content.push({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
  return { content };
};

export const registerBrowserMcpEndpoint = ({ app, express, dispatch, getBrowserMcpToken }) => {
  const handlePost = async (req, res) => {
    if (!isLoopbackRequest(req) || !tokenMatches(req, typeof getBrowserMcpToken === 'function' ? getBrowserMcpToken() : null)) {
      res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
      return;
    }

    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        responses.push(rpcError(msg && msg.id, -32600, 'Invalid Request'));
        continue;
      }

      const { id, method, params } = msg;
      const isNotification = id === undefined || id === null;

      try {
        if (method === 'initialize') {
          // Echo the client's requested protocol version when present, so clients
          // that strictly validate version negotiation accept the handshake.
          const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
          console.log(`[BrowserControl][MCP] initialize (protocol ${requested})`);
          responses.push(rpcResult(id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          }));
        } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
          // Notification — no response.
        } else if (method === 'ping') {
          responses.push(rpcResult(id, {}));
        } else if (method === 'tools/list') {
          responses.push(rpcResult(id, { tools: BROWSER_TOOL_DEFINITIONS }));
        } else if (method === 'tools/call') {
          const name = params && params.name;
          const args = (params && params.arguments) || {};
          if (typeof name !== 'string') {
            responses.push(rpcError(id, -32602, 'Invalid params: tool name required'));
          } else {
            const envelope = await dispatch(name, args, {});
            responses.push(rpcResult(id, formatToolResult(envelope)));
          }
        } else if (!isNotification) {
          responses.push(rpcError(id, -32601, `Method not found: ${method}`));
        }
      } catch (err) {
        if (!isNotification) {
          responses.push(rpcError(id, -32603, `Internal error: ${String(err && err.message ? err.message : err)}`));
        }
      }
    }

    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(Array.isArray(body) ? responses : responses[0]);
  };

  app.post(BROWSER_MCP_HTTP_PATH, express.json({ limit: JSON_LIMIT }), (req, res) => {
    void handlePost(req, res);
  });

  // Stateless server: we do not support the optional GET SSE stream.
  app.get(BROWSER_MCP_HTTP_PATH, (_req, res) => {
    res.status(405).json(rpcError(null, -32000, 'Method Not Allowed'));
  });
};
