/**
 * The Electron Builder configuration of a Canary build, derived from the
 * release one in package.json. `package.mjs` writes it to a file and passes it
 * with `--config` when `OPENCHAMBER_DESKTOP_CHANNEL=canary`.
 *
 * Canary is the same app as the release: same name, id, install location,
 * profile and `openchamber://` links, so an update replaces one with the
 * other. Only the icons differ, from `resources/icons-canary`, laid out like
 * `resources/icons`.
 */

const RELEASE_ICONS = 'resources/icons';
export const CANARY_ICONS = 'resources/icons-canary';

const canaryIcon = (file) => (file?.startsWith(`${RELEASE_ICONS}/`) ? `${CANARY_ICONS}${file.slice(RELEASE_ICONS.length)}` : file);

// Every icon path of the release configuration; the test fails when a new one
// is added there and not here.
export const canaryBuildConfig = (releaseConfig) => {
  const config = structuredClone(releaseConfig);
  config.directories = { ...config.directories, buildResources: CANARY_ICONS };
  config.extraResources = config.extraResources.map((entry) => ({ ...entry, from: canaryIcon(entry.from) }));
  for (const platform of ['mac', 'win', 'linux']) config[platform].icon = canaryIcon(config[platform].icon);
  for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) config.nsis[key] = canaryIcon(config.nsis[key]);
  return config;
};
