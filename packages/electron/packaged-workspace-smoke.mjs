import crypto from 'node:crypto';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

const bodyHash = (value) => crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

export const runPackagedWorkspaceSmoke = async ({ baseUrl, clientToken, password, directory, runtimeImage, gatewayImage, fetchImpl = fetch }) => {
  for (const [name, value] of Object.entries({ baseUrl, clientToken, password, directory, runtimeImage, gatewayImage })) {
    if (typeof value !== 'string' || !value) throw new Error(`Packaged workspace smoke requires ${name}`);
  }
  const request = async (route, { method = 'GET', body, proof } = {}) => {
    const response = await fetchImpl(new URL(route, baseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${clientToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(proof ? { 'X-OpenChamber-Reauth-Proof': proof.proof, 'X-OpenChamber-Reauth-Nonce': proof.nonce } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  };
  const reauthenticate = async (operation, project, payload) => {
    const binding = { operation, project, bodyHash: bodyHash(payload), nonce: crypto.randomUUID(), password };
    const result = await request('/auth/reauth', { method: 'POST', body: binding });
    if (!result.ok || typeof result.payload?.proof !== 'string' || typeof result.payload?.nonce !== 'string') {
      throw new Error(`Packaged workspace reauthentication failed for ${operation}`);
    }
    return { proof: result.payload.proof, nonce: result.payload.nonce };
  };

  const changes = {
    secureWorkspacesEnabled: true,
    secureWorkspacesRequirePinnedImage: true,
    secureWorkspacesDefaultProvider: 'docker',
    secureWorkspacesImage: runtimeImage,
    secureWorkspacesAllowedImages: runtimeImage,
    secureWorkspacesGatewayImage: gatewayImage,
    secureWorkspacesEgressMode: 'managed',
    secureWorkspacesEgressPreset: 'restricted',
    secureWorkspacesEgressAllowedPorts: '443',
    secureWorkspacesModelAuth: 'none',
    secureWorkspacesRetentionPreserveOnDelete: false,
    secureWorkspacesDockerMemoryLimit: '2g',
    secureWorkspacesDockerCpuLimit: '2',
    secureWorkspacesDockerPidsLimit: 512,
  };
  const configureBody = { changes, activate: true };
  const configureProof = await reauthenticate('workspace.configure', 'host', configureBody);
  const configured = await request('/api/workspaces/settings', { method: 'POST', body: configureBody, proof: configureProof });
  if (!configured.ok || configured.payload?.configured !== true) throw new Error('Packaged workspace configuration failed');

  const startBody = { operationID: crypto.randomUUID(), directory, title: 'Packaged physical desktop smoke' };
  const startProof = await reauthenticate('workspace.session.start', directory, startBody);
  const started = await request('/api/workspaces/sessions/start', { method: 'POST', body: startBody, proof: startProof });
  const workspaceID = typeof started.payload?.workspaceID === 'string' ? started.payload.workspaceID : '';
  try {
    if (!started.ok || started.payload?.status !== 'completed' || !workspaceID || typeof started.payload?.sessionID !== 'string') {
      throw new Error('Packaged workspace session did not complete');
    }
    return { workspaceID, sessionID: started.payload.sessionID };
  } finally {
    if (workspaceID) {
      const cleanupBody = { id: workspaceID, directory };
      const cleanupProof = await reauthenticate('workspace.cleanup', directory, cleanupBody);
      const cleaned = await request(`/api/workspaces/${encodeURIComponent(workspaceID)}`, { method: 'DELETE', body: { directory }, proof: cleanupProof });
      if (!cleaned.ok || cleaned.payload?.cleaned !== true || (cleaned.payload?.remainingResources?.length ?? 0) !== 0) {
        throw new Error('Packaged workspace cleanup failed');
      }
    }
  }
};
