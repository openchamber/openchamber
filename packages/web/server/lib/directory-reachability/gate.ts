import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { RequestHandler } from '../shared/http-contracts.js';

import { DIRECTORY_UNREACHABLE, directoryReachability, directoryUnreachableError } from './index.js';

const PROJECT_DISK_ROUTES = /^\/(?:git|fs|config|terminal|walkthrough|environment|behavior|source-control|openchamber\/(?:sessions|workflows))(?:\/|$)/;
const ANSWERS_ITSELF = /^\/(?:git\/(?:projects|status\/batch|project-worktrees|network-operations|identities|global-identity)|fs\/(?:home|directory-stats?|exec\/[^/]+)|config\/(?:settings|themes)|openchamber\/sessions\/status)(?:\/|$)/;

const NAMES_ITS_OWN_FOLDER = /^\/fs\/mkdir\/?$/;

const fieldsSchema = z.object({ directory: z.unknown(), cwd: z.unknown(), path: z.unknown() }).partial().catch({});
const nameSchema = z.string().trim().min(1);

const namesOf = ({ directory, cwd, path: target }: z.output<typeof fieldsSchema>) => (
  [directory, cwd, target].flat().flatMap((value) => nameSchema.safeParse(value).data ?? [])
);

const expandHome = (directory: string) => directory.trim().replace(/^~(?=$|[\\/])/, () => os.homedir());

const headerDirectory = (value: string | undefined) => {
  if (!value) return [];
  try {
    return [decodeURIComponent(value)];
  } catch {
    return [value];
  }
};

export const directoryGate: RequestHandler = async (req, res, next) => {
  if (!PROJECT_DISK_ROUTES.test(req.path) || ANSWERS_ITSELF.test(req.path)) return next();
  try {
    const fields = [...namesOf(fieldsSchema.parse(req.query)), ...namesOf(fieldsSchema.parse(req.body))].map(expandHome);
    const target = NAMES_ITS_OWN_FOLDER.test(req.path) && fields.some((field) => path.isAbsolute(field));
    const named = target ? fields : [...headerDirectory(req.get('x-opencode-directory')).map(expandHome), ...fields];
    for (const directory of new Set(named)) {
      if (!path.isAbsolute(directory)) continue;
      if (await directoryReachability.check(directory) !== 'unreachable') continue;
      res.status(503).json({ error: directoryUnreachableError(directory).message, code: DIRECTORY_UNREACHABLE, directory });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
