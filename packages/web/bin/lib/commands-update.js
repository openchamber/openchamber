import { requestServerShutdown } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { buildLocalUrl } from './cli-network.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
} from './cli-process.js';
import { getStartupServicePid, restartStartupService } from './cli-startup.js';
import { isHostManagedInstall, requestHostUpdate } from '../../server/lib/host-install/managed.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';

async function waitForServerVersion({ port, host }, version, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildLocalUrl(port, '/health', host), { signal: AbortSignal.timeout(1000) });
      const body = response.ok ? await response.json() : null;
      if (body && (!version || body.openchamberVersion === version)) {
        return true;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function createUpdateCommand({
  importFromFilePath,
  packageManagerPath,
  serveCommand,
  discoverInstances = discoverRunningInstances,
  startupService = { getPid: getStartupServicePid, restart: restartStartupService },
  waitForVersion = waitForServerVersion,
  hostInstall = { isManaged: isHostManagedInstall, requestUpdate: requestHostUpdate },
}) {
  return async function updateCommand(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);

    // A host install belongs to its root updater: this account can only ask it to run.
    if (hostInstall.isManaged()) {
      try {
        hostInstall.requestUpdate();
      } catch (error) {
        throw new Error(`Could not ask the host updater for an update (${error.code ?? error.message}). Only the account OpenChamber runs as can ask; root runs the updater directly: systemctl start openchamber-updater.service`);
      }
      if (isJsonMode(options)) {
        printJson({ requested: true, updater: 'host' });
      } else if (isQuietMode(options)) {
        process.stdout.write('requested host-updater\n');
      } else if (showOutput) {
        clackIntro('OpenChamber Update');
        logStatus('info', 'the host updater installs any newer release and restarts OpenChamber');
        logStatus('info', '[HOST_UPDATER]', 'journalctl -u openchamber-updater.service shows its progress');
        clackOutro('update requested');
      }
      return;
    }
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
      resolveUpdateTarget,
    } = await importFromFilePath(packageManagerPath);

    const runningInstances = await discoverInstances();
    const currentVersion = getCurrentVersion();

    if (showOutput) {
      clackIntro('OpenChamber Update');
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `current version: ${currentVersion}`);
    }

    updateSpin?.start('Checking for updates...');

    const updateInfo = await checkForUpdates();
    if (updateInfo.error) {
      updateSpin?.error('Update check failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(updateInfo.error);
    }
    if (!updateInfo.available) {
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || currentVersion,
          updated: false,
        });
        return;
      }
      if (showOutput && !updateSpin) {
        logStatus('success', 'you are running the latest version');
      }
      updateSpin?.stop('Already up to date');
      if (showOutput) {
        clackOutro('no update needed');
      } else if (isQuietMode(options)) {
        process.stdout.write(`up-to-date ${currentVersion}\n`);
      }
      return;
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${updateInfo.currentVersion || currentVersion} -> ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.message(`Updating to ${updateInfo.version || 'latest'}...`);

    // systemd starts its service again whenever the process exits, so the old
    // release would come back while the package manager replaces its files.
    // The service keeps running through the install and systemd restarts it
    // afterwards, the way the Update button does.
    const servicePid = startupService.getPid();
    const serviceInstance = runningInstances.find((instance) => instance.pid === servicePid);
    const cliInstances = runningInstances.filter((instance) => instance !== serviceInstance);

    if (cliInstances.length > 0) {
      updateSpin?.message(`Stopping ${cliInstances.length} running instance(s)...`);
      for (const instance of cliInstances) {
        try {
          const requested = await requestServerShutdown(instance.port, instance.host);
          await stopInstanceProcess(instance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          removePidFile(instance.pidFilePath);
        } catch {
        }
      }
    }

    const pm = detectPackageManager();
    // A fork installs the tarball from its own release; the npm package stays
    // pinned to the version the check reported.
    const { target, origin } = await resolveUpdateTarget();
    const result = executeUpdate(pm, {
      targetVersion: updateInfo.version,
      silent: isJsonMode(options) || isQuietMode(options),
      ...(origin === 'fork' ? { target } : {}),
    });
    if (!result.success) {
      updateSpin?.error(result.error || 'Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(result.error || `Update failed with exit code ${result.exitCode}`);
    }

    if (runningInstances.length > 0) {
      updateSpin?.message(`Restarting ${runningInstances.length} instance(s)...`);
    }
    for (const instance of cliInstances) {
      const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
      await serveCommand({
        port: storedOptions.port || instance.port,
        host: storedOptions.host,
        explicitPort: true,
        uiPassword: storedOptions.uiPassword,
        suppressStartupSummary: true,
        suppressUiPasswordWarning: true,
        quiet: true,
      });
    }
    // Last, because an update run from a terminal inside the service ends
    // with this restart. A unit written by an older release can still point
    // at the install the package manager just deleted, or at the old release.
    if (serviceInstance) {
      startupService.restart();
      if (!await waitForVersion(serviceInstance, updateInfo.version)) {
        updateSpin?.error('Startup service did not restart');
        if (showOutput) {
          clackOutro('update failed');
        }
        throw new Error(`The startup service is not running ${updateInfo.version || 'the new version'}. Run \`openchamber startup enable\` to point it at the new install.`);
      }
    }

    if (showOutput && !updateSpin) {
      logStatus('success', `updated to ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.stop(`Updated to ${updateInfo.version || 'latest'}`);
    if (isJsonMode(options)) {
      printJson({
        currentVersion,
        latestVersion: updateInfo.version || 'latest',
        updated: true,
        restartedCount: runningInstances.length,
      });
      return;
    }
    if (showOutput) {
      clackOutro('update complete');
    } else if (isQuietMode(options)) {
      process.stdout.write(`updated ${updateInfo.version || 'latest'}\n`);
    }
  };
}

export { createUpdateCommand };
