const OPENCHAMBER_URL = process.env.OPENCHAMBER_URL || 'http://localhost:4096';
const READ_GRANT_TOKEN = process.env.OPENCHAMBER_TERMINAL_READ_TOKEN || '';
const WRITE_GRANT_TOKEN = process.env.OPENCHAMBER_TERMINAL_WRITE_TOKEN || '';

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

async function terminalSession() {
  if (!READ_GRANT_TOKEN) return null;
  const res = await fetch(`${OPENCHAMBER_URL}/api/terminal/agent/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readGrantToken: READ_GRANT_TOKEN }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.session || null;
}

async function terminalRead() {
  if (!READ_GRANT_TOKEN) return '';
  const res = await fetch(`${OPENCHAMBER_URL}/api/terminal/agent/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readGrantToken: READ_GRANT_TOKEN }),
  });
  if (!res.ok) return '';
  const data = await res.json();
  return data.output || '';
}

async function terminalExecute(command) {
  if (!WRITE_GRANT_TOKEN) {
    return { success: false, error: 'No write grant token configured' };
  }
  const res = await fetch(`${OPENCHAMBER_URL}/api/terminal/agent/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writeGrantToken: WRITE_GRANT_TOKEN, command }),
  });
  const data = await res.json();
  if (!res.ok) return { success: false, error: data.error || 'Unknown error' };
  return data;
}

const TOOLS = [
  {
    name: 'terminal_session',
    description: 'Get the accessible terminal session information. Requires a read grant token.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'terminal_read',
    description: 'Read recent output from the terminal session. Requires a read grant token.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'terminal_execute',
    description: 'Execute a command in the terminal session. Requires a write grant token for the specific command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'terminal_session': {
      const session = await terminalSession();
      return {
        content: [{ type: 'text', text: session ? JSON.stringify(session, null, 2) : '(no accessible session)' }],
      };
    }
    case 'terminal_read': {
      const output = await terminalRead();
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
      };
    }
    case 'terminal_execute': {
      const result = await terminalExecute(args.command);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

const buffer = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer.push(chunk);

  const joined = buffer.join('');
  const lines = joined.split('\n');
  buffer.length = 0;

  if (!joined.endsWith('\n') && lines.length > 0) {
    buffer.push(lines.pop());
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      continue;
    }

    handleRequest(request).catch(() => {});
  }
});

async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize': {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'openchamber-terminal', version: '1.0.0' },
      });
      break;
    }
    case 'notifications/initialized':
      break;
    case 'tools/list': {
      sendResponse(id, { tools: TOOLS });
      break;
    }
    case 'tools/call': {
      const { name, arguments: args } = params || {};
      try {
        const result = await handleToolCall(name, args || {});
        sendResponse(id, result);
      } catch (e) {
        sendError(id, -32000, e.message);
      }
      break;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}
