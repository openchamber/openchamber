import { domainToASCII } from 'node:url';

import { createRelayIdentityRuntime } from '../relay/identity.js';
import { createDirectE2eeService, DIRECT_E2EE_PATH } from './service.js';

const canonicalPublicUrl = (value) => {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (!hostname || hostname.endsWith('.') || domainToASCII(hostname) !== hostname) return null;
    if (url.port && url.port !== '443') return null;
    url.pathname = '/';
    url.port = '';
    return url;
  } catch {
    return null;
  }
};

export const createDirectE2eeRuntime = ({
  crypto,
  httpServer,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  readManagedRemoteTunnelConfigFromDisk,
  getActiveTunnelController,
  getLocalPort,
  internalTransportMarker,
  authenticateBearerToken,
  logger = console,
  createService = createDirectE2eeService,
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk });
  let activeProfile = null;
  let lastPublishedProfile = null;
  let initialized = false;
  let refreshGeneration = 0;
  let lifecycleGeneration = 0;

  const controllerSnapshot = () => {
    const controller = getActiveTunnelController();
    const publicUrl = canonicalPublicUrl(controller?.getPublicUrl?.());
    const profileId = typeof controller?.managedRemoteTunnelPresetId === 'string'
      ? controller.managedRemoteTunnelPresetId
      : '';
    return { controller, mode: controller?.mode, profileId, publicUrl };
  };

  const snapshotKey = (snapshot) => snapshot
    ? `${snapshot.mode || ''}\n${snapshot.profileId}\n${snapshot.publicUrl?.toString() || ''}`
    : null;

  const resolveActiveProfile = (snapshot, config) => {
    const { mode, profileId, publicUrl } = snapshot;
    if (mode !== 'managed-remote' || !publicUrl) return null;
    let profile = null;
    if (profileId) {
      profile = config.tunnels.find((entry) => entry.id === profileId) || null;
    } else {
      const matches = config.tunnels.filter((entry) =>
        entry.directE2eeEnabled === true && entry.hostname === publicUrl.hostname);
      if (matches.length === 1) profile = matches[0];
    }
    if (!profile || profile.directE2eeEnabled !== true || profile.hostname !== publicUrl.hostname) return null;
    return {
      id: profile.id,
      name: profile.name,
      hostname: profile.hostname,
      directE2eeEnabled: true,
      mode,
      publicUrl: publicUrl.toString().replace(/\/$/, ''),
    };
  };

  const activeProfileKey = (profile) => profile
    ? `${profile.id}\n${profile.mode}\n${profile.hostname}\n${profile.publicUrl}`
    : null;

  const refresh = async ({ closePreviousReason = null, reason = null } = {}) => {
    const effectiveCloseReason = closePreviousReason || reason;
    const generation = ++refreshGeneration;
    const snapshot = controllerSnapshot();
    activeProfile = null;
    let config;
    try {
      config = await readManagedRemoteTunnelConfigFromDisk();
    } catch (error) {
      if (generation === refreshGeneration) activeProfile = null;
      throw error;
    }
    if (generation !== refreshGeneration || snapshotKey(snapshot) !== snapshotKey(controllerSnapshot())) {
      return activeProfile;
    }
    const nextProfile = resolveActiveProfile(snapshot, config);
    if (effectiveCloseReason && lastPublishedProfile
      && activeProfileKey(lastPublishedProfile) !== activeProfileKey(nextProfile)) {
      service.closeProfile(lastPublishedProfile.id, effectiveCloseReason);
    }
    activeProfile = nextProfile;
    lastPublishedProfile = nextProfile;
    return activeProfile;
  };

  const service = createService({
    getActiveProfile: () => activeProfile,
    getRelayIdentity: () => identityRuntime.getRelayIdentity(),
    getLocalPort,
    internalTransportMarker,
    authenticateBearerToken: async (token) => {
      const result = await authenticateBearerToken(token);
      return result ? { ok: true, ...result } : null;
    },
    logger,
  });

  return {
    async initialize() {
      if (initialized) return;
      const generation = lifecycleGeneration;
      await refresh();
      if (generation !== lifecycleGeneration) return;
      service.attach(httpServer);
      initialized = true;
    },
    stop() {
      lifecycleGeneration += 1;
      refreshGeneration += 1;
      initialized = false;
      activeProfile = null;
      lastPublishedProfile = null;
      service.detach();
    },
    async refresh(options) {
      return refresh(options);
    },
    async getPairingCandidate() {
      const profile = activeProfile;
      if (!initialized || !profile) return null;
      const identity = await identityRuntime.getRelayIdentity();
      return {
        type: 'direct-e2ee',
        wssUrl: `wss://${profile.hostname}${DIRECT_E2EE_PATH}`,
        hostEncPubJwk: identity.hostEncPubJwk,
        priority: 20,
      };
    },
    isAvailable() {
      return initialized && activeProfile !== null;
    },
    getPairingState() {
      if (!initialized || !activeProfile) return null;
      return { suppressOrigin: activeProfile.publicUrl };
    },
    deactivate(reason = 'tunnel-stopped') {
      lifecycleGeneration += 1;
      refreshGeneration += 1;
      activeProfile = null;
      lastPublishedProfile = null;
      service.closeAll(reason);
    },
    isAvailableFor({ profile, publicUrl, activeMode }) {
      const canonical = canonicalPublicUrl(publicUrl);
      return initialized
        && activeMode === 'managed-remote'
        && profile?.id === activeProfile?.id
        && profile?.directE2eeEnabled === true
        && canonical?.hostname === profile.hostname
        && canonical.hostname === activeProfile.hostname;
    },
    closeProfile: (profileId, reason) => service.closeProfile(profileId, reason),
    closeAll: (reason) => service.closeAll(reason),
    revokeClient: (clientId) => service.revokeClient(clientId),
    getActiveSessionCount: (profileId) => service.getActiveSessionCount(profileId),
    get initialized() { return initialized; },
  };
};
