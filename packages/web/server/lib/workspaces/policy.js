import { isIP } from 'node:net';
const PROVIDERS = new Set(['docker', 'kubernetes', 'apple-container']);
const SECURE_DOCKER_NETWORK = 'per-workspace-internal';
const SECURE_APPLE_CONTAINER_NETWORK = 'per-workspace-host-only';
const EGRESS_MODES = new Set(['managed', 'external']);
const EGRESS_PRESETS = new Set(['restricted', 'custom']);
const CONNECTIVITY_MODES = new Set(['port-forward', 'ingress']);
const TLS_MODES = new Set(['existing-secret', 'cert-manager']);
const MODEL_AUTH_MODES = new Set(['none', 'explicit-opencode-auth-content']);
const DIGEST_IMAGE = /@sha256:[a-f0-9]{64}$/i;
const RESOURCE_QUANTITY = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:m|Ki|Mi|Gi|Ti)?$/;
const DOCKER_MEMORY = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[bkmg]i?b?)?$/i;

const STRING_FIELDS = [
  'secureWorkspacesImage',
  'secureWorkspacesAllowedImages',
  'secureWorkspacesGatewayImage',
  'secureWorkspacesEgressAllowedDomains',
  'secureWorkspacesEgressAllowedCIDRs',
  'secureWorkspacesEgressAllowedPorts',
  'secureWorkspacesEgressProxyUrl',
  'secureWorkspacesEgressProxyCIDR',
  'secureWorkspacesEgressDnsCIDRs',
  'secureWorkspacesEgressNoProxy',
  'secureWorkspacesDockerMemoryLimit',
  'secureWorkspacesDockerCpuLimit',
  'secureWorkspacesKubernetesContext',
  'secureWorkspacesKubernetesNamespace',
  'secureWorkspacesKubernetesStorage',
  'secureWorkspacesKubernetesCpuRequest',
  'secureWorkspacesKubernetesMemoryRequest',
  'secureWorkspacesKubernetesCpuLimit',
  'secureWorkspacesKubernetesMemoryLimit',
  'secureWorkspacesKubernetesIngressClassName',
  'secureWorkspacesKubernetesIngressHostTemplate',
  'secureWorkspacesKubernetesIngressPathTemplate',
  'secureWorkspacesKubernetesIngressTlsSecretName',
  'secureWorkspacesKubernetesIngressClusterIssuer',
  'secureWorkspacesKubernetesIngressNamespaceSelector',
  'secureWorkspacesKubernetesIngressPodSelector',
  'secureWorkspacesKubernetesIngressAnnotations',
  'secureWorkspacesAppleMemoryLimit',
  'secureWorkspacesAppleCpuLimit',
];

const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const list = (value) => typeof value === 'string' ? value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : [];

function integer(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function quantity(value, fallback, label, pattern = RESOURCE_QUANTITY) {
  const normalized = optionalString(value) ?? fallback;
  if (normalized && !pattern.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function record(value, label, required = false) {
  if (!value) {
    if (required) fail(`${label} is required`);
    return undefined;
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(`${label} must be a JSON object`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== 'string')) {
    fail(`${label} must be a JSON object with string values`);
  }
  if (required && Object.keys(parsed).length === 0) fail(`${label} must not be empty`);
  return parsed;
}

function validateCIDR(value, label) {
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address);
  const parsed = Number(prefix);
  const max = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (extra !== undefined || !family || !Number.isInteger(parsed) || parsed < 0 || parsed > max) fail(`${label} contains an invalid CIDR`);
}

function validateDigest(value, label, required) {
  if (!value) {
    if (required) fail(`${label} is required`);
    return;
  }
  if (!DIGEST_IMAGE.test(value)) fail(`${label} must be pinned by a sha256 digest`);
}

function validateKubernetesName(value, label) {
  if (value && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(value)) fail(`${label} is invalid`);
}

function validateSelector(value, label) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!/^[A-Za-z0-9]([A-Za-z0-9_.\/-]{0,251}[A-Za-z0-9])?$/.test(key) || !/^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(entry)) fail(`${label} is invalid`);
  }
}

