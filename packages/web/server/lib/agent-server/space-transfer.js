import fs from 'node:fs/promises';
import path from 'node:path';
import { createCodeIn } from '../spaces/code-in.js';
import { createCodeOut } from '../spaces/code-out.js';
import { line, spaceRefPrefix, startRef } from '../spaces/code-transfer.js';
import { createHostGit } from '../spaces/host-git.js';
import { runCommand } from '../spaces/run-command.js';
import { bundleFailure, checkSnapshotChain, importBundle, parseSnapshotMetadata, sameBotMigrationPath, sameTransferSource, withBundleDirectory, writeBundle } from '../spaces/transfer-bundle.js';
import { trustedFolders } from './git-trust.js';

/** Project operations run only in the agent process. No dependency can address a place. */
export function createAgentSpaceTransfer({ dataDir, caps, resolveGitPath = () => 'git', environment = process.env }) {
  const git = createHostGit({ runCommand: (_file, args, options) => runCommand(resolveGitPath(), args, options), environment });
  const codeIn = createCodeIn({ git, place: null });
  const codeOut = createCodeOut({ git, place: null });
  const root = path.join(dataDir, 'space-transfer');
  const metadataFile = (spaceId) => path.join(root, `${spaceId}.json`);
  // The isolated git, in a registered project another account owns: trusted by exact path.
  const inProject = async (directory, work) => withBundleDirectory({ caps, environment, trust: await trustedFolders(directory) }, work);
  const shallowRoots = async (safe, directory) => {
    const file = path.resolve(directory, line(await safe.output(directory, ['rev-parse', '--git-path', 'shallow'])));
    try {
      const handle = await fs.open(file, 'r');
      try {
        if ((await handle.stat()).size > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        const bytes = Buffer.alloc(caps.metadataBytes + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        return bytes.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean);
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const saveSnapshot = async (metadata, spaceId) => {
    const body = JSON.stringify(metadata);
    if (Buffer.byteLength(body) > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await withBundleDirectory({ caps, environment, temporaryDirectory: root }, async ({ directory }) => {
      const file = path.join(directory, 'metadata.json');
      await fs.writeFile(file, body, { flag: 'wx', mode: 0o600 });
      await fs.link(file, metadataFile(spaceId));
    });
  };
  const reconstruct = async (directory, spaceId, base) => inProject(directory, async ({ git: safe }) => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base ?? '')) throw bundleFailure('agent_snapshot_missing');
    const start = line(await safe.output(directory, ['rev-parse', '--verify', startRef(spaceId)]));
    const mode = start === base ? 'clean' : 'uncommitted';
    const staged = mode === 'clean' ? base : line(await safe.output(directory, ['rev-parse', `${start}^`]));
    const metadata = parseSnapshotMetadata({ version: 1, directory, mode, base, staged, start,
      repository: path.resolve(line(await safe.output(directory, ['rev-parse', '--show-toplevel']))),
      prefix: line(await safe.output(directory, ['rev-parse', '--show-prefix'])),
      objectFormat: line(await safe.output(directory, ['rev-parse', '--show-object-format'])),
      shallow: await shallowRoots(safe, directory), ref: startRef(spaceId), branch: null, identity: { name: '', email: '' },
    }, spaceId);
    await checkSnapshotChain(safe, directory, metadata);
    await saveSnapshot(metadata, spaceId);
    return metadata;
  });

  const readSnapshot = async (directory, spaceId, legacyBase, source = { kind: 'project', directory }, trustedMigrationPath) => {
    let file;
    try { file = await fs.open(metadataFile(spaceId), 'r'); }
    catch (error) {
      if (error.code === 'ENOENT' && source.kind === 'project') return reconstruct(directory, spaceId, legacyBase);
      throw bundleFailure(error.code === 'ENOENT' ? 'agent_snapshot_missing' : 'agent_snapshot_unreadable');
    }
    let metadata;
    try {
      if ((await file.stat()).size > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
      const bytes = Buffer.alloc(caps.metadataBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
      try { metadata = parseSnapshotMetadata(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), spaceId); }
      catch (error) { if (error instanceof SyntaxError) throw bundleFailure('agent_metadata_invalid'); throw error; }
    } finally { await file.close(); }
    if (metadata.directory !== directory) throw bundleFailure('agent_project_mismatch');
    if (!sameTransferSource(metadata.source ?? { kind: 'project', directory: metadata.directory }, source)) throw bundleFailure('agent_source_mismatch');
    if (Boolean(metadata.trustedMigrationPath) !== Boolean(trustedMigrationPath)
      || trustedMigrationPath && !sameBotMigrationPath(metadata.trustedMigrationPath, trustedMigrationPath)) throw bundleFailure('agent_source_mismatch');
    return inProject(directory, async ({ git: safe }) => {
      if (line(await safe.output(directory, ['rev-parse', '--verify', startRef(spaceId)])) !== metadata.start) throw bundleFailure('agent_snapshot_changed');
      await checkSnapshotChain(safe, directory, metadata);
      return parseSnapshotMetadata({ ...metadata, shallow: await shallowRoots(safe, directory) }, spaceId);
    });
  };

  const snapshot = async (directory, spaceId, mode, source = { kind: 'project', directory }, trustedMigrationPath) => {
    // A sidecar is exclusive to one allocation even when a caller removed its start ref.
    try { await fs.lstat(metadataFile(spaceId)); throw bundleFailure('agent_snapshot_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const taken = await codeIn.takeSnapshot({ repository: directory, spaceId, mode });
    try {
      const shallow = await inProject(directory, ({ git: safe }) => shallowRoots(safe, directory));
      const metadataInput = { ...taken, version: 1, directory, mode, shallow, source };
      if (trustedMigrationPath) metadataInput.trustedMigrationPath = trustedMigrationPath;
      const metadata = parseSnapshotMetadata(metadataInput, spaceId);
      await saveSnapshot(metadata, spaceId);
      return metadata;
    } catch (error) {
      try { await codeIn.removeSpaceRefs({ repository: directory, spaceId }); }
      catch (cleanup) { error.details = { ...error.details, refNotRemoved: taken.ref, cleanupCode: cleanup.code }; }
      throw error;
    }
  };

  const exportSnapshot = async (directory, spaceId, file, source, trustedMigrationPath) => {
    const metadata = await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath);
    await inProject(directory, async ({ git: safe }) => {
      await writeBundle(safe, directory, file, { caps, revisions: [metadata.ref] });
    });
    return metadata;
  };

  const promote = async (directory, spaceId, file, expected, source, trustedMigrationPath) => {
    const metadata = await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath);
    if (metadata.start !== expected.start) throw bundleFailure('agent_snapshot_changed');
    const resultSource = async ({ g, directory: temporary, top, start, objectFormat }) => {
      const quarantine = path.join(temporary, 'bundle.git');
      await g.output(temporary, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, quarantine]);
      const objects = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'objects'])));
      await fs.writeFile(path.join(quarantine, 'objects/info/alternates'), `${objects}\n`);
      if (metadata.shallow.length) await fs.writeFile(path.join(quarantine, 'shallow'), `${metadata.shallow.join('\n')}\n`);
      const ref = `${spaceRefPrefix(spaceId)}result`;
      await importBundle(g, quarantine, file, { caps, objectFormat, id: expected.result, ref, prerequisite: start });
      await g.output(quarantine, ['update-ref', 'refs/openchamber/result', expected.result]);
      return { quarantine, result: expected.result, unmerged: { count: 0, paths: [] } };
    };
    return createCodeOut({ git, place: null, resultSource }).bringCodeOut({ repository: directory, spaceId,
      spacePath: `/spaces/${spaceId}/bundle`, timeoutMs: caps.timeoutMs, maxTransferBytes: caps.bundleBytes });
  };

  return {
    snapshot, readSnapshot, exportSnapshot, promote,
    applyState: async (directory, spaceId, source, trustedMigrationPath) => {
      await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath);
      return codeOut.describeApplyState({ repository: directory, spaceId });
    },
    applyBranch: async (directory, spaceId, branch, source, trustedMigrationPath) => {
      await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath);
      return codeOut.applyAsBranch({ repository: directory, spaceId, branch });
    },
    applyChanges: async (directory, spaceId, source, trustedMigrationPath) => {
      await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath);
      return codeOut.applyAsChanges({ repository: directory, spaceId });
    },
    removeRefs: async (directory, spaceId, source = { kind: 'project', directory }, trustedMigrationPath) => {
      try { await readSnapshot(directory, spaceId, undefined, source, trustedMigrationPath); }
      catch (error) {
        // Legacy project cleanup and failed creates may have no snapshot at all.
        if (error.code !== 'agent_snapshot_missing') throw error;
        if (source.kind === 'bot-checkout') {
          const refs = await inProject(directory, ({ git: safe }) => safe.output(directory, ['for-each-ref', '--format=%(refname)', spaceRefPrefix(spaceId)]));
          if (refs.trim()) throw error;
          return [];
        }
      }
      const refs = await codeIn.removeSpaceRefs({ repository: directory, spaceId });
      await fs.rm(metadataFile(spaceId), { force: true });
      return refs;
    },
  };
}
