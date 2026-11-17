
const RELEASE_ICONS = 'resources/icons';
export const CANARY_ICONS = 'resources/icons-canary';

const canaryIcon = (file) => (file?.startsWith(`${RELEASE_ICONS}/`) ? `${CANARY_ICONS}${file.slice(RELEASE_ICONS.length)}` : file);

export const canaryBuildConfig = (releaseConfig) => {
  const config = structuredClone(releaseConfig);
  config.directories = { ...config.directories, buildResources: CANARY_ICONS };
  config.extraResources = config.extraResources.map((entry) => ({ ...entry, from: canaryIcon(entry.from) }));
  for (const platform of ['mac', 'win', 'linux']) config[platform].icon = canaryIcon(config[platform].icon);
  for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) config.nsis[key] = canaryIcon(config.nsis[key]);
  return config;
};
