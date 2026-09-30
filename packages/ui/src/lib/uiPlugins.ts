export type LocalizedText = { default: string; [locale: string]: string };

export type UIPluginSupportStatus = 'supported' | 'unsupported';
export type UIPluginRuntime = 'web' | 'desktop' | 'vscode' | 'hostedMobile' | 'capacitorMobile';

/**
 * A panel the host mounts in the composer footer. The host computes the
 * snapshot (engine, provider, instant of the last completed assistant turn)
 * from its own sync and pushes it to the guest; the guest only paints.
 */
export type ComposerStatusContribution = {
  id: string;
  placement: 'footer';
  support: {
    web: UIPluginSupportStatus;
    desktop: UIPluginSupportStatus;
    vscode: UIPluginSupportStatus;
    hostedMobile: UIPluginSupportStatus;
    capacitorMobile: UIPluginSupportStatus;
  };
};

export type OpenChamberUIPluginManifestV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: LocalizedText;
  description: LocalizedText;
  engines: { openchamber: string };
  contributes: {
    composerStatus?: ComposerStatusContribution[];
  };
};

const manifests = new Map<string, OpenChamberUIPluginManifestV1>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const parseUIPluginManifest = (value: unknown): OpenChamberUIPluginManifestV1 => {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.version !== 'string') {
    throw new Error('Invalid OpenChamber UI plugin manifest');
  }
  if (!isRecord(value.displayName) || typeof value.displayName.default !== 'string'
    || !isRecord(value.description) || typeof value.description.default !== 'string'
    || !isRecord(value.engines) || typeof value.engines.openchamber !== 'string' || !isRecord(value.contributes)) {
    throw new Error(`Invalid OpenChamber UI plugin manifest: ${value.id}`);
  }
  const composerStatus = value.contributes.composerStatus;
  if (composerStatus !== undefined && !Array.isArray(composerStatus)) {
    throw new Error(`Invalid composer-status contributions: ${value.id}`);
  }
  const composerStatusIds = new Set<string>();
  for (const contribution of composerStatus ?? []) {
    const support = isRecord(contribution) ? contribution.support : null;
    const supportKeys = support ? Object.keys(support) : [];
    const supportValues = support ? Object.values(support) : [];
    if (!isRecord(contribution)
      || typeof contribution.id !== 'string'
      || !/^[a-z][a-z0-9-]*$/.test(contribution.id)
      || contribution.placement !== 'footer'
      || !support
      || supportKeys.length !== 5
      || !['web', 'desktop', 'vscode', 'hostedMobile', 'capacitorMobile'].every((key) => supportKeys.includes(key))
      || !supportValues.every((status) => status === 'supported' || status === 'unsupported')
      || composerStatusIds.has(contribution.id)) {
      throw new Error(`Invalid composer-status contribution: ${value.id}`);
    }
    composerStatusIds.add(contribution.id);
  }
  return value as OpenChamberUIPluginManifestV1;
};

export const registerUIPluginManifest = (value: unknown): (() => void) => {
  const manifest = parseUIPluginManifest(value);
  if (manifests.has(manifest.id)) throw new Error(`UI plugin already registered: ${manifest.id}`);
  manifests.set(manifest.id, manifest);
  return () => { manifests.delete(manifest.id); };
};

export const getRegisteredUIPluginManifests = (): readonly OpenChamberUIPluginManifestV1[] =>
  Array.from(manifests.values());

export const getComposerStatusContributions = (
  pluginManifests: readonly OpenChamberUIPluginManifestV1[] = getRegisteredUIPluginManifests(),
): ComposerStatusContribution[] => pluginManifests.flatMap(
  (plugin) => plugin.contributes.composerStatus ?? [],
);

export const isComposerStatusContributionSupported = (
  contribution: ComposerStatusContribution,
  runtime: UIPluginRuntime,
): boolean => contribution.support[runtime] === 'supported';
