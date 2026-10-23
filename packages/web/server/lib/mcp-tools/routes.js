export const registerMcpToolRoutes = (app, { mcpToolsRuntime }) => {
  app.get('/api/projects/:projectId/mcp-tools', async (req, res) => {
    try {
      return res.json(await mcpToolsRuntime.getProjectTools(req.params.projectId));
    } catch (error) {
      return res.status(error?.statusCode ?? 502).json({ error: 'Unable to read project MCP tools' });
    }
  });
};
