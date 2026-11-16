import net from 'node:net';

export function readAgentServerMode(env = process.env) {
  const raw = env.OPENCHAMBER_AGENT_SERVER_URL;
  const token = env.OPENCHAMBER_AGENT_SERVER_TOKEN;
  const agent = env.OPENCHAMBER_AGENT_SERVER === '1';
  if (!raw && !token) return { frontDoor: false, agent, upstream: null };
  if (!raw || !token?.trim()) throw new Error('Front door requires OPENCHAMBER_AGENT_SERVER_URL and OPENCHAMBER_AGENT_SERVER_TOKEN.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('OPENCHAMBER_AGENT_SERVER_URL must be a loopback HTTP origin.'); }
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || (net.isIP(host) === 4 && host.startsWith('127.'));
  if (agent || url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('OPENCHAMBER_AGENT_SERVER_URL must be a loopback HTTP origin, without credentials, path, query or fragment; agent and front door modes are exclusive.');
  }
  // A configured localhost cannot be redirected through DNS or a proxy environment variable.
  if (host === 'localhost') url.hostname = '127.0.0.1';
  return { frontDoor: true, agent: false, upstream: { url: url.origin, token } };
}

export const FRONT_DOOR_DISABLED_RUNTIMES = Object.freeze([
  'managedOpenCode', 'sessionAssist', 'sessionGoal', 'contextObligatory', 'sessionWarming',
  'sessionKnowledge', 'sessionWork', 'sessionInterruption', 'autoResume', 'automationAdmission',
  'permissionAutoAccept', 'autoReview', 'messageQueue', 'prStackRestack',
  'dispatchResults', 'prWatch', 'mergeFollow', 'workflow', 'workflowAgentSessions',
  'messageSearch', 'scheduledTasks', 'scheduledTaskService', 'suggestedTasks', 'sessionTodos',
  'extensionWaits', 'laterPages', 'sharePages', 'receivedPages',
  'browserControlBroker', 'browserControlRouter', 'agentTool', 'limitFailover', 'routing',
  'managedConfig', 'guestServices', 'guestSurface', 'extensionSessionEvents', 'extensionServiceLifetime', 'memoryDreaming',
  'extensionNotificationChannels', 'trackerSessionStatus', 'turnDurationRecorder',
  'projectContext', 'agentMemory', 'projectConfig', 'environment', 'terminal', 'devTunnel',
]);

export const AGENT_DISABLED_FEATURES = Object.freeze([
  'pushDelivery', 'relayHost', 'tunnels', 'spaces', 'protectedMcpAdmin', 'updateInstall',
]);

export function createAgentTunnelContext() {
  let port = null;
  return {
    getActivePort: () => port,
    setActivePort: (value) => { port = value; },
    tunnelService: { getPublicUrl: () => null },
    startTunnelWithNormalizedRequest: async () => { throw new Error('agent_feature_disabled'); },
  };
}
