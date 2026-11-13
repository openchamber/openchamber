import { z } from 'zod';
import { MAX_CONCURRENT_STATUS_READS } from './status-limits.js';

const requestSchema = z.object({
  directories: z.array(z.string().trim().min(1)).min(1).max(200),
  mode: z.literal('light').optional(),
});

// Each completed directory is independently authoritative. Disconnecting stops
// admission; already running reads remain owned by the shared Git service.
export function registerGitStatusBatchRoute(app, readDirectory) {
  app.post('/api/git/status/batch', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Expected 1 to 200 directories and an optional light mode' });
    const directories = [...new Set(parsed.data.directories)];
    let closed = false;
    let next = 0;
    const onClose = () => { closed = true; };
    res.on('close', onClose);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const worker = async () => {
      while (!closed && next < directories.length) {
        const directory = directories[next++];
        let entry;
        try {
          entry = { directory, ...await readDirectory(directory, parsed.data.mode) };
        } catch (error) {
          entry = { directory, error: error.message || 'Git status failed', code: error.code ?? null };
        }
        if (closed) return;
        if (!res.write(`${JSON.stringify(entry)}\n`)) {
          await new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_STATUS_READS, directories.length) }, worker));
      if (!closed) res.end();
    } finally {
      res.off('close', onClose);
    }
  });
}
