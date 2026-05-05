export function registerAgentTerminalRoutes(app, agentTerminalService) {
  app.post('/api/terminal/agent/session', (req, res) => {
    const { readGrantToken } = req.body || {};
    if (!readGrantToken) {
      return res.status(400).json({ error: 'readGrantToken is required' });
    }

    const session = agentTerminalService.getAccessibleSession(readGrantToken);
    if (!session) {
      return res.status(403).json({ error: 'Invalid or expired read grant' });
    }

    res.json({ session });
  });

  app.post('/api/terminal/agent/read', (req, res) => {
    const { readGrantToken } = req.body || {};
    if (!readGrantToken) {
      return res.status(400).json({ error: 'readGrantToken is required' });
    }

    const output = agentTerminalService.readOutput(readGrantToken);
    if (output === null) {
      return res.status(403).json({ error: 'Invalid or expired read grant' });
    }

    res.json({ output });
  });

  app.post('/api/terminal/agent/write', (req, res) => {
    const { writeGrantToken, command } = req.body || {};
    if (!writeGrantToken) {
      return res.status(400).json({ error: 'writeGrantToken is required' });
    }

    const result = agentTerminalService.writeCommand(writeGrantToken, command);
    if (!result.success) {
      return res.status(403).json({ error: result.error });
    }

    res.json({ success: true, sessionId: result.sessionId, command: result.command });
  });

  app.post('/api/terminal/agent/grants/read', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const token = agentTerminalService.issueReadGrant(sessionId);
    if (!token) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    res.json({ token, sessionId, expiresIn: 5 * 60 });
  });

  app.post('/api/terminal/agent/grants/write', (req, res) => {
    const { sessionId, command } = req.body || {};
    if (!sessionId || !command) {
      return res.status(400).json({ error: 'sessionId and command are required' });
    }

    const token = agentTerminalService.issueWriteGrant(sessionId, command);
    if (!token) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    res.json({ token, sessionId, command, expiresIn: 60 });
  });

  app.delete('/api/terminal/agent/grants/read/:token', (req, res) => {
    const { token } = req.params;
    agentTerminalService.revokeReadGrant(token);
    res.json({ success: true });
  });

  app.delete('/api/terminal/agent/grants/write/:token', (req, res) => {
    const { token } = req.params;
    agentTerminalService.revokeWriteGrant(token);
    res.json({ success: true });
  });
}
