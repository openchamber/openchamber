import path from 'node:path';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { OPENCODE_TRUST_REQUIRED } from '../opencode-trust/index.js';
import { isSpaceDirectory } from '../spaces/dispatcher.js';

const requestSchema = z.object({ sessionId: z.string().trim().min(1), directory: z.string().trim().min(1) });
const contains = (root, directory) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Register one session destination without changing any window's selection. */
export const registerSessionProjectRoutes = (app, { validateDirectoryPath, openCodeTrust, registerSessionProject, resolveSessionDirectory }) => {
  app.post('/api/projects/session-directory', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success || isSpaceDirectory(parsed.data.directory)) {
      return res.status(400).json({ error: 'A host session directory is required' });
    }
    try {
      const validated = await validateDirectoryPath(parsed.data.directory);
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const directory = validated.directory;
      if (await resolveSessionDirectory(parsed.data.sessionId) !== directory) {
        return res.status(409).json({ error: 'The session directory changed' });
      }
      // Finish one-time trust seeding before acquiring the settings write queue.
      await openCodeTrust.assess(directory, { fresh: true });
      const project = await registerSessionProject(async (projects) => {
        // Check again at the write boundary: the configuration can change
        // between answering the dialog and registering the destination.
        const { trusted } = await openCodeTrust.assess(directory, { fresh: true });
        if (!trusted) throw Object.assign(new Error('Folder trust is required'), { code: OPENCODE_TRUST_REQUIRED });
        const existing = projects.filter((entry) => contains(entry.path, directory))
          .sort((left, right) => right.path.length - left.path.length)[0];
        return existing ?? { id: createProjectIdFromPath(directory), path: directory, label: path.basename(directory) || directory, addedAt: Date.now(), lastOpenedAt: Date.now() };
      });
      return res.json({ project });
    } catch (error) {
      if (error?.code === OPENCODE_TRUST_REQUIRED) {
        return res.status(403).json({ code: OPENCODE_TRUST_REQUIRED, directory: parsed.data.directory });
      }
      return res.status(503).json({ error: 'Session project could not be registered' });
    }
  });
};
