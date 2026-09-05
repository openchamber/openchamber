import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerGitRoutes = vi.fn();
const noopRoute = vi.fn();

vi.mock('../git/routes.js', () => ({
  registerGitRoutes,
}));

vi.mock('../fs/routes.js', () => ({ registerFsRoutes: noopRoute }));
vi.mock('../quota/routes.js', () => ({ registerQuotaRoutes: noopRoute }));
vi.mock('../small-model/routes.js', () => ({ registerSmallModelRoutes: noopRoute }));
vi.mock('../walkthrough/routes.js', () => ({ registerWalkthroughRoutes: noopRoute }));
vi.mock('../session-goal/routes.js', () => ({ registerSessionGoalRoutes: noopRoute }));
vi.mock('../github/routes.js', () => ({ registerGitHubRoutes: noopRoute }));
vi.mock('../linear/routes.js', () => ({ registerLinearRoutes: noopRoute }));
vi.mock('../dev-servers/routes.js', () => ({ registerDevServerRoutes: noopRoute }));
vi.mock('../magic-prompts/routes.js', () => ({ registerMagicPromptRoutes: noopRoute }));
vi.mock('../session-folders/routes.js', () => ({ registerSessionFoldersRoutes: noopRoute }));
vi.mock('../project-context/routes.js', () => ({ registerProjectContextRoutes: noopRoute }));
vi.mock('../agent-memory/routes.js', () => ({ registerAgentMemoryRoutes: noopRoute }));
vi.mock('../session-knowledge/routes.js', () => ({ registerSessionKnowledgeRoutes: noopRoute }));
vi.mock('../permission-auto-accept/runtime.js', () => ({ registerPermissionAutoAcceptRoutes: noopRoute }));
vi.mock('./config-entity-routes.js', () => ({ registerConfigEntityRoutes: noopRoute }));
vi.mock('./core-routes.js', () => ({ registerSettingsUtilityRoutes: noopRoute }));
vi.mock('./project-icon-routes.js', () => ({ registerProjectIconRoutes: noopRoute }));
vi.mock('../scheduled-tasks/routes.js', () => ({ registerScheduledTaskRoutes: noopRoute }));
vi.mock('../openchamber-sessions/routes.js', () => ({ registerOpenChamberSessionRoutes: noopRoute }));
vi.mock('../openchamber-control/routes.js', () => ({ registerOpenChamberControlRoutes: noopRoute }));
vi.mock('../markdown-image-grants/routes.js', () => ({ registerMarkdownImageGrantRoutes: noopRoute }));
vi.mock('./skill-routes.js', () => ({ registerSkillRoutes: noopRoute }));
vi.mock('./plugin-routes.js', () => ({ registerPluginRoutes: noopRoute }));
vi.mock('./routes.js', () => ({ registerOpenCodeRoutes: noopRoute }));

vi.mock('../git/index.js', () => ({
  getProfiles: vi.fn(),
  getProfile: vi.fn(),
}));

const { createFeatureRoutesRuntime } = await import('./feature-routes-runtime.js');

const createApp = () => ({
  get() {},
  post() {},
  put() {},
  delete() {},
});

const createRouteDependencies = (broadcastGlobalUiEvent) => ({
  crypto: {},
  fs: {},
  os: {},
  path: {},
  fsPromises: {},
  spawn: vi.fn(),
  resolveGitBinaryForSpawn: vi.fn(),
  createFsSearchRuntime: vi.fn(),
  openchamberDataDir: '/tmp/openchamber',
  openchamberUserConfigRoot: '/tmp/openchamber/config',
  normalizeDirectoryPath: vi.fn(),
  resolveProjectDirectory: vi.fn(),
  resolveOptionalProjectDirectory: vi.fn(),
  validateDirectoryPath: vi.fn(),
  readCustomThemesFromDisk: vi.fn(),
  refreshOpenCodeAfterConfigChange: vi.fn(),
  getOpenCodeResolutionSnapshot: vi.fn(),
  getOpenCodeUpgradeCapability: vi.fn(),
  formatSettingsResponse: vi.fn(),
  readSettingsFromDisk: vi.fn(),
  readSettingsFromDiskMigrated: vi.fn(),
  persistSettings: vi.fn(),
  sanitizeProjects: vi.fn(),
  sanitizeSkillCatalogs: vi.fn(),
  isUnsafeSkillRelativePath: vi.fn(),
  buildOpenCodeUrl: vi.fn(),
  getOpenCodeAuthHeaders: vi.fn(),
  getOpenCodePort: vi.fn(),
  getOwnPorts: vi.fn(),
  devServerScanner: {},
  buildAugmentedPath: vi.fn(),
  projectConfigRuntime: {},
  projectContextRuntime: {},
  agentMemoryRuntime: {},
  isAgentMemoryEnabled: vi.fn(),
  sessionKnowledgeRuntime: {},
  scheduledTasksRuntime: {},
  scheduledTaskService: {},
  openChamberSessionService: {},
  openChamberControlService: {},
  waitForOpenCodeReady: vi.fn(),
  getOpenChamberEventClients: vi.fn(),
  writeSseEvent: vi.fn(),
  emitSessionCreatedEvent: vi.fn(),
  permissionAutoAcceptRuntime: {},
  broadcastGlobalUiEvent,
});

describe('createFeatureRoutesRuntime', () => {
  beforeEach(() => {
    registerGitRoutes.mockReset();
    noopRoute.mockClear();
  });

  it('forwards broadcastGlobalUiEvent into git route registration', async () => {
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createFeatureRoutesRuntime({ clientReloadDelayMs: 10 });

    await runtime.registerRoutes(createApp(), createRouteDependencies(broadcastGlobalUiEvent));

    expect(registerGitRoutes).toHaveBeenCalledWith(expect.any(Object), {
      broadcastGlobalUiEvent,
    });
  });
});
