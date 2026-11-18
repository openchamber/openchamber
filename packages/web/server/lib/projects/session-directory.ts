import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { OPENCODE_TRUST_REQUIRED } from '../opencode-trust/index.js';
import { isSpaceDirectory } from '../spaces/dispatcher.js';
import type { Application } from '../shared/http-contracts.js';
import type { ConfigAssessment } from '../opencode-trust/contracts.js';
import type { SessionProject, SessionProjectDependencies } from './contracts.js';

interface WorktreeMatch {
  project: SessionProject | null;
}

const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'code' in value;

const requestSchema = z.object({ sessionId: z.string().trim().min(1), directory: z.string().trim().min(1) });
const contains = (root: string, directory: string) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const PROJECT_ASSESS_TIMEOUT_MS = 2000;

const findLinkedWorktreeRoot = async (directory: string) => {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await fs.promises.lstat(path.join(current, '.git')).catch(() => null);
    if (info) return info.isFile() ? current : null;
    if (path.dirname(current) === current) return null;
  }
};

export const registerSessionProjectRoutes = (app: Application, {
  validateDirectoryPath, openCodeTrust, registerSessionProject, resolveSessionDirectory, moveSession, emitWorktreeChanged,
  linkedWorktreeRoot = findLinkedWorktreeRoot,
}: SessionProjectDependencies) => {
  app.post('/api/projects/session-directory', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success || isSpaceDirectory(parsed.data.directory)) {
      return res.status(400).json({ error: 'A host session directory is required' });
    }
    try {
      const validated = await validateDirectoryPath(parsed.data.directory);
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const directory = validated.directory;
      const recorded = await resolveSessionDirectory(parsed.data.sessionId);
      const respelled = recorded !== directory;
      if (respelled && !(recorded && (await validateDirectoryPath(recorded)).directory === directory)) {
        return res.status(409).json({ error: 'The session directory changed' });
      }
      await openCodeTrust.assess(directory, { fresh: true });
      const worktreeMatch: WorktreeMatch = { project: null };
      const project = await registerSessionProject(async (projects) => {
        const { assessment, trusted } = await openCodeTrust.assess(directory, { fresh: true });
        if (!trusted) throw Object.assign(new Error('Folder trust is required'), { code: OPENCODE_TRUST_REQUIRED });
        const existing = projects.filter((entry) => contains(entry.path, directory))
          .sort((left, right) => right.path.length - left.path.length)[0];
        if (existing) return existing;
        const worktreeRoot = assessment.repositoryKey === assessment.directory ? null : await linkedWorktreeRoot(directory);
        if (worktreeRoot) {
          for (const entry of projects) {
            if (contains(worktreeRoot, entry.path)) continue;
            const projectAssessment = await Promise.race([
              openCodeTrust.assess(entry.path).then(({ assessment: found }) => found, () => null),
              new Promise<ConfigAssessment | null>((resolve) => { setTimeout(resolve, PROJECT_ASSESS_TIMEOUT_MS, null).unref?.(); }),
            ]);
            if (projectAssessment?.repositoryKey === assessment.repositoryKey) {
              worktreeMatch.project = entry;
              return entry;
            }
          }
        }
        return { id: createProjectIdFromPath(directory), path: directory, label: path.basename(directory) || directory, addedAt: Date.now(), lastOpenedAt: Date.now() };
      });
      if (respelled) {
        if (await resolveSessionDirectory(parsed.data.sessionId) !== recorded) {
          return res.status(409).json({ error: 'The session directory changed' });
        }
        await moveSession(parsed.data.sessionId, directory);
      }
      if (worktreeMatch.project) emitWorktreeChanged?.({ directories: [worktreeMatch.project.path, directory], at: Date.now() });
      return res.json({ project, directory });
    } catch (error) {
      if (hasErrorCode(error) && error.code === OPENCODE_TRUST_REQUIRED) {
        return res.status(403).json({ code: OPENCODE_TRUST_REQUIRED, directory: parsed.data.directory });
      }
      return res.status(503).json({ error: 'Session project could not be registered' });
    }
  });
};
