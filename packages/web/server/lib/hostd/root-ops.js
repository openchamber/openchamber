// What the root component does beside running spaces: says whether a root space may run at all,
// carries a passkey approval and each root activation between the front door and the passkey
// store, and shares the human's projects with the agent account. Runs in hostd, as root; only the
// front door's account can open hostd's socket.
//
// A root space needs the agent separation. With OpenChamber and its agents on one account, a root
// space would give root to whatever already runs as that account. Root's own `host.json` says
// whether the accounts are apart, and the system says who they are, by name, at every request:
// nothing a request carries changes either answer.

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ROOT_EQUIVALENT_GROUPS } from '../host-install/accounts.js';
import { HOST_CONFIG_FILE } from '../host-install/managed.js';
import { SpaceError } from '../spaces/errors.js';
import { RootPasskeyError, activationSpecHash, createRootPasskeys } from './passkey.js';
import { ShareProjectError, createProjectSharing } from './share-project.js';

const ROOT_PLACE = 'host-root';
export const ROOT_OPERATIONS = new Set(['root-status', 'root-approval-challenge', 'root-approval-complete', 'root-activation-options', 'share-project', 'unshare-project', 'project-owner', 'project-shares']);
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
// The three account names `/etc/openchamber/host.json` holds when the accounts are separate.
const hostConfigSchema = z.object({ owner: z.string(), separation: z.object({ frontDoor: z.string(), agent: z.string() }) });

/** Errors of the passkey store and of project sharing travel to the front door with their own codes. */
const translated = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RootPasskeyError || error instanceof ShareProjectError) throw new SpaceError(error.code, error.message, error.details ?? null);
    throw error;
  }
};

const verifyWithSimpleWebAuthn = async (options) => (await import('@simplewebauthn/server')).verifyAuthenticationResponse(options);

/**
 * `paths` is hostd's layout and `state` its space records. `run(file, args)` resolves
 * `{ code, stdout, stderr }`. `passkeys` and `readMountInfo` are replaceable for tests.
 */
export function createRootOps({ paths, state, run, configFile = HOST_CONFIG_FILE, verify = verifyWithSimpleWebAuthn, passkeys = null, readMountInfo }) {
  const store = passkeys ?? createRootPasskeys({
    stateFile: path.join(paths.state, 'root-passkeys.json'),
    pendingFile: path.join(paths.state, 'root-passkey-approval.json'),
    verify,
  });

  const account = async (name) => {
    if (!ACCOUNT_NAME.test(String(name ?? ''))) return null;
    const result = await run('/usr/bin/getent', ['passwd', name]);
    if (result.code !== 0) return null;
    const [entry, , uid, gid, , home] = result.stdout.trim().split(':');
    if (entry !== name || !/^\d+$/.test(uid ?? '') || !/^\d+$/.test(gid ?? '') || !path.isAbsolute(home ?? '')) return null;
    return { name, uid: Number(uid), gid: Number(gid), home };
  };

  /** The human, front door and agent accounts, each a different non-root account; null otherwise. */
  const separation = async () => {
    let config;
    try {
      config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch {
      return null;
    }
    const named = hostConfigSchema.safeParse(config);
    if (!named.success) return null;
    const { owner, separation: { frontDoor, agent: agentName } } = named.data;
    const [human, front, agent] = await Promise.all([owner, frontDoor, agentName].map(account));
    if (!human || !front || !agent || new Set([0, human.uid, front.uid, agent.uid]).size !== 4) return null;
    // An agent or front door that can become root some other way is no separation from root.
    for (const { name } of [front, agent]) {
      const groups = await run('/usr/bin/id', ['-Gn', '--', name]);
      if (groups.code !== 0 || groups.stdout.trim().split(/\s+/).some((group) => ROOT_EQUIVALENT_GROUPS.includes(group))) return null;
    }
    return { human, front, agent };
  };
  const requireSeparation = async () => {
    const accounts = await separation();
    if (!accounts) throw new SpaceError('agent_separation_missing', 'Root spaces and project sharing need OpenChamber installed with its agent on an account of its own (install --separation)');
    return accounts;
  };

  const status = async () => {
    const approved = await store.list();
    if (!await separation()) return { available: false, reason: 'agent_separation_missing', passkeys: approved };
    return { available: approved.length > 0, reason: approved.length > 0 ? null : 'no_passkey_approved', passkeys: approved };
  };

  const hashOf = (spec) => activationSpecHash({ place: ROOT_PLACE, id: spec.id, name: spec.name, project: spec.project, purpose: spec.purpose ?? 'general', memoryBytes: spec.memoryBytes });
  const requireGeneral = (spec) => {
    if ((spec.purpose ?? 'general') !== 'general') throw new SpaceError('root_place_not_allowed', 'An approval worker never runs as root');
  };

  /** A one-time challenge for a creation of exactly this spec, or a start of the space hostd recorded. */
  const activationOptions = (request) => translated(async () => {
    await requireSeparation();
    let spec;
    if (request.action === 'create') {
      spec = request.spec;
      if (await state.read(spec.id)) throw new SpaceError('space_name_taken', 'This host space id is already in use');
    } else {
      spec = await state.requireRecord(ROOT_PLACE, request.id);
    }
    requireGeneral(spec);
    return store.activationOptions({ op: request.action, id: spec.id, specHash: hashOf(spec) });
  });

  /** The lifecycle's check before a root space is created or started: a fresh assertion made for exactly this. */
  const authorize = ({ op, id, spec, assertion }) => translated(async () => {
    await requireSeparation();
    requireGeneral(spec);
    if (!assertion) throw new SpaceError('root_activation_required', 'A root space is created or started only with a passkey confirmation made for it');
    await store.verifyActivation({ op, id, specHash: hashOf(spec), response: assertion });
  });

  // One change of the shares at a time: each rewrites the list of shares.
  let sharing = Promise.resolve();
  const withSharing = (work) => {
    const result = sharing.then(() => translated(async () => {
      const { human, agent } = await requireSeparation();
      return work(createProjectSharing({ human, agent, run, statePath: path.join(paths.state, 'shares.json'), readMountInfo }));
    }));
    sharing = result.catch(() => {});
    return result;
  };

  /** One of `ROOT_OPERATIONS`, as `parseRequest` of `validation.js` checked it. */
  const handle = (request) => {
    switch (request.op) {
      case 'root-status': return status();
      case 'root-approval-challenge': return translated(() => store.approvalChallenge({ code: request.code }));
      case 'root-approval-complete': return translated(() => store.completeApproval(request));
      case 'root-activation-options': return activationOptions(request);
      case 'share-project': return withSharing((projects) => projects.share(request.path));
      case 'unshare-project': return withSharing((projects) => projects.unshare(request.path));
      case 'project-owner': return withSharing(async (projects) => ({ owner: await projects.ownerOf(request.path) }));
      case 'project-shares': return withSharing((projects) => projects.list());
      default: throw new SpaceError('invalid_request', 'Unknown hostd operation');
    }
  };

  return { handle, authorize, status, separation };
}
