import path from 'node:path';

export const SERVICE_USER = 'openchamber-mcp';
export const CLIENT_GROUP = 'openchamber-mcp-clients';
export const ADMIN_GROUP = 'openchamber-mcp-admins';
export const UNIT_NAME = 'openchamber-protected-mcp.service';
// Where a unit that runs agents finds its subject's directory, bound read-only by systemd.
export const SUBJECT_BIND_PATH = '/run/openchamber-mcp';

/** Where everything lives, below an optional root for disposable test installs. */
export function layout(root = '/') {
  const at = (target) => path.join(root, target);
  return {
    installDir: at('/usr/lib/openchamber-protected-mcp'),
    configDir: at('/etc/openchamber/protected-mcp'),
    serviceConfig: at('/etc/openchamber/protected-mcp/service.json'),
    clientConfig: at('/etc/openchamber/protected-mcp/client.json'),
    agentClientConfig: at('/etc/openchamber/protected-mcp/agent-client.json'),
    stateDir: at('/var/lib/openchamber-protected-mcp'),
    engineSocket: at('/run/openchamber-protected-mcp/engine.sock'),
    unitFile: at(`/etc/systemd/system/${UNIT_NAME}`),
    tmpfilesFile: at('/etc/tmpfiles.d/openchamber-protected-mcp.conf'),
    live: {
      installDir: '/usr/lib/openchamber-protected-mcp',
      configDir: '/etc/openchamber/protected-mcp',
      stateDir: '/var/lib/openchamber-protected-mcp',
      engineSocket: '/run/openchamber-protected-mcp/engine.sock',
      subjectsDir: '/run/openchamber-protected-mcp/subjects',
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock',
      serviceConfig: '/etc/openchamber/protected-mcp/service.json',
      agentClientConfig: '/etc/openchamber/protected-mcp/agent-client.json',
    },
  };
}

/**
 * The folders of the service's runtime directory down to the agents' subject, made at every boot
 * before any service starts. The agent unit binds the subject folder when it starts; a folder
 * that is missing then is skipped, and the socket the service creates later never shows inside.
 * With the folder in place the bind holds, and the socket appears in it once the service listens.
 */
export function tmpfilesFile({ subjectsDir }) {
  return [
    `d ${path.dirname(subjectsDir)} 0750 ${SERVICE_USER} ${SERVICE_USER} -`,
    `d ${subjectsDir} 0700 ${SERVICE_USER} ${SERVICE_USER} -`,
    `d ${subjectsDir}/agent 0711 ${SERVICE_USER} ${SERVICE_USER} -`,
    '',
  ].join('\n');
}

/** The service writes only its state and runtime directories, without capabilities. */
export function unitFile({ node, live }) {
  return `[Unit]
Description=OpenChamber protected MCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=${CLIENT_GROUP} ${ADMIN_GROUP}
ExecStart=${node} ${live.installDir}/current/lib/protected-mcp/service/main.js --config ${live.serviceConfig}
WorkingDirectory=${live.stateDir}
StateDirectory=openchamber-protected-mcp
StateDirectoryMode=0700
RuntimeDirectory=openchamber-protected-mcp openchamber-protected-mcp-admin
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitCORE=0
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}
