const DEFAULT_NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * @param {string} packageName
 * @param {string} [metadataPath]
 * @returns {{ url: string, headers: Record<string, string> }}
 */
export function resolveNpmRegistryRequest(packageName, metadataPath) {
  const configured = [process.env.npm_config_registry, process.env.NPM_CONFIG_REGISTRY]
    .map((value) => value?.trim())
    .find(Boolean) || DEFAULT_NPM_REGISTRY_BASE;
  let registry;
  try {
    registry = new URL(configured);
    if (!['http:', 'https:'].includes(registry.protocol) || registry.search || registry.hash) throw new Error();
  } catch {
    throw new Error('Invalid npm registry URL');
  }

  let authorization;
  try {
    if (registry.username || registry.password) {
      authorization = `Basic ${Buffer.from(`${decodeURIComponent(registry.username)}:${decodeURIComponent(registry.password)}`).toString('base64')}`;
    }
  } catch {
    throw new Error('Invalid npm registry URL');
  }
  registry.username = '';
  registry.password = '';
  registry.pathname = `${registry.pathname.replace(/\/+$/, '')}/`;

  const encodedName = encodeURIComponent(packageName).replace(/^%40/i, '@');
  const suffix = metadataPath ? `/${encodeURIComponent(metadataPath)}` : '';
  return {
    url: `${registry.toString()}${encodedName}${suffix}`,
    headers: authorization ? { Authorization: authorization } : {},
  };
}
