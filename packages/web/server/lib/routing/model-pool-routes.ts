// The fork's model pool routes (pools, their stats, plans, health, rotation and
// route rules), registered together so the shared feature router only wires
// them in.
import { registerModelRouteRoutes } from './model-routes.js';
import { registerModelRouteStatsRoutes } from './model-route-stats.js';
import { registerMessageModelAttributionRoutes } from './message-model-attribution.js';
import { registerPlanRoutes } from './plan-routes.js';
import { registerPoolPlanLinkRoutes } from './pool-plan-links.js';
import { isLocalOpenCode, registerPoolHealthRoutes } from './pool-health.js';
import { registerPoolRotation } from './pool-rotation.js';
import { registerRouteRulesRoutes } from './route-rules-routes.js';
import { createJevClient } from './jev.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { CONFIG_FILE, getConfigForPath, readConfigLayers, writeConfig } from '../opencode/config-files.js';
import { readConfigSources } from '../opencode/config-sources.js';
import type { registerRoutingRoutes } from './routes.js';
import type { registerSettingsUtilityRoutes } from '../server-frame/core-routes.js';
import type { Application } from '../shared/http-contracts.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type { createOpenCodeNetworkRuntime } from '../opencode/network-runtime.js';

export type ModelPoolRouteDependencies = {
  openchamberDataDir: string;
  routingRuntime: Parameters<typeof registerRoutingRoutes>[1];
  refreshOpenCodeAfterConfigChange: Parameters<typeof registerSettingsUtilityRoutes>[1]['refreshOpenCodeAfterConfigChange'];
  resolveOptionalProjectDirectory: ReturnType<typeof createProjectDirectoryRuntime>['resolveOptionalProjectDirectory'];
  buildOpenCodeUrl: ReturnType<typeof createOpenCodeNetworkRuntime>['buildOpenCodeUrl'];
  getOpenCodeAuthHeaders: () => Record<string, string>;
};

export const registerModelPoolRoutes = (app: Application, {
  openchamberDataDir,
  routingRuntime,
  refreshOpenCodeAfterConfigChange,
  resolveOptionalProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
}: ModelPoolRouteDependencies) => {
  const isOpenCodeLocal = () => isLocalOpenCode(buildOpenCodeUrl);
  registerModelRouteRoutes(app, {
    readConfigLayers,
    getConfigForPath,
    writeConfig,
    CONFIG_FILE,
    isEnterpriseMode,
    refreshOpenCodeAfterConfigChange,
    resolveOptionalProjectDirectory,
    readConfigSources,
  });
  registerModelRouteStatsRoutes(app, { isOpenCodeLocal });
  registerMessageModelAttributionRoutes(app, { isOpenCodeLocal });
  registerPlanRoutes(app);
  registerPoolPlanLinkRoutes(app, { openchamberDataDir });
  registerPoolHealthRoutes(app, { readConfigLayers, openchamberDataDir, isOpenCodeLocal });
  registerPoolRotation(app, {
    readConfigLayers,
    readConfigSources,
    openchamberDataDir,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    isAutoSession: routingRuntime.isAutoSession,
    isOpenCodeLocal,
  });
  registerRouteRulesRoutes(app, { routingRuntime, jev: createJevClient() });
};
