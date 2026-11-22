/**
 * Environment actions for the `openchamber` control tool: the variables
 * OpenChamber gives the processes it starts (`../environment`), for the user
 * and per project.
 *
 * An agent sees every variable's name, and the reference of a variable whose
 * value is a vault reference (`op://…`), with that reference's last read. It
 * never sees a plain value. It sets a variable only to a vault reference, or
 * removes one: a plain value could be a secret, and the user types those in
 * Settings. The secret behind a reference is read by OpenChamber, never by
 * the agent.
 *
 * Dependencies (`createEnvironmentActions(deps)`), from packages/web/server/index.js:
 * - `store` — `environmentStore`.
 * - `runtime` — `environmentRuntime` (`vaultStatus`, `invalidateProject`).
 * - `listProjects` — `listConfiguredProjects`; a project id must name a configured project.
 */
import { asNonEmptyString, isPlainObject } from '../shared/guards.js';
import { EnvironmentPatchError } from '../environment/store.js';
import { isVaultReference } from '../environment/vault.js';
import { OpenChamberControlError } from './error.js';

export const ENVIRONMENT_ACTION_DEFINITIONS = Object.freeze([
  { action: 'environment.get', title: 'Read environment variables', description: 'List the environment variables OpenChamber gives OpenCode, Git, the terminal and project actions: the user\'s, or projectId\'s. Answers names, the reference of each variable that is a vault reference (op://vault/item/field, read from 1Password when needed) and whether its last read worked. Plain values are never shown' },
  { action: 'environment.set', title: 'Change environment variables', description: 'Set environment variables for the user, or for projectId: environmentVariables maps a name to a vault reference (op://vault/item/field) or to null to remove it. A plain value is refused, since it could be a secret; the user types those in Settings. The managed OpenCode picks up a change when it restarts (opencode.reload)' },
]);

export const ENVIRONMENT_PARAMETERS = {
  environmentVariables: { type: 'object', description: 'environment.set: variable name to a vault reference (op://vault/item/field) or null to remove it' },
};

const ENVIRONMENT_ACTIONS = ENVIRONMENT_ACTION_DEFINITIONS.map(({ action }) => action);

export const createEnvironmentActions = ({ store, runtime, listProjects }) => {
  const resolveProjectId = async (input) => {
    const projectId = asNonEmptyString(input.projectId);
    if (!projectId) return null;
    const known = (await listProjects()).some((project) => project.id === projectId);
    if (!known) throw new OpenChamberControlError(`Unknown project: ${projectId}`, 404);
    return projectId;
  };

  const view = (names, variables) => {
    const references = Object.fromEntries(Object.entries(variables).filter(([, value]) => isVaultReference(value)));
    const statuses = runtime.vaultStatus(variables);
    return {
      names,
      references,
      vault: Object.fromEntries(Object.keys(references).filter((name) => Object.hasOwn(statuses, name) && statuses[name]).map((name) => [name, statuses[name]])),
    };
  };

  const describe = (projectId) => (projectId
    ? { projectId, ...view(store.describeProject(projectId).names, store.projectEntry(projectId).variables) }
    : view(store.describeUser().names, store.userVariables()));

  const environmentGet = async (input) => describe(await resolveProjectId(input));

  const environmentSet = async (input) => {
    const projectId = await resolveProjectId(input);
    const changes = input.environmentVariables;
    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw new OpenChamberControlError('environmentVariables must map one or more names to a vault reference or null', 400);
    }
    const plain = Object.entries(changes).filter(([, value]) => value !== null && !isVaultReference(value)).map(([name]) => name);
    if (plain.length > 0) {
      throw new OpenChamberControlError(`Nothing was saved. ${plain.join(', ')}: only a vault reference (op://vault/item/field) or null can be set here; the user types plain values in Settings`, 400);
    }
    try {
      if (projectId) {
        await store.updateProject(projectId, { variables: changes });
        runtime.invalidateProject(projectId);
      } else {
        await store.updateUser({ variables: changes });
      }
    } catch (error) {
      if (error instanceof EnvironmentPatchError) throw new OpenChamberControlError(`Nothing was saved. ${error.message}`, 400);
      throw error;
    }
    return {
      ...describe(projectId),
      note: projectId
        ? 'Saved. Git, the terminal and project actions in this project read it on their next run'
        : 'Saved. Git, the terminal and project actions read it on their next run; the managed OpenCode reads it when it restarts (opencode.reload)',
    };
  };

  const execute = async (action, input = {}) => {
    switch (action) {
      case 'environment.get': return environmentGet(input);
      case 'environment.set': return environmentSet(input);
      default: throw new OpenChamberControlError(`Unsupported environment action: ${action || 'missing'}`, 400);
    }
  };

  return { actions: ENVIRONMENT_ACTIONS, execute };
};
