import {
  buildLinuxMenuTemplate,
  menuAccelerator,
  nativeNotificationUnsupportedReason,
  resolveElectronRuntimePaths,
  stopInProcessWebServer,
  shouldInstallExplicitApplicationMenu,
  shouldRequireQuitConfirmationForPlatform,
  shouldRouteLastWindowCloseThroughQuitConfirmation,
} from '../electron-lifecycle-utils.mjs';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const calls = [];
const record = (name) => (...args) => {
  calls.push({ name, args });
};

const template = buildLinuxMenuTemplate({
  appName: 'OpenChamber',
  dispatchAction: record('dispatchAction'),
  dispatchCheckForUpdates: record('dispatchCheckForUpdates'),
  reloadMenuTargetWindow: record('reloadMenuTargetWindow'),
  relaunchFromMenu: record('relaunchFromMenu'),
  requestQuitWithConfirmation: record('requestQuitWithConfirmation'),
  newWindow: record('newWindow'),
  clearCache: record('clearCache'),
  openExternal: record('openExternal'),
  urls: {
    bugReport: 'https://example.test/bug',
    featureRequest: 'https://example.test/feature',
    discord: 'https://example.test/discord',
  },
});

assert(shouldRequireQuitConfirmationForPlatform('darwin') === true, 'macOS should keep quit confirmation');
assert(shouldRequireQuitConfirmationForPlatform('linux') === true, 'Linux should require quit confirmation');
assert(shouldRequireQuitConfirmationForPlatform('win32') === false, 'Windows behavior should remain unchanged');
assert(shouldInstallExplicitApplicationMenu('darwin') === true, 'macOS should keep explicit app menu');
assert(shouldInstallExplicitApplicationMenu('linux') === true, 'Linux should install explicit app menu');
assert(shouldInstallExplicitApplicationMenu('win32') === false, 'Windows should continue using Electron default menu behavior');
assert(shouldRouteLastWindowCloseThroughQuitConfirmation('darwin') === false, 'macOS close should keep hide-on-close behavior');
assert(shouldRouteLastWindowCloseThroughQuitConfirmation('linux') === true, 'Linux last-window close should route through quit confirmation');
assert(shouldRouteLastWindowCloseThroughQuitConfirmation('win32') === false, 'Windows close behavior should remain unchanged');
assert(nativeNotificationUnsupportedReason('linux').includes('Desktop Notifications/libnotify'), 'Linux notification fallback should be actionable');
assert(nativeNotificationUnsupportedReason('darwin').includes('Notification.isSupported()'), 'Non-Linux notification fallback should cite Electron support check');
assert(menuAccelerator('linux', 'Q') === 'Ctrl+Q', 'Linux accelerator should use Ctrl');
assert(menuAccelerator('darwin', 'Q') === 'Cmd+Q', 'macOS accelerator should use Cmd');

const devPaths = resolveElectronRuntimePaths({
  isDev: true,
  mainDir: '/repo/packages/electron',
  appPath: '/ignored/app.asar',
  resourcesPath: '/ignored/resources',
});
assert(devPaths.resourceRoot === '/repo/packages/electron/resources', 'dev resource root should be beside main.mjs');
assert(devPaths.webDistDir === '/repo/packages/electron/resources/web-dist', 'dev web-dist should use staged electron resources');
assert(devPaths.preloadPath === '/repo/packages/electron/preload.mjs', 'dev preload should be beside main.mjs');

const packagedPaths = resolveElectronRuntimePaths({
  isDev: false,
  mainDir: '/opt/OpenChamber/resources/app.asar/dist-bundle',
  appPath: '/opt/OpenChamber/resources/app.asar',
  resourcesPath: '/opt/OpenChamber/resources',
});
assert(packagedPaths.resourceRoot === '/opt/OpenChamber/resources', 'packaged resource root should use process.resourcesPath');
assert(packagedPaths.webDistDir === '/opt/OpenChamber/resources/web-dist', 'packaged web-dist should resolve to extraResources staging');
assert(packagedPaths.preloadPath === '/opt/OpenChamber/resources/app.asar/preload.mjs', 'packaged preload should resolve inside app resources');

let missingPackagedResourcesFailed = false;
try {
  resolveElectronRuntimePaths({
    isDev: false,
    mainDir: '/opt/OpenChamber/resources/app.asar/dist-bundle',
    appPath: '/opt/OpenChamber/resources/app.asar',
    resourcesPath: '',
  });
} catch (error) {
  missingPackagedResourcesFailed = /resources path/.test(error.message);
}
assert(missingPackagedResourcesFailed, 'packaged runtime paths should require process.resourcesPath');

