import fs from 'node:fs/promises';
import path from 'node:path';
import { createCodeIn } from '../spaces/code-in.js';
import { createCodeOut } from '../spaces/code-out.js';
import { line, spaceRefPrefix, startRef } from '../spaces/code-transfer.js';
import { createHostGit } from '../spaces/host-git.js';
import { runCommand } from '../spaces/run-command.js';
import { bundleFailure, checkSnapshotChain, importBundle, parseSnapshotMetadata, withBundleDirectory, writeBundle } from '../spaces/transfer-bundle.js';
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

  const readSnapshot = async (directory, spaceId, legacyBase) => {
    let file;
    try { file = await fs.open(metadataFile(spaceId), 'r'); }
    catch (error) { if (error.code === 'ENOENT') return reconstruct(directory, spaceId, legacyBase); throw bundleFailure('agent_snapshot_unreadable'); }
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
    return inProject(directory, async ({ git: safe }) => {
      if (line(await safe.output(directory, ['rev-parse', '--verify', startRef(spaceId)])) !== metadata.start) throw bundleFailure('agent_snapshot_changed');
      await checkSnapshotChain(safe, directory, metadata);
      return parseSnapshotMetadata({ ...metadata, shallow: await shallowRoots(safe, directory) }, spaceId);
    });
  };

  const snapshot = async (directory, spaceId, mode) => {
    const taken = await codeIn.takeSnapshot({ repository: directory, spaceId, mode });
    try {
      const shallow = await inProject(directory, ({ git: safe }) => shallowRoots(safe, directory));
      const metadata = parseSnapshotMetadata({ ...taken, version: 1, directory, mode, shallow }, spaceId);
      await saveSnapshot(metadata, spaceId);
      return metadata;
    } catch (error) {
      try { await codeIn.removeSpaceRefs({ repository: directory, spaceId }); }
      catch (cleanup) { error.details = { ...error.details, refNotRemoved: taken.ref, cleanupCode: cleanup.code }; }
      throw error;
    }
  };

  const exportSnapshot = async (directory, spaceId, file) => {
    const metadata = await readSnapshot(directory, spaceId);
    await inProject(directory, async ({ git: safe }) => {
      await writeBundle(safe, directory, file, { caps, revisions: [metadata.ref] });
    });
    return metadata;
  };

  const promote = async (directory, spaceId, file, expected) => {
    const metadata = await readSnapshot(directory, spaceId);
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
    applyState: (directory, spaceId) => codeOut.describeApplyState({ repository: directory, spaceId }),
    applyBranch: (directory, spaceId, branch) => codeOut.applyAsBranch({ repository: directory, spaceId, branch }),
    applyChanges: (directory, spaceId) => codeOut.applyAsChanges({ repository: directory, spaceId }),
    removeRefs: async (directory, spaceId) => {
      const refs = await codeIn.removeSpaceRefs({ repository: directory, spaceId });
      await fs.rm(metadataFile(spaceId), { force: true });
      return refs;
    },
  };
}