export function sanitizeWorkspaceSettingsUpdate(candidate) {
  const result = {};
  if (typeof candidate.secureWorkspacesEnabled === 'boolean') result.secureWorkspacesEnabled = candidate.secureWorkspacesEnabled;
  if (candidate.secureWorkspacesRequirePinnedImage !== undefined && candidate.secureWorkspacesRequirePinnedImage !== true) {
    fail('Workspace image digest enforcement cannot be disabled');
  }
  if (candidate.secureWorkspacesRequirePinnedImage === true) result.secureWorkspacesRequirePinnedImage = true;
  if (candidate.secureWorkspacesDefaultProvider !== undefined) {
    if (!PROVIDERS.has(candidate.secureWorkspacesDefaultProvider)) fail('Secure workspace provider is invalid');
    result.secureWorkspacesDefaultProvider = candidate.secureWorkspacesDefaultProvider;
  }
  for (const key of STRING_FIELDS) {
    if (candidate[key] !== undefined) {
      if (typeof candidate[key] !== 'string') fail(`${key} must be a string`);
      result[key] = candidate[key].trim();
    }
  }
  for (const [key, values, label] of [
    ['secureWorkspacesEgressMode', EGRESS_MODES, 'Secure workspace egress mode'],
    ['secureWorkspacesEgressPreset', EGRESS_PRESETS, 'Managed egress preset'],
    ['secureWorkspacesKubernetesConnectivity', CONNECTIVITY_MODES, 'Kubernetes connectivity'],
    ['secureWorkspacesKubernetesIngressTlsMode', TLS_MODES, 'Kubernetes ingress TLS mode'],
    ['secureWorkspacesModelAuth', MODEL_AUTH_MODES, 'Workspace model authentication'],
  ]) {
    if (candidate[key] !== undefined) {
      if (!values.has(candidate[key])) fail(`${label} is invalid`);
      result[key] = candidate[key];
    }
  }
  for (const key of ['secureWorkspacesRetentionPreserveOnDelete']) {
    if (candidate[key] !== undefined) {
      if (typeof candidate[key] !== 'boolean') fail(`${key} must be a boolean`);
      result[key] = candidate[key];
    }
  }
  if (candidate.secureWorkspacesDockerPidsLimit !== undefined) result.secureWorkspacesDockerPidsLimit = integer(candidate.secureWorkspacesDockerPidsLimit, 512, 'Docker PID limit');

  validateDigest(result.secureWorkspacesImage, 'Workspace runtime image', false);
  for (const image of list(result.secureWorkspacesAllowedImages)) validateDigest(image, 'Allowed workspace image', true);
  validateDigest(result.secureWorkspacesGatewayImage, 'Managed egress gateway image', false);
  for (const cidr of [...list(result.secureWorkspacesEgressAllowedCIDRs), ...list(result.secureWorkspacesEgressDnsCIDRs)]) validateCIDR(cidr, 'Workspace egress policy');
  if (result.secureWorkspacesEgressProxyCIDR) validateCIDR(result.secureWorkspacesEgressProxyCIDR, 'Workspace proxy policy');
  if (result.secureWorkspacesEgressProxyUrl) {
    let parsed;
    try { parsed = new URL(result.secureWorkspacesEgressProxyUrl); } catch { fail('External proxy URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('External proxy URL must use HTTP(S) and must not contain credentials');
  }
  if (result.secureWorkspacesEgressAllowedPorts) {
    const ports = list(result.secureWorkspacesEgressAllowedPorts).map(Number);
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) fail('Managed egress ports must be integers from 1 to 65535');
  }
  for (const domain of list(result.secureWorkspacesEgressAllowedDomains)) {
    if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) fail('Managed egress contains an invalid domain');
  }
  quantity(result.secureWorkspacesDockerMemoryLimit, undefined, 'Docker memory limit', DOCKER_MEMORY);
  quantity(result.secureWorkspacesDockerCpuLimit, undefined, 'Docker CPU limit');
  const structuredRecords = {};
  for (const [key, label] of [
    ['secureWorkspacesKubernetesStorage', 'Kubernetes storage'],
    ['secureWorkspacesKubernetesCpuRequest', 'Kubernetes CPU request'],
    ['secureWorkspacesKubernetesMemoryRequest', 'Kubernetes memory request'],
    ['secureWorkspacesKubernetesCpuLimit', 'Kubernetes CPU limit'],
    ['secureWorkspacesKubernetesMemoryLimit', 'Kubernetes memory limit'],
    ['secureWorkspacesAppleMemoryLimit', 'Apple Container memory limit'],
    ['secureWorkspacesAppleCpuLimit', 'Apple Container CPU limit'],
  ]) quantity(result[key], undefined, label, key.includes('Memory') && !key.includes('Kubernetes') ? DOCKER_MEMORY : RESOURCE_QUANTITY);
  for (const [key, label] of [
    ['secureWorkspacesKubernetesIngressNamespaceSelector', 'Kubernetes ingress namespace selector'],
    ['secureWorkspacesKubernetesIngressPodSelector', 'Kubernetes ingress pod selector'],
    ['secureWorkspacesKubernetesIngressAnnotations', 'Kubernetes ingress annotations'],
  ]) if (result[key]) {
    structuredRecords[key] = record(result[key], label);
    result[key] = JSON.stringify(structuredRecords[key]);
  }
  validateKubernetesName(result.secureWorkspacesKubernetesNamespace, 'Kubernetes namespace');
  validateKubernetesName(result.secureWorkspacesKubernetesIngressClassName, 'Kubernetes ingress class');
  validateKubernetesName(result.secureWorkspacesKubernetesIngressTlsSecretName, 'Kubernetes ingress TLS secret');
  validateKubernetesName(result.secureWorkspacesKubernetesIngressClusterIssuer, 'Kubernetes cert-manager cluster issuer');
  if (result.secureWorkspacesKubernetesIngressHostTemplate) {
    if (!result.secureWorkspacesKubernetesIngressHostTemplate.includes('{resourceID}')) fail('Kubernetes ingress host template must contain {resourceID}');
    const host = result.secureWorkspacesKubernetesIngressHostTemplate.replaceAll('{resourceID}', 'ws-0123456789abcdef');
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) fail('Kubernetes ingress host template is invalid');
  }
  if (result.secureWorkspacesKubernetesIngressPathTemplate && result.secureWorkspacesKubernetesIngressPathTemplate !== '/') fail('Kubernetes ingress path template must be /');
  validateSelector(structuredRecords.secureWorkspacesKubernetesIngressNamespaceSelector, 'Kubernetes ingress namespace selector');
  validateSelector(structuredRecords.secureWorkspacesKubernetesIngressPodSelector, 'Kubernetes ingress pod selector');
  const allowedAnnotations = new Set(['nginx.ingress.kubernetes.io/proxy-body-size', 'nginx.ingress.kubernetes.io/proxy-read-timeout', 'nginx.ingress.kubernetes.io/proxy-send-timeout']);
  if (Object.keys(structuredRecords.secureWorkspacesKubernetesIngressAnnotations ?? {}).some((key) => !allowedAnnotations.has(key))) fail('Kubernetes ingress contains an unsupported annotation');
  return result;
}

