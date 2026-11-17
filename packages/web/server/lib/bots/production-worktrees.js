/** Wiring: createProductionBotWorktrees({ dataDir, context, readItem,
 * disposeInstance?, advanceCheckout? }) implements runtime-contract worktrees.
 * context is createBotServiceContext's server-only result. readItem(projectId,
 * itemId) must return the authoritative complete item for cleanup admission.
 * adoptIsolated({ project, bot, item, resultSha, spaceId?, association? }) -> { headSha }. Call only
 * with exportSnapshot's host-promoted result, after matching its repository
 * to item.worktree. Retrying the same durable adoption reconciles locally.
 * resolveTransferSource(source, { trustedMigrationPath }?) returns the checked Bot-owned directory after
 * its caller verifies parent registration and canonical project identity.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addDetachedWorktree, getWorktrees, removeWorktree } from '../git/service.js';
import { resolveRepositoryIdentity } from '../source-control/repository-identity.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { configureBotWorktreeIdentity } from './services/git.js';
import { BotServiceError, branch as branchSchema, providerResult, sha, text } from './services/contracts.js';
import { advanceBotCheckout, botGit, createBotCheckoutGit, fetchBotCommit } from './production-git.js';
import { botMigrationPathSchema, parseSnapshotMetadata, sameBotMigrationPath, sameTransferSource, transferCaps, transferSourceSchema } from '../spaces/transfer-bundle.js';
export { botMigrationPathSchema, readTrustedBotMigrationPaths } from '../spaces/transfer-bundle.js';

const fail = (code) => { throw new BotServiceError(code, 'The bot checkout could not be verified. Retained files and refs require inspection.'); };
const statId = (stat) => `${stat.dev}:${stat.ino}`;
const associationSchema = z.object({ spaceId: z.string().regex(/^[a-f0-9]{12}$/),
  source: transferSourceSchema }).strict().refine((value) => value.source.kind === 'bot-checkout');
const ownerFields = { version: z.literal(1), projectId: text, projectPath: text, itemId: text, botId: text,
  repositoryId: text, key: text, directory: text, branch: branchSchema, baseBranch: branchSchema, baseSha: sha,
  identityId: text, identityRevision: z.number().int().positive(),
  gitDirectory: text.optional(), gitIdentity: text.optional(), directoryIdentity: text.optional() };
const ownerSchema = z.object({ ...ownerFields, publicationBranch: branchSchema.optional(),
  state: z.enum(['preparing', 'ready', 'adopting', 'removing', 'removed']), removeHead: sha.optional(),
  adoption: z.object({ fromSha: sha, resultSha: sha, resultRef: z.string().regex(/^refs\/openchamber\/spaces\/[a-f0-9]{12}\/result$/),
    association: associationSchema.optional() }).strict().optional(),
}).strict().refine((record) => (record.state === 'adopting') === Boolean(record.adoption), 'Only an adopting checkout carries a transfer intent');
const reservationsSchema = z.object({ version: z.literal(1), repositoryId: text,
  reservations: z.array(z.object({ publicationBranch: branchSchema, owner: z.object(ownerFields).strict() }).strict()),
}).strict().refine((registry) => registry.reservations.every((entry) => entry.owner.repositoryId === registry.repositoryId)
  && new Set(registry.reservations.map((entry) => entry.publicationBranch)).size === registry.reservations.length
  && new Set(registry.reservations.map((entry) => `${entry.owner.botId}\0${entry.owner.itemId}`)).size === registry.reservations.length,
'Publication branches and owners must be unique within their repository');
const publicationOwner = (record) => Object.fromEntries(Object.keys(ownerFields)
  .filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
const changesOf = (raw) => {
  const fields = raw.split('\0');
  const result = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const first = fields[index++];
    if (!first || !/^[ACDMRTUXB][0-9]*$/.test(status)) fail('BOT_GIT_DIFF_INVALID');
    if (/^[RC]/.test(status)) {
      const next = fields[index++];
      if (!next) fail('BOT_GIT_DIFF_INVALID');
      result.push({ oldPath: first, newPath: next });
    } else {
      const change = {};
      if (status !== 'A') change.oldPath = first;
      if (status !== 'D') change.newPath = first;
      result.push(change);
    }
  }
  return result;
};
const checkoutOf = (record) => ({ directory: record.directory, branch: record.branch, baseBranch: record.baseBranch, baseSha: record.baseSha });
const testPath = (name) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+[._](?:test|spec)\.[^/]+$/.test(name);

export function createProductionBotWorktrees({ dataDir, context, readItem, disposeInstance, advanceCheckout = advanceBotCheckout }) {
  if (!dataDir || !context?.github || !context?.author || !readItem) throw new TypeError('Bot worktrees require dataDir, context and readItem');
  const root = path.join(dataDir, 'bot-worktrees');
  const location = ({ project, item }) => {
    const key = createHash('sha256').update(`${project.id}\0${item.id}`).digest('hex');
    return { file: path.join(root, `${key}.json`), directory: path.join(root, key) };
  };
  const read = async (request) => {
    try { return ownerSchema.parse(JSON.parse(await fs.readFile(location(request).file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const saveJson = async (file, value) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  };
  const save = (request, record) => saveJson(location(request).file, ownerSchema.parse(record));
  const locked = async (request, operation) => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withSourceControlFileLock(`${location(request).file}.lock`, operation, { waitMs: 10_000 });
  };
  const reservationsFile = (repositoryId) => path.join(root, `${createHash('sha256').update(repositoryId).digest('hex')}.publications.json`);
  const repositoryLocked = async (repositoryId, operation) => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withSourceControlFileLock(`${reservationsFile(repositoryId)}.lock`, operation, { waitMs: 10_000 });
  };
  const readReservations = async (repositoryId) => {
    let registry;
    try { registry = reservationsSchema.parse(JSON.parse(await fs.readFile(reservationsFile(repositoryId), 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, repositoryId, reservations: [] };
      throw error;
    }
    if (registry.repositoryId !== repositoryId) fail('BOT_PUBLICATION_OWNERSHIP');
    return registry;
  };
  const reservedFor = (registry, { botId, itemId }) => registry.reservations.find((entry) => entry.owner.botId === botId && entry.owner.itemId === itemId);
  const validateDirectory = (request, record) => {
    if (request.trustedMigrationPath !== undefined) {
      const captured = botMigrationPathSchema.safeParse(request.trustedMigrationPath);
      if (!captured.success) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
      const expected = botMigrationPathSchema.safeParse(Object.fromEntries(Object.keys(captured.data).map((key) => [key, record[key]])));
      if (!expected.success || !sameBotMigrationPath(captured.data, expected.data)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    }
    if (record.directory !== location({ project: { id: record.projectId }, item: { id: record.itemId } }).directory
      && request.trustedMigrationPath === undefined) fail('BOT_MIGRATION_PATH_AUTHORITY_REQUIRED');
  };
  const validateReservation = (record, reservation, request = {}) => {
    if (!record || !reservation || JSON.stringify(publicationOwner(record)) !== JSON.stringify(reservation.owner)
      || record.branch !== `bot/${record.itemId}` || !record.gitDirectory || !record.gitIdentity || !record.directoryIdentity) fail('BOT_PUBLICATION_OWNERSHIP');
    validateDirectory(request, record);
  };
  const exists = async (name) => {
    try { await fs.lstat(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const validateRecord = async (request, record) => {
    if (!record || record.projectId !== request.project.id || record.itemId !== request.item.id || record.botId !== request.bot.id
      || request.item.botId && request.item.botId !== request.bot.id
      || record.branch !== `bot/${request.item.id}`
      || record.projectPath !== await fs.realpath(request.project.path)
      || (await resolveRepositoryIdentity(request.project.path)).repositoryId !== record.repositoryId
      || request.item.worktree && request.item.worktree !== record.directory
      || request.item.branch && request.item.branch !== record.branch
      || request.item.publicationBranch !== undefined && request.item.publicationBranch !== record.publicationBranch
      || request.key && request.key !== record.key) fail('BOT_WORKTREE_OWNERSHIP');
    validateDirectory(request, record);
  };
  const verifyCheckout = async (request, record) => {
    await validateRecord(request, record);
    const stat = await fs.lstat(record.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || statId(stat) !== record.directoryIdentity
      || await fs.realpath(record.directory) !== record.directory) fail('BOT_WORKTREE_OWNERSHIP');
    const gitDirectory = (await botGit(record.directory, ['rev-parse', '--absolute-git-dir'])).trim();
    const head = (await botGit(record.directory, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim();
    const detachedAdoption = record.state === 'adopting' && head === 'HEAD'
      && (await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() === record.adoption.resultSha;
    if (gitDirectory !== record.gitDirectory || statId(await fs.stat(gitDirectory)) !== record.gitIdentity
      || (await resolveRepositoryIdentity(record.directory)).repositoryId !== record.repositoryId
      || head !== `refs/heads/${record.branch}` && !detachedAdoption) fail('BOT_WORKTREE_OWNERSHIP');
    const topology = await getWorktrees(request.project.path);
    if (!topology.some((entry) => path.resolve(entry.path) === record.directory && (entry.branch === record.branch || detachedAdoption && !entry.branch))
      || topology.some((entry) => entry.branch === record.branch && path.resolve(entry.path) !== record.directory)) fail('BOT_WORKTREE_OWNERSHIP');
  };
  const clean = async (record, includeIgnored = false) => {
    const { run } = await createBotCheckoutGit(record.directory);
    if ((await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(includeIgnored ? ['--ignored=matching'] : [])])).length) fail('BOT_WORKTREE_DIRTY');
  };
  const requireAncestor = async (directory, ancestor, descendant) => {
    let found;
    try { found = (await botGit(directory, ['merge-base', ancestor, descendant])).trim(); }
    catch { fail('BOT_ISOLATED_ANCESTRY'); }
    if (found !== ancestor) fail('BOT_ISOLATED_ANCESTRY');
  };
  const adoptionState = async (record) => {
    const { run } = await createBotCheckoutGit(record.directory);
    // Skip-worktree/assume-unchanged entries can hide pending user edits.
    if ((await run(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) fail('BOT_ISOLATED_INDEX_FLAGS');
    if ((await run(['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'])).length
      || (await run(['ls-files', '--others', '-z'])).length) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
    return { headSha: sha.parse((await run(['rev-parse', 'HEAD'])).trim()),
      treeSha: sha.parse((await run(['write-tree'])).trim()) };
  };
  const remoteHead = async (credential, target, name, missing = false) => {
    try {
      const value = providerResult(z.object({ ref: text, object: z.object({ sha }) }), await credential.request({
        path: `/repos/${target.owner}/${target.repo}/git/ref/heads/${encodeURIComponent(name)}` }));
      if (value.ref !== `refs/heads/${name}`) fail('BOT_GIT_REMOTE_CHANGED');
      return value.object.sha;
    } catch (error) { if (missing && error.code === 'BOT_SERVICE_REJECTED' && error.status === 404) return null; throw error; }
  };
  const defaultBranch = async (credential, target) => providerResult(z.object({ default_branch: branchSchema }),
    await credential.request({ path: `/repos/${target.owner}/${target.repo}` })).default_branch;
  const requireObject = async (request, credential, target, commit) => {
    try { await botGit(request.project.path, ['cat-file', '-e', `${commit}^{commit}`]); }
    catch { await fetchBotCommit({ directory: request.project.path, credential, target, commit }); }
  };
  const removalFinished = async (request, record) => {
    await validateRecord(request, record);
    const topology = await getWorktrees(request.project.path);
    if (await exists(record.directory) || topology.some((entry) => path.resolve(entry.path) === record.directory)) return false;
    if (topology.some((entry) => entry.branch === record.branch)) fail('BOT_WORKTREE_OWNERSHIP');
    const refs = (await botGit(request.project.path, ['for-each-ref', '--format=%(objectname)', `refs/heads/${record.branch}`])).trim();
    if (refs) {
      if (refs !== record.removeHead) fail('BOT_WORKTREE_BRANCH_CHANGED');
      await botGit(request.project.path, ['update-ref', '-d', `refs/heads/${record.branch}`, record.removeHead]);
    }
    await save(request, { ...record, state: 'removed' });
    return true;
  };
  const sourceOfRecord = (record) => ({ kind: 'bot-checkout', projectDirectory: record.projectPath,
    projectId: record.projectId, botId: record.botId, itemId: record.itemId, checkoutKey: record.key });
  const verifyAssociation = async (record, association, resultSha, trustedMigrationPath) => {
    if (!sameTransferSource(sourceOfRecord(record), association.source)) fail('BOT_ISOLATED_SOURCE_MISMATCH');
    const handle = await fs.open(path.join(dataDir, 'space-transfer', `${association.spaceId}.json`), 'r').catch((error) => {
      if (error.code === 'ENOENT') fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
      throw error;
    });
    let metadata;
    try {
      const limit = transferCaps().metadataBytes;
      if ((await handle.stat()).size > limit) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > limit) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      metadata = parseSnapshotMetadata(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), association.spaceId);
    } finally { await handle.close(); }
    const resultRef = `refs/openchamber/spaces/${association.spaceId}/result`;
    if (Boolean(metadata.trustedMigrationPath) !== Boolean(trustedMigrationPath)
      || trustedMigrationPath && !sameBotMigrationPath(metadata.trustedMigrationPath, trustedMigrationPath)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    if (!metadata.source || !sameTransferSource(metadata.source, association.source) || metadata.directory !== record.directory
      || (await botGit(record.directory, ['for-each-ref', '--format=%(objectname)', metadata.ref])).trim() !== metadata.start
      || (await botGit(record.directory, ['for-each-ref', '--format=%(objectname)', resultRef])).trim() !== resultSha) fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
    return resultRef;
  };
  return Object.freeze({
    async resolveTransferSource(input, { trustedMigrationPath } = {}) {
      const source = transferSourceSchema.parse(input);
      if (source.kind !== 'bot-checkout') fail('BOT_WORKTREE_OWNERSHIP');
      const item = await readItem(source.projectId, source.itemId);
      if (!item || item.id !== source.itemId || item.botId !== source.botId || source.checkoutKey !== `${source.itemId}:worktree`) fail('BOT_WORKTREE_OWNERSHIP');
      const request = { project: { id: source.projectId, path: source.projectDirectory }, bot: { id: source.botId }, item, key: source.checkoutKey, trustedMigrationPath };
      return locked(request, async () => {
        const record = await read(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        return record.directory;
      });
    },
    async bindPublication(request) {
      const publicationBranch = branchSchema.parse(request.branch);
      return locked(request, async () => {
        const record = await read(request);
        if (!record) fail('BOT_WORKTREE_OWNERSHIP');
        return repositoryLocked(record.repositoryId, async () => {
          await verifyCheckout(request, record);
          if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
          const { binding, credential } = await context.github(request);
          if (binding.target.repositoryId !== record.repositoryId) fail('BOT_WORKTREE_OWNERSHIP');
          if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
          const item = await readItem(request.project.id, request.item.id);
          if (!item) fail('BOT_WORKTREE_OWNERSHIP');
          await validateRecord({ ...request, item }, record);
          if (record.publicationBranch === undefined && [item, request.item].some((value) => value.pr || value.effects.some((effect) => effect.kind === 'git.push' || effect.kind.startsWith('pr.')))) {
            fail('BOT_PUBLICATION_ALREADY_STARTED');
          }
          const registry = await readReservations(record.repositoryId);
          const previous = reservedFor(registry, record);
          if (record.publicationBranch !== undefined && record.publicationBranch !== publicationBranch
            || previous && previous.publicationBranch !== publicationBranch) fail('BOT_PUBLICATION_IMMUTABLE');
          if (previous) {
            validateReservation(record, previous, request);
          } else {
            if (record.publicationBranch !== undefined) fail('BOT_PUBLICATION_OWNERSHIP');
            if (registry.reservations.some((entry) => entry.publicationBranch === publicationBranch)) fail('BOT_PUBLICATION_RESERVED');
            if (publicationBranch === record.baseBranch || publicationBranch === await defaultBranch(credential, binding.target)) fail('BOT_PUBLICATION_BASE');
            if (await remoteHead(credential, binding.target, publicationBranch, true) !== null) fail('BOT_PUBLICATION_REMOTE_EXISTS');
            // A committed reservation remains authoritative if the owner write fails.
            await saveJson(reservationsFile(record.repositoryId), reservationsSchema.parse({ ...registry,
              reservations: [...registry.reservations, { publicationBranch, owner: publicationOwner(record) }] }));
          }
          if (record.publicationBranch === undefined) await save(request, { ...record, publicationBranch });
          return { publicationBranch };
        });
      });
    },
    async readPublication(input) {
      const query = z.object({ repositoryId: text, botId: text, itemId: text, trustedMigrationPath: botMigrationPathSchema.optional() }).strict().parse(input);
      const reservation = await repositoryLocked(query.repositoryId, async () => {
        const entry = reservedFor(await readReservations(query.repositoryId), query);
        if (entry) return entry;
        // A missing registry cannot turn an already bound owner into unbound success.
        for (const name of await fs.readdir(root)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const record = ownerSchema.parse(JSON.parse(await fs.readFile(path.join(root, name), 'utf8')));
          if (record.repositoryId === query.repositoryId && record.botId === query.botId && record.itemId === query.itemId
            && record.publicationBranch !== undefined) fail('BOT_PUBLICATION_OWNERSHIP');
        }
        return null;
      });
      if (!reservation) return null;
      const request = { project: { id: reservation.owner.projectId }, item: { id: reservation.owner.itemId }, trustedMigrationPath: query.trustedMigrationPath };
      // Never hold the repository lock while acquiring an owner lock.
      return locked(request, () => repositoryLocked(query.repositoryId, async () => {
        const current = reservedFor(await readReservations(query.repositoryId), query);
        const record = await read(request);
        validateReservation(record, current, request);
        if (record.publicationBranch !== current.publicationBranch || !['ready', 'removing', 'removed'].includes(record.state)) fail('BOT_PUBLICATION_OWNERSHIP');
        return { publicationBranch: record.publicationBranch, localBranch: record.branch, directory: record.directory,
          identityId: record.identityId, identityRevision: record.identityRevision };
      }));
    },
    async adoptIsolated(request) {
      const resultSha = sha.parse(request.resultSha);
      const suppliedAssociation = request.association === undefined ? undefined : associationSchema.parse(request.association);
      const spaceId = request.spaceId === undefined ? undefined : z.string().regex(/^[a-f0-9]{12}$/).parse(request.spaceId);
      return locked(request, async () => {
        let record = await read(request);
        await verifyCheckout(request, record);
        const association = spaceId ? { spaceId, source: sourceOfRecord(record) } : suppliedAssociation;
        if (suppliedAssociation && association && JSON.stringify(suppliedAssociation) !== JSON.stringify(association)) fail('BOT_ISOLATED_SOURCE_MISMATCH');
        if (!request.bot.isolated) fail('BOT_ISOLATION_REQUIRED');
        if (!['ready', 'adopting'].includes(record.state)) fail('BOT_WORKTREE_CREATE_UNSETTLED');
        if (record.adoption?.association && (!association || JSON.stringify(record.adoption.association) !== JSON.stringify(association))) fail('BOT_ISOLATED_SOURCE_MISMATCH');
        const associatedRef = association && await verifyAssociation(record, association, resultSha, request.trustedMigrationPath);
        const { binding } = await context.github(request);
        if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
        if ((await botGit(record.directory, ['cat-file', '-t', resultSha])).trim() !== 'commit') fail('BOT_ISOLATED_RESULT_INVALID');
        await requireAncestor(record.directory, record.baseSha, resultSha);
        if (record.state === 'ready') {
          await clean(record, true);
          const refs = (await botGit(record.directory, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/openchamber/spaces/'])).trim().split(/\r?\n/);
          const resultRef = associatedRef ?? refs.find((entry) => /^refs\/openchamber\/spaces\/[a-f0-9]{12}\/result [a-f0-9]{40}$/.test(entry) && entry.endsWith(` ${resultSha}`))?.split(' ')[0];
          if (!resultRef) fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
          const fromSha = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
          await requireAncestor(record.directory, fromSha, resultSha);
          if (fromSha === resultSha) {
            await adoptionState(record);
            return { headSha: resultSha };
          }
          const adoption = { fromSha, resultSha, resultRef };
          if (association) adoption.association = association;
          record = { ...record, state: 'adopting', adoption };
          // Files, index and branch stay unchanged until this descriptor exists.
          await save(request, record);
        } else if (record.adoption.resultSha !== resultSha) fail('BOT_ISOLATED_ADOPTION_PENDING');
        const { fromSha } = record.adoption;
        await requireAncestor(record.directory, fromSha, resultSha);
        const fromTree = (await botGit(record.directory, ['rev-parse', `${fromSha}^{tree}`])).trim();
        const resultTree = (await botGit(record.directory, ['rev-parse', `${resultSha}^{tree}`])).trim();
        let observed = await adoptionState(record);
        if (observed.headSha === fromSha && observed.treeSha === fromTree) {
          await verifyCheckout(request, record);
          await advanceCheckout({ directory: record.directory, fromSha, resultSha });
          observed = await adoptionState(record);
        }
        if (observed.treeSha !== resultTree || ![fromSha, resultSha].includes(observed.headSha)) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
        await verifyCheckout(request, record);
        const branchHead = (await botGit(record.directory, ['rev-parse', `refs/heads/${record.branch}`])).trim();
        if (![fromSha, resultSha].includes(branchHead)) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
        if (branchHead === fromSha) await botGit(record.directory, ['update-ref', `refs/heads/${record.branch}`, resultSha, fromSha]);
        await botGit(record.directory, ['symbolic-ref', 'HEAD', `refs/heads/${record.branch}`]);
        await clean(record, true);
        if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== resultSha) fail('BOT_GIT_HEAD_CHANGED');
        const { adoption: _adoption, ...ready } = record;
        await save(request, { ...ready, state: 'ready' });
        return { headSha: resultSha };
      });
    },
    async create(request) {
      return locked(request, async () => {
        const previous = await read(request);
        if (previous) {
          await validateRecord(request, previous);
          if (previous.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
          await verifyCheckout(request, previous);
          return checkoutOf(previous);
        }
        // A retained-path grant cannot replace its missing private descriptor.
        if (request.trustedMigrationPath !== undefined) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
        const branch = branchSchema.parse(`bot/${request.item.id}`);
        if (request.item.botId !== request.bot.id) fail('BOT_WORKTREE_OWNERSHIP');
        const { binding, credential } = await context.github(request);
        const baseBranch = await defaultBranch(credential, binding.target);
        const baseSha = await remoteHead(credential, binding.target, baseBranch);
        await requireObject(request, credential, binding.target, baseSha);
        const directory = location(request).directory;
        if (await exists(directory) || (await botGit(request.project.path, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).trim()) fail('BOT_WORKTREE_UNOWNED');
        const record = ownerSchema.parse({ version: 1, projectId: request.project.id, projectPath: await fs.realpath(request.project.path),
          itemId: request.item.id, botId: request.bot.id, repositoryId: binding.target.repositoryId, key: request.key,
          identityId: binding.identityId, identityRevision: binding.identityRevision,
          directory, branch, baseBranch, baseSha, state: 'preparing' });
        await save(request, record);
        // This existing owner disables executable filters and hooks and waits
        // for population. It executes no project start commands.
        await addDetachedWorktree(request.project.path, directory, baseSha);
        record.gitDirectory = (await botGit(directory, ['rev-parse', '--absolute-git-dir'])).trim();
        record.gitIdentity = statId(await fs.stat(record.gitDirectory));
        record.directoryIdentity = statId(await fs.lstat(directory));
        await save(request, record);
        await botGit(directory, ['update-ref', `refs/heads/${branch}`, baseSha, '0'.repeat(40)]);
        await botGit(directory, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
        await configureBotWorktreeIdentity({ directory, ...await context.author({ ...request, binding }) });
        record.state = 'ready';
        await verifyCheckout(request, record);
        await save(request, record);
        return checkoutOf(record);
      });
    },
    async reconcile(request) {
      return locked(request, async () => {
        const record = await read(request);
        if (!record) return { state: 'outcome-unknown' };
        await validateRecord(request, record);
        if (request.operation === 'remove') {
          if (['removing', 'removed'].includes(record.state) && await removalFinished(request, record)) return { state: 'succeeded', result: { id: request.item.id } };
          return { state: 'outcome-unknown' };
        }
        if (record.state !== 'ready') return { state: 'outcome-unknown' };
        await verifyCheckout(request, record);
        return { state: 'succeeded', result: checkoutOf(record) };
      });
    },
    async remove(request) {
      return locked(request, async () => {
        const record = await read(request);
        await validateRecord(request, record);
        if (request.checkout && JSON.stringify(checkoutOf(record)) !== JSON.stringify(request.checkout)) fail('BOT_WORKTREE_OWNERSHIP');
        if (['removed', 'removing'].includes(record.state) && await removalFinished(request, record)) return { id: request.item.id };
        if (record.state !== 'ready' && record.state !== 'removing') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        const item = await readItem(request.project.id, request.item.id);
        if (!item || item.id !== record.itemId || item.botId !== record.botId || item.worktree !== record.directory
          || item.branch !== record.branch || item.effects.some((effect) => ['prepared', 'dispatching', 'outcome-unknown'].includes(effect.state)
            && !(effect.kind === 'worktree.remove' && effect.key === `${item.id}:cleanup`))) fail('BOT_WORKTREE_UNSETTLED_EFFECTS');
        await verifyCheckout(request, record);
        await clean(record, true);
        const removeHead = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
        await save(request, { ...record, state: 'removing', removeHead });
        await removeWorktree(request.project.path, { directory: record.directory, deleteLocalBranch: false, disposeInstance }, {
          verifyRemoval: async () => {
            await verifyCheckout(request, record);
            await clean(record, true);
            if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== removeHead) fail('BOT_WORKTREE_BRANCH_CHANGED');
          } });
        if (!await removalFinished(request, { ...record, state: 'removing', removeHead })) fail('BOT_WORKTREE_REMOVE_INCOMPLETE');
        return { id: request.item.id };
      });
    },
    async inspect(request) {
      return locked(request, async () => {
        const record = await read(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        await clean(record);
        const { binding, credential } = await context.github(request);
        if (binding.target.repositoryId !== record.repositoryId) fail('BOT_WORKTREE_OWNERSHIP');
        if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
        const baseBranch = await defaultBranch(credential, binding.target);
        if (baseBranch !== record.baseBranch) fail('BOT_GIT_BASE_CHANGED');
        const baseSha = await remoteHead(credential, binding.target, baseBranch);
        await requireObject(request, credential, binding.target, baseSha);
        const headSha = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
        const remoteSha = await remoteHead(credential, binding.target, record.publicationBranch ?? record.branch, true);
        const ancestor = sha.parse((await botGit(record.directory, ['merge-base', baseSha, headSha])).trim());
        const changes = changesOf(await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', ancestor, headSha, '--']));
        const diff = await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--binary', ancestor, headSha, '--']);
        const result = { baseSha, headSha, baseBranch, remoteSha, changes, diff };
        const commits = (await botGit(record.directory, ['rev-list', '--reverse', '--first-parent', `${ancestor}..${headSha}`])).trim().split(/\r?\n/).filter(Boolean);
        for (const testSha of commits.slice(0, -1).reverse()) {
          const parents = (await botGit(record.directory, ['rev-list', '--parents', '-n', '1', testSha])).trim().split(' ');
          if (parents.length !== 2) continue;
          const changes = changesOf(await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', parents[1], testSha, '--']));
          const files = changes.flatMap((entry) => entry.newPath ? [entry.newPath] : []);
          if (files.length && changes.flatMap((entry) => [entry.oldPath, entry.newPath].filter(Boolean)).every(testPath)) {
            // A later edit to the regression test cannot prove the same test passed.
            if ((await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', testSha, headSha, '--', ...files])).trim()) continue;
            result.testSha = testSha; result.fixSha = headSha; result.testFiles = files; break;
          }
        }
        await clean(record);
        await verifyCheckout(request, record);
        if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== headSha) fail('BOT_GIT_HEAD_CHANGED');
        return result;
      });
    },
    async acceptPublished(request) {
      return locked(request, async () => {
        const record = await read(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        await clean(record);
        const result = z.object({ sourceHeadSha: sha, headSha: sha,
          commitMap: z.array(z.object({ sourceSha: sha, publishedSha: sha }).strict()).min(1).max(100) }).strict().parse(request.result);
        if (result.sourceHeadSha !== request.snapshot.headSha || result.commitMap.at(-1).sourceSha !== result.sourceHeadSha
          || result.commitMap.at(-1).publishedSha !== result.headSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
        const currentHead = (await botGit(record.directory, ['rev-parse', 'HEAD'])).trim();
        if (![result.sourceHeadSha, result.headSha].includes(currentHead)) fail('BOT_GIT_HEAD_CHANGED');
        const { binding, credential } = await context.github(request);
        if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
        if (credential.definition.kind !== 'github-app') fail('BOT_GITHUB_SIGNING_IDENTITY_REQUIRED');
        if (await remoteHead(credential, binding.target, record.publicationBranch ?? record.branch) !== result.headSha) fail('BOT_GIT_REMOTE_CHANGED');
        let sourceParent = request.snapshot.remoteSha ?? request.snapshot.baseSha;
        let publishedParent = sourceParent;
        for (const entry of result.commitMap) {
          const source = await botGit(record.directory, ['cat-file', 'commit', entry.sourceSha]);
          const boundary = source.indexOf('\n\n');
          const headers = source.slice(0, boundary).split('\n');
          const parents = headers.filter((line) => line.startsWith('parent '));
          const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
          if (parents.length !== 1 || parents[0] !== `parent ${sourceParent}`) fail('BOT_GIT_COMMIT_MAP_INVALID');
          const commit = providerResult(z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })), message: z.string(),
            verification: z.object({ verified: z.literal(true), payload: z.string().min(1), signature: z.string().min(1) }) }),
          await credential.request({ path: `/repos/${binding.target.owner}/${binding.target.repo}/git/commits/${entry.publishedSha}` }));
          const payload = commit.verification.payload;
          const split = payload.indexOf('\n\n');
          const payloadHeaders = payload.slice(0, split).split('\n');
          if (commit.sha !== entry.publishedSha || commit.tree.sha !== tree || commit.parents.length !== 1
            || commit.parents[0].sha !== publishedParent || commit.message !== source.slice(boundary + 2).replace(/\n$/, '')
            || split < 0 || payloadHeaders.filter((line) => line.startsWith('parent ')).join() !== `parent ${publishedParent}`
            || payloadHeaders.filter((line) => line.startsWith('tree ')).join() !== `tree ${tree}`
            || payload.slice(split + 2) !== source.slice(boundary + 2)) fail('BOT_GIT_COMMIT_MAP_INVALID');
          const raw = `${payload.slice(0, split)}\ngpgsig ${commit.verification.signature.trimEnd().replace(/\n/g, '\n ')}${payload.slice(split)}`;
          const imported = (await botGit(record.directory, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw)).trim();
          if (imported !== entry.publishedSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
          sourceParent = entry.sourceSha; publishedParent = entry.publishedSha;
        }
        if (sourceParent !== result.sourceHeadSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
        await clean(record);
        await verifyCheckout(request, record);
        if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== currentHead) fail('BOT_GIT_HEAD_CHANGED');
        // Equal trees need no reset or checkout. CAS keeps concurrent work intact.
        if (currentHead !== result.headSha) await botGit(record.directory, ['update-ref', `refs/heads/${record.branch}`, result.headSha, result.sourceHeadSha]);
        return { headSha: result.headSha };
      });
    },
  });
}
