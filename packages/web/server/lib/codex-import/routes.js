const statusForError = (error) => error?.code === 'ENOENT' ? 503 : 500;

const messageForError = (error, fallback) => error instanceof Error && error.message ? error.message : fallback;

export const registerCodexImportRoutes = (app, { codexImportRuntime }) => {
  app.post('/api/import/codex/inspect', async (_req, res) => {
    try {
      return res.json(await codexImportRuntime.inspect());
    } catch (error) {
      return res.status(statusForError(error)).json({
        error: messageForError(error, 'Failed to inspect Codex data'),
      });
    }
  });

  app.post('/api/import/codex/apply', async (req, res) => {
    try {
      return res.json(await codexImportRuntime.apply({
        threadIds: req.body?.threadIds,
        projectPaths: req.body?.projectPaths,
      }));
    } catch (error) {
      return res.status(statusForError(error)).json({
        error: messageForError(error, 'Failed to import Codex data'),
      });
    }
  });
};