export function readWorkspaceSettings(settings = {}) {
  return {
    enabled: settings.secureWorkspacesEnabled === true,
    defaultProvider: PROVIDERS.has(settings.secureWorkspacesDefaultProvider) ? settings.secureWorkspacesDefaultProvider : 'docker',
    image: optionalString(settings.secureWorkspacesImage) ?? '',
    allowedImages: list(settings.secureWorkspacesAllowedImages),
    gatewayImage: optionalString(settings.secureWorkspacesGatewayImage),
    egressMode: EGRESS_MODES.has(settings.secureWorkspacesEgressMode) ? settings.secureWorkspacesEgressMode : 'managed',
    egressPreset: EGRESS_PRESETS.has(settings.secureWorkspacesEgressPreset) ? settings.secureWorkspacesEgressPreset : 'restricted',
    egressAllowedDomains: list(settings.secureWorkspacesEgressAllowedDomains),
    egressAllowedCIDRs: list(settings.secureWorkspacesEgressAllowedCIDRs),
    egressAllowedPorts: list(settings.secureWorkspacesEgressAllowedPorts).map(Number),
    egressProxyUrl: optionalString(settings.secureWorkspacesEgressProxyUrl),
    egressProxyCIDR: optionalString(settings.secureWorkspacesEgressProxyCIDR),
    egressDnsCIDRs: list(settings.secureWorkspacesEgressDnsCIDRs),
    egressNoProxy: optionalString(settings.secureWorkspacesEgressNoProxy) ?? '',
    dockerMemoryLimit: optionalString(settings.secureWorkspacesDockerMemoryLimit),
    dockerCpuLimit: optionalString(settings.secureWorkspacesDockerCpuLimit),
    dockerPidsLimit: integer(settings.secureWorkspacesDockerPidsLimit, 512, 'Docker PID limit'),
    kubernetesContext: optionalString(settings.secureWorkspacesKubernetesContext),
    kubernetesNamespace: optionalString(settings.secureWorkspacesKubernetesNamespace) ?? 'openchamber-workspaces',
    kubernetesConnectivity: CONNECTIVITY_MODES.has(settings.secureWorkspacesKubernetesConnectivity) ? settings.secureWorkspacesKubernetesConnectivity : 'port-forward',
    kubernetesStorage: quantity(settings.secureWorkspacesKubernetesStorage, '8Gi', 'Kubernetes storage'),
    kubernetesCpuRequest: quantity(settings.secureWorkspacesKubernetesCpuRequest, '250m', 'Kubernetes CPU request'),
    kubernetesMemoryRequest: quantity(settings.secureWorkspacesKubernetesMemoryRequest, '512Mi', 'Kubernetes memory request'),
    kubernetesCpuLimit: quantity(settings.secureWorkspacesKubernetesCpuLimit, '2', 'Kubernetes CPU limit'),
    kubernetesMemoryLimit: quantity(settings.secureWorkspacesKubernetesMemoryLimit, '4Gi', 'Kubernetes memory limit'),
    ingressClassName: optionalString(settings.secureWorkspacesKubernetesIngressClassName),
    ingressHostTemplate: optionalString(settings.secureWorkspacesKubernetesIngressHostTemplate),
    ingressPathTemplate: optionalString(settings.secureWorkspacesKubernetesIngressPathTemplate) ?? '/',
    ingressTlsMode: TLS_MODES.has(settings.secureWorkspacesKubernetesIngressTlsMode) ? settings.secureWorkspacesKubernetesIngressTlsMode : 'existing-secret',
    ingressTlsSecretName: optionalString(settings.secureWorkspacesKubernetesIngressTlsSecretName),
    ingressClusterIssuer: optionalString(settings.secureWorkspacesKubernetesIngressClusterIssuer),
    ingressNamespaceSelector: record(settings.secureWorkspacesKubernetesIngressNamespaceSelector, 'Kubernetes ingress namespace selector', false),
    ingressPodSelector: record(settings.secureWorkspacesKubernetesIngressPodSelector, 'Kubernetes ingress pod selector', false),
    ingressAnnotations: record(settings.secureWorkspacesKubernetesIngressAnnotations, 'Kubernetes ingress annotations', false) ?? {},
    appleMemoryLimit: optionalString(settings.secureWorkspacesAppleMemoryLimit),
    appleCpuLimit: optionalString(settings.secureWorkspacesAppleCpuLimit),
    preserveOnDelete: settings.secureWorkspacesRetentionPreserveOnDelete === true,
    modelAuth: MODEL_AUTH_MODES.has(settings.secureWorkspacesModelAuth) ? settings.secureWorkspacesModelAuth : 'none',
  };
}

