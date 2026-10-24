/**
 * Database maintenance.
 *
 * `GET /api/openchamber/maintenance/database` answers the storage overview:
 * file sizes, SQLite page counters, whether OpenCode is running, the last
 * compaction result and any queued compaction.
 *
 * `POST /api/openchamber/maintenance/database/compact` answers `202` with the
 * running job. The rewrite continues in the background; poll the overview for
 * the phase. Refusals (external OpenCode, another compaction, no free pages,
 * not enough disk) answer `409` or `507` with `{ error, code }`.
 *
 * `POST /api/openchamber/maintenance/database/compact-on-next-restart` answers
 * `{ pendingOnNextRestart: true }`; the compaction runs before the managed
 * OpenCode spawns next.
 */
export const registerDatabaseMaintenanceRoutes = (app, { databaseMaintenance }) => {
  app.get('/api/openchamber/maintenance/database', async (_req, res) => {
    try {
      res.json(await databaseMaintenance.getOverview());
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Could not read the database state' });
    }
  });

  app.post('/api/openchamber/maintenance/database/compact', async (_req, res) => {
    try {
      const job = await databaseMaintenance.compactNow();
      res.status(202).json({ compaction: job });
    } catch (error) {
      res.status(error?.statusCode ?? 500).json({
        error: error?.message ?? 'Could not start the compaction',
        code: error?.code ?? 'error',
      });
    }
  });

  app.post('/api/openchamber/maintenance/database/compact-on-next-restart', async (_req, res) => {
    try {
      await databaseMaintenance.scheduleForNextRestart();
      res.json({ pendingOnNextRestart: true });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Could not schedule the compaction' });
    }
  });
};
