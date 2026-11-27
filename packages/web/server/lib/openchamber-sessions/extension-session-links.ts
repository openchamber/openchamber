import { requestedGuestCapabilities } from '@openchamber/sdk';
import { findInstalledGuest, hasGuestFrame } from '../guests/catalog.js';
import { extensionsPersistPath } from '../guests/persist.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { asNonEmptyString } from '../shared/guards.js';
import { holdsPath, projectPathInPrimaryCheckout, toPathKey } from './project-paths.js';
import { buildExtensionLinksPatch, parseExtensionLinkOperation } from './session-linked-issues.js';
import type { listWorktreeArchives, resolvePrimaryWorktreeRoot } from '../git/index.js';
import type { DirectoryValidation } from '../projects/contracts.js';
import type { SessionPayload } from './routes.js';
import type { MetadataDecider, SessionMetadata } from './session-metadata-store.js';

type Project = { path: string };

export const createExtensionSessionLinks = (deps: {
  dataDir: string | null | undefined;
  chatsRoot: string | null;
  readSession: (id: string) => Promise<{ time: { archived?: number | null }; location?: { directory?: string } } | null>;
  readProjects: () => Promise<Project[]>;
  validateDirectoryPath: (directory: string) => Promise<DirectoryValidation>;
  registeredProjectPathFor: (directory: string, projects: Project[]) => Promise<string | null>;
  listWorktreeArchives: typeof listWorktreeArchives;
  resolvePrimaryWorktreeRoot: typeof resolvePrimaryWorktreeRoot;
  updateMetadata: (id: string, decide: MetadataDecider, directory: string) => Promise<{ metadata: SessionMetadata | undefined }>;
}) => {
  const outside = () => new OpenChamberControlError('Session is not in this project.', 404);
  const isChat = (candidate: string) => deps.chatsRoot !== null && holdsPath(toPathKey(deps.chatsRoot), toPathKey(candidate));

  const archivedCheckoutProject = async (id: string, targetDirectory: string, frameProject: string, projects: Project[]) => {
    const [archives, primary] = await Promise.all([
      deps.listWorktreeArchives(frameProject).catch(() => []),
      deps.resolvePrimaryWorktreeRoot(frameProject).catch(() => null),
    ]);
    if (!primary) return null;
    const targetKey = toPathKey(targetDirectory);
    const matches = new Set(archives.flatMap((archive) => {
      const checkout = toPathKey(archive.path);
      if (!archive.sessionIds.includes(id) || !holdsPath(checkout, targetKey)) return [];
      return [projectPathInPrimaryCheckout(toPathKey(primary.root), targetKey.slice(checkout.length).replace(/^\/+/, ''), projects)];
    }));
    return matches.size === 1 ? [...matches][0] : null;
  };

  const assertSessionInFrameProject = async (id: string, frameDirectory: string) => {
    const target = await deps.readSession(id);
    const targetDirectory = target?.location?.directory;
    if (!target || !targetDirectory) throw outside();
    const projects = await deps.readProjects();
    const [frame, targetPath] = await Promise.all([
      deps.validateDirectoryPath(frameDirectory),
      deps.validateDirectoryPath(targetDirectory),
    ]);
    if (!frame.ok || isChat(frame.directory) || isChat(targetDirectory)) throw outside();
    const frameProject = await deps.registeredProjectPathFor(frame.directory, projects);
    if (!frameProject) throw outside();
    const targetProject = targetPath.ok
      ? !isChat(targetPath.directory) && await deps.registeredProjectPathFor(targetPath.directory, projects)
      : target.time.archived && await archivedCheckoutProject(id, targetDirectory, frameProject, projects);
    if (targetProject !== frameProject) throw outside();
  };

  return async (id: string, payload: SessionPayload) => {
    const parsed = parseExtensionLinkOperation(payload);
    if (!parsed.success) throw new OpenChamberControlError('Invalid extension link operation.', 400);
    if (!deps.dataDir) throw new OpenChamberControlError('Extension links are unavailable.', 503);
    const operation = parsed.data;
    const { id: guestId, storageId, frameDirectory } = operation.extension;
    const guest = await findInstalledGuest(guestId, extensionsPersistPath(deps.dataDir));
    if (!guest || guest.enabled === false || guest.storageId !== storageId || !hasGuestFrame(guest)
      || !requestedGuestCapabilities(guest).every((capability) => guest.capabilityGrants.includes(capability))) {
      throw new OpenChamberControlError('Extension is unavailable.', 403);
    }
    if (frameDirectory !== undefined) await assertSessionInFrameProject(id, frameDirectory);
    const directory = asNonEmptyString(payload.directory) || '';
    const { metadata } = await deps.updateMetadata(id, (current) => {
      const patch = buildExtensionLinksPatch(current, operation, { sessionId: id, storageId });
      if (!patch && operation.operation === 'unlink') {
        throw new OpenChamberControlError('No link from this extension matches that URL.', 404);
      }
      return patch;
    }, directory);
    return { metadata };
  };
};
