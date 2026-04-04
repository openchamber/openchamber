export const createBootstrapRuntime = (dependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    express,
  } = dependencies;

  const setupBaseRoutes = (app, options) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      uiPassword,
      tunnelAuthController,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      resolveZenModel,
      sayTTSCapability,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      updateUiVisibility,
      isUiVisible,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
    } = options;

    registerServerStatusRoutes(app, {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
    });

    registerCommonRequestMiddleware(app, { express });

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerAuthAndAccessRoutes(app, {
      tunnelAuthController,
      uiAuthController,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    registerTtsRoutes(app, { resolveZenModel, sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      updateUiVisibility,
      isUiVisible,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
