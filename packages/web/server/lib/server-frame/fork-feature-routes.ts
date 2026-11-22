// The fork's feature routes, registered in one call from the shared feature
// router so an upstream sync only has to keep that call.
import { registerGoalSpecJobRoutes } from '../session-goal/spec-jobs.js';
import { registerDeviceSettingsRoutes } from '../device-settings/routes.js';
import { registerModelChoiceRoutes } from '../model-choices/routes.js';
import { registerModelPoolRoutes, type ModelPoolRouteDependencies } from '../routing/model-pool-routes.js';
import type { registerSourceControlRoutes } from '../source-control/routes.js';
import type { registerGuestRoutes } from '../guests/routes.js';
import type { registerLinearRoutes } from '../linear/routes.js';
import type { Application } from '../shared/http-contracts.js';

export type ForkFeatureRouteDependencies = ModelPoolRouteDependencies & {
  deviceSettingsStore?: Parameters<typeof registerDeviceSettingsRoutes>[1]['store'] | null;
  modelChoiceService?: Parameters<typeof registerModelChoiceRoutes>[1]['modelChoiceService'] | null;
  goalSpecJobRuntime?: Parameters<typeof registerGoalSpecJobRoutes>[1] | null;
};

export const registerForkFeatureRoutes = (app: Application, {
  deviceSettingsStore = null,
  modelChoiceService = null,
  goalSpecJobRuntime = null,
  ...modelPools
}: ForkFeatureRouteDependencies) => {
  if (goalSpecJobRuntime) registerGoalSpecJobRoutes(app, goalSpecJobRuntime);
  registerModelPoolRoutes(app, modelPools);
  if (deviceSettingsStore) registerDeviceSettingsRoutes(app, { store: deviceSettingsStore });
  if (modelChoiceService) registerModelChoiceRoutes(app, { modelChoiceService });
};

/**
 * The integration operations the routes use, for the `openchamber` agent tool;
 * null until the routes are registered.
 */
export const integrationOperationsOf = ({ sourceControl, guests, linear }: {
  sourceControl: ReturnType<typeof registerSourceControlRoutes> | null;
  guests: ReturnType<typeof registerGuestRoutes> | null;
  linear: ReturnType<typeof registerLinearRoutes> | null;
}) => (sourceControl && guests && linear
  ? {
      github: sourceControl.accountOperations.github,
      gitlab: sourceControl.accountOperations.gitlab,
      bindings: sourceControl.bindingOperations,
      linear,
      extensions: guests,
    }
  : null);
