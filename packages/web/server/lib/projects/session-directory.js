import fs from 'node:fs';
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

// A registered project on a hung mount must not hold the settings write queue.
const PROJECT_ASSESS_TIMEOUT_MS = 2000;

/** The root of the linked worktree holding `directory` (its `.git` is a pointer file), or null. */
const findLinkedWorktreeRoot = async (directory) => {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await fs.promises.lstat(path.join(current, '.git')).catch(() => null);
    if (info) return info.isFile() ? current : null;
    if (path.dirname(current) === current) return null;
  }
};

/** Register one session destination without changing any window's selection. */
export const registerSessionProjectRoutes = (app, {
  validateDirectoryPath, openCodeTrust, registerSessionProject, resolveSessionDirectory, emitWorktreeChanged,
  linkedWorktreeRoot = findLinkedWorktreeRoot,
}) => {
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
      let worktreeOf = null;
      const project = await registerSessionProject(async (projects) => {
        // Check again at the write boundary: the configuration can change
        // between answering the dialog and registering the destination.
        const { assessment, trusted } = await openCodeTrust.assess(directory, { fresh: true });
        if (!trusted) throw Object.assign(new Error('Folder trust is required'), { code: OPENCODE_TRUST_REQUIRED });
        const existing = projects.filter((entry) => contains(entry.path, directory))
          .sort((left, right) => right.path.length - left.path.length)[0];
        if (existing) return existing;
        // A linked worktree lives outside its repository's folder. It belongs
        // to the project that registered the repository; the client may not
        // have listed it yet when a session moves into it. A folder beside a
        // registered project in the same checkout shares the repository but is
        // no worktree that project lists, so it registers as its own project.
        const worktreeRoot = assessment.repositoryKey === assessment.directory ? null : await linkedWorktreeRoot(directory);
        if (worktreeRoot) {
          for (const entry of projects) {
            if (contains(worktreeRoot, entry.path)) continue;
            const projectAssessment = await Promise.race([
              openCodeTrust.assess(entry.path).then(({ assessment: found }) => found, () => null),
              new Promise((resolve) => { setTimeout(resolve, PROJECT_ASSESS_TIMEOUT_MS, null).unref?.(); }),
            ]);
            if (projectAssessment?.repositoryKey === assessment.repositoryKey) {
              worktreeOf = entry;
              return entry;
            }
          }
        }
        return { id: createProjectIdFromPath(directory), path: directory, label: path.basename(directory) || directory, addedAt: Date.now(), lastOpenedAt: Date.now() };
      });
      // Clients list the new worktree under its project on this event.
      if (worktreeOf) emitWorktreeChanged?.({ directories: [worktreeOf.path, directory], at: Date.now() });
      return res.json({ project });
    } catch (error) {
      if (error?.code === OPENCODE_TRUST_REQUIRED) {
        return res.status(403).json({ code: OPENCODE_TRUST_REQUIRED, directory: parsed.data.directory });
      }
      return res.status(503).json({ error: 'Session project could not be registered' });
    }
  });
};