export function buildPluginOptions(settings, { requireComplete = false } = {}) {
  validateDigest(settings.image, 'Workspace runtime image', requireComplete);
  validateDigest(settings.gatewayImage, 'Managed egress gateway image', requireComplete && settings.egressMode === 'managed');
  const ingress = settings.kubernetesConnectivity === 'ingress' ? {
    ingressClassName: settings.ingressClassName,
    hostTemplate: settings.ingressHostTemplate,
    pathTemplate: settings.ingressPathTemplate,
    tls: settings.ingressTlsMode === 'cert-manager'
      ? { mode: 'cert-manager', clusterIssuer: settings.ingressClusterIssuer }
      : { mode: 'existing-secret', secretName: settings.ingressTlsSecretName },
    controllerNamespaceSelector: settings.ingressNamespaceSelector,
    controllerPodSelector: settings.ingressPodSelector,
    annotations: settings.ingressAnnotations,
  } : undefined;
  const options = {
    defaultImage: settings.image,
    allowedImages: settings.allowedImages.length ? settings.allowedImages : settings.image ? [settings.image] : [],
    requirePinnedImage: true,
    defaultProvider: settings.defaultProvider,
    docker: { networkMode: SECURE_DOCKER_NETWORK, memoryLimit: settings.dockerMemoryLimit, cpuLimit: settings.dockerCpuLimit, pidsLimit: settings.dockerPidsLimit },
    kubernetes: {
      context: settings.kubernetesContext,
      namespace: settings.kubernetesNamespace,
      allowedContexts: settings.kubernetesContext ? [settings.kubernetesContext] : [],
      allowedNamespaces: [settings.kubernetesNamespace],
      connectivity: settings.kubernetesConnectivity,
      ingress,
      storage: settings.kubernetesStorage,
      cpuRequest: settings.kubernetesCpuRequest,
      memoryRequest: settings.kubernetesMemoryRequest,
      cpuLimit: settings.kubernetesCpuLimit,
      memoryLimit: settings.kubernetesMemoryLimit,
      networkPolicy: 'default-deny',
    },
    appleContainer: { networkMode: SECURE_APPLE_CONTAINER_NETWORK, memoryLimit: settings.appleMemoryLimit, cpuLimit: settings.appleCpuLimit },
    egress: settings.egressMode === 'managed' ? {
      mode: 'managed', gatewayImage: settings.gatewayImage, preset: settings.egressPreset,
      allowedDomains: settings.egressAllowedDomains, allowedCIDRs: settings.egressAllowedCIDRs,
      allowedPorts: settings.egressAllowedPorts.length ? settings.egressAllowedPorts : [80, 443],
      dnsCIDRs: settings.egressDnsCIDRs, noProxy: settings.egressNoProxy,
    } : {
      mode: 'external', proxyUrl: settings.egressProxyUrl, proxyCIDR: settings.egressProxyCIDR,
      dnsCIDRs: settings.egressDnsCIDRs, noProxy: settings.egressNoProxy,
    },
    retention: { preserveOnDelete: settings.preserveOnDelete },
    secrets: { mode: 'file' },
    credentials: { modelAuth: settings.modelAuth },
  };
  if (requireComplete) {
    if (options.allowedImages.length && !options.allowedImages.includes(options.defaultImage)) fail('Workspace runtime image is not in the exact image allowlist');
    if (settings.egressDnsCIDRs.length === 0) fail('Controlled workspace egress requires at least one DNS CIDR');
    if (settings.egressMode === 'external') {
      if (!settings.egressProxyUrl) fail('External workspace egress requires a proxy URL');
      if (!settings.egressProxyCIDR) fail('External workspace egress requires a proxy CIDR');
      sanitizeWorkspaceSettingsUpdate({ secureWorkspacesEgressProxyUrl: settings.egressProxyUrl, secureWorkspacesEgressProxyCIDR: settings.egressProxyCIDR });
    }
    if (settings.kubernetesConnectivity === 'ingress') {
      if (!settings.ingressClassName || !settings.ingressHostTemplate?.includes('{resourceID}') || settings.ingressPathTemplate !== '/') fail('Kubernetes ingress class, {resourceID} host template, and / path are required');
      if (!settings.ingressNamespaceSelector || Object.keys(settings.ingressNamespaceSelector).length === 0 || !settings.ingressPodSelector || Object.keys(settings.ingressPodSelector).length === 0) fail('Kubernetes ingress controller selectors are required');
      if (settings.ingressTlsMode === 'existing-secret' ? !settings.ingressTlsSecretName : !settings.ingressClusterIssuer) fail('Kubernetes ingress TLS configuration is incomplete');
      const allowedAnnotations = new Set(['nginx.ingress.kubernetes.io/proxy-body-size', 'nginx.ingress.kubernetes.io/proxy-read-timeout', 'nginx.ingress.kubernetes.io/proxy-send-timeout']);
      if (Object.keys(settings.ingressAnnotations).some((key) => !allowedAnnotations.has(key))) fail('Kubernetes ingress contains an unsupported annotation');
    }
  }
  return options;
}
