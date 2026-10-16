import path from 'node:path';

export const PROJECT_OPEN_ARG = '--openchamber-project=';

/** Locate the chamber desktop launcher without changing the legacy openchamber command target. */
export const desktopLauncherPath = (dataDir) => path.join(dataDir, 'desktop', 'chamber');