let missingPackagedAppPathFailed = false;
try {
  resolveElectronRuntimePaths({
    isDev: false,
    mainDir: '/opt/OpenChamber/resources/app.asar/dist-bundle',
    appPath: '',
    resourcesPath: '/opt/OpenChamber/resources',
  });
} catch (error) {
  missingPackagedAppPathFailed = /app path/.test(error.message);
}
assert(missingPackagedAppPathFailed, 'packaged runtime paths should require app.getAppPath()');

const stopped = [];
const lifecycleState = {
  serverHandle: {
    stop: (options) => {
      stopped.push(options);
      return Promise.resolve();
    },
  },
  sidecarUrl: 'http://127.0.0.1:57123',
};
assert(stopInProcessWebServer({ state: lifecycleState }) === true, 'first server stop should report stopped');
assert(stopped.length === 1, 'server stop should be called once');
assert(stopped[0]?.exitProcess === false, 'server stop should never exit the Electron process');
assert(lifecycleState.serverHandle === null, 'server handle should clear before duplicate stop paths run');
assert(lifecycleState.sidecarUrl === null, 'local server URL should clear after stop');
assert(stopInProcessWebServer({ state: lifecycleState }) === false, 'duplicate server stop should be a safe no-op');
assert(stopped.length === 1, 'duplicate stop paths must not call stop twice');

const emptyState = {
  serverHandle: null,
  sidecarUrl: 'http://127.0.0.1:57123',
};
assert(stopInProcessWebServer({ state: emptyState }) === false, 'missing server handle should be a safe no-op');
assert(emptyState.serverHandle === null, 'missing server handle should stay null');
assert(emptyState.sidecarUrl === null, 'missing server handle should still clear stale local URL');

const throwingState = {
  serverHandle: {
    stop: () => {
      throw new Error('boom');
    },
  },
  sidecarUrl: 'http://127.0.0.1:57123',
};
const warnings = [];
assert(stopInProcessWebServer({ state: throwingState, logger: { warn: (...args) => warnings.push(args) } }) === true, 'throwing stop should still consume handle');
assert(throwingState.serverHandle === null, 'throwing stop should still clear handle');
assert(warnings.length === 1, 'throwing stop should warn once');
assert(warnings[0][0] === '[electron] failed to stop in-process web server:', 'throwing stop warning should use Electron server stop prefix');
assert(warnings[0][1]?.message === 'boom', 'throwing stop warning should include the thrown error');

const rejectingState = {
  serverHandle: {
    stop: () => Promise.reject(new Error('async boom')),
  },
  sidecarUrl: 'http://127.0.0.1:57123',
};
assert(stopInProcessWebServer({ state: rejectingState, logger: { warn: (...args) => warnings.push(args) } }) === true, 'rejecting stop should still consume handle');
await new Promise((resolve) => setTimeout(resolve, 0));
assert(rejectingState.serverHandle === null, 'rejecting stop should still clear handle');
assert(warnings.length === 2, 'rejecting stop should warn once');
assert(warnings[1][0] === '[electron] failed to stop in-process web server:', 'rejecting stop warning should use Electron server stop prefix');
assert(warnings[1][1]?.message === 'async boom', 'rejecting stop warning should include the rejection error');

const labels = template.map((item) => item.label);
assert(labels.join('|') === 'File|Edit|View|Window|Help', `unexpected Linux top-level menu labels: ${labels.join('|')}`);

const findMenuItem = (topLabel, itemLabel) => {
  const top = template.find((item) => item.label === topLabel);
  return top?.submenu?.find((item) => item.label === itemLabel);
};

const quitItem = findMenuItem('File', 'Quit OpenChamber');
assert(quitItem, 'Linux File menu should include explicit quit item');
assert(quitItem.accelerator === 'Ctrl+Q', 'Linux quit accelerator should be Ctrl+Q');
quitItem.click();
assert(calls.some((entry) => entry.name === 'requestQuitWithConfirmation'), 'Linux quit item should request quit confirmation');

const settingsItem = findMenuItem('Help', 'Settings');
assert(settingsItem?.accelerator === 'Ctrl+,', 'Linux settings accelerator should be Ctrl+,');
settingsItem.click();
assert(calls.some((entry) => entry.name === 'dispatchAction' && entry.args[0] === 'settings'), 'Settings should dispatch settings action');

const updateItem = findMenuItem('Help', 'Check for Updates');
updateItem.click();
assert(calls.some((entry) => entry.name === 'dispatchCheckForUpdates'), 'Check for Updates should dispatch update check');

const bugItem = findMenuItem('Help', 'Report a Bug');
bugItem.click();
assert(calls.some((entry) => entry.name === 'openExternal' && entry.args[0] === 'https://example.test/bug'), 'Report a Bug should open external issue URL');

console.log(JSON.stringify({ ok: true, labels, calls }, null, 2));
