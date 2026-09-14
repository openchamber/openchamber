const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const refuse = (message, code = 'GIT_AGENT_OPERATION_REFUSED') => Object.assign(new Error(message), {
  code,
  status: 409,
});

/** A grant the binding still vouches for against the repository's current remotes. */
const readyGrant = (read, name) => {
  const grant = read.binding?.remotes.find((entry) => entry.name === name);
  const current = read.repository.remotes.find((entry) => entry.name === name);
  if (!grant || !current) return null;
  if (grant.readiness !== 'ready') return null;
  if (grant.fetch.fingerprint !== current.fetch.fingerprint
    || grant.push.fingerprint !== current.push.fingerprint) return null;
  return grant;
};

/**
 * The remote to act on: the one asked for, the only one that is bound, or
 * `origin` when several are. Guessing between several unnamed remotes is how a
 * push lands somewhere nobody chose.
 */
const chooseRemote = (read, requested) => {
  const grants = read.binding?.remotes ?? [];
  if (requested) {
    const grant = readyGrant(read, requested);
    if (!grant) {
      throw refuse(`Remote ${requested} has no ready transport in this repository's binding.`
        + ' Configure it in the Git panel, or name a remote that is bound.');
    }
    return grant;
  }
  const ready = grants.map((grant) => readyGrant(read, grant.name)).filter(Boolean);
  if (ready.length === 1) return ready[0];
  const origin = ready.find((grant) => grant.name === 'origin');
  if (origin) return origin;
  throw refuse(ready.length
    ? `This repository has several bound remotes (${ready.map((grant) => grant.name).join(', ')}). Name the one to use.`
    : 'This repository has no transport configured. Configure it in the Git panel before transferring.');
};

const headBranch = (status) => {
  const branch = isString(status?.current) ? status.current.trim() : '';
  if (!branch || branch === 'HEAD') {
    throw refuse('HEAD is detached, so there is no branch to transfer. Check out a branch first.');
  }
  return branch;
};

const trackedBranch = (status, remoteName) => {
  const tracking = isString(status?.tracking) ? status.tracking.trim() : '';
  const prefix = `${remoteName}/`;
  if (!tracking.startsWith(prefix) || tracking.length === prefix.length) {
    throw refuse(`The current branch does not track a branch on ${remoteName}.`
      + ' Push it from the Git panel first, which also sets the upstream.');
  }
  return tracking.slice(prefix.length);
};

/**
 * Managed Git transfers for the agent.
 *
 * The agent gets the same planned operation the Git panel runs — the binding
 * decides the account and transport, the process runs with a scrubbed
 * environment, and the credential lives for one operation. Anything that needs
 * a person's decision is refused with what to do instead, rather than being
 * decided on their behalf: an unbound repository, an unacknowledged System Git
 * transport, a branch with no upstream, a contributor fork.
 */
export function createGitAgentOperations({ networkOperations, readBinding, readStatus }) {
  if (!networkOperations || !(readBinding instanceof Function) || !(readStatus instanceof Function)) {
    throw new TypeError('Git agent operation dependencies are invalid');
  }

  const authority = async (directory, requestedRemote) => {
    const read = await readBinding(directory);
    if (read.status === 'missing' || !read.binding) {
      throw refuse('This repository is not bound to a source control account or transport.'
        + ' Configure it in the Git panel before transferring.');
    }
    const grant = chooseRemote(read, requestedRemote);
    return {
      read,
      grant,
      repository: {
        directory,
        repositoryId: read.binding.repositoryId,
        bindingRevision: read.binding.revision,
        configRevision: read.repository.configRevision,
      },
    };
  };

  const run = async (request) => {
    const plan = await networkOperations.plan(request);
    return networkOperations.execute(plan.operationId);
  };

  const buildRequest = async (action, { directory, remote }) => {
    const { grant, repository } = await authority(directory, remote);
    if (action === 'fetch') {
      return {
        operation: 'fetch',
        fetchScope: 'remote',
        ...repository,
        remote: { name: grant.name, endpoint: grant.fetch },
        transportMode: grant.mode,
      };
    }
    const status = await readStatus(directory);
    const branch = headBranch(status);
    if (action === 'pull') {
      return {
        operation: 'pull',
        ...repository,
        remote: { name: grant.name, endpoint: grant.fetch },
        sourceRef: `refs/heads/${trackedBranch(status, grant.name)}`,
        destinationRef: `refs/heads/${branch}`,
        transportMode: grant.mode,
      };
    }
    if (grant.mode === 'anonymous') {
      throw refuse(`Remote ${grant.name} is bound as anonymous read-only, so it cannot be pushed to.`);
    }
    return {
      operation: 'push',
      ...repository,
      remote: { name: grant.name, endpoint: grant.push },
      sourceRef: `refs/heads/${branch}`,
      destinationRef: `refs/heads/${trackedBranch(status, grant.name)}`,
      transportMode: grant.mode,
    };
  };

  return Object.freeze({
    execute: async (action, input) => {
      const directory = isString(input?.directory) ? input.directory.trim() : '';
      if (!directory) throw refuse('directory is required', 'INVALID_REQUEST');
      const remote = isString(input?.remote) ? input.remote.trim() : '';
      if (!['push', 'pull', 'fetch'].includes(action)) {
        throw refuse(`Unsupported Git operation: ${action}`, 'INVALID_REQUEST');
      }
      const request = await buildRequest(action, { directory, remote });
      const result = await run(request);
      return {
        operation: action,
        remote: request.remote.name,
        transport: request.transportMode,
        state: result.state,
        completedSteps: result.completedSteps ?? [],
      };
    },
  });
}
