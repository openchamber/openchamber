import { requestServerShutdown } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
} from './cli-process.js';
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
import {
  partitionInstancesForUpdateRestart,
  runForegroundSystemdUserServiceControllerAction,
} from '../../server/lib/systemd-user-service.js';

function createUpdateCommand({ importFromFilePath, packageManagerPath, serveCommand }) {
  return async function updateCommand(options = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
    } = await importFromFilePath(packageManagerPath);

    const runningInstances = await discoverRunningInstances();
    const {
      cliManagedInstances,
      serviceManagedInstances,
      serviceManagerOwner,
    } = partitionInstancesForUpdateRestart(runningInstances);
    const managedForegroundController = serviceManagerOwner?.controller || null;
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

    if (runningInstances.length > 0) {
      updateSpin?.message(`Stopping ${runningInstances.length} running instance(s)...`);
      for (const instance of cliManagedInstances) {
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

      if (managedForegroundController) {
        updateSpin?.message(`Stopping ${managedForegroundController.label}...`);
        runForegroundSystemdUserServiceControllerAction(managedForegroundController, 'stop', {
          stdio: isJsonMode(options) || isQuietMode(options) ? 'pipe' : 'inherit',
        });
        for (const instance of serviceManagedInstances) {
          removePidFile(instance.pidFilePath);
        }
      }
    }

    const pm = detectPackageManager();
    const result = executeUpdate(pm, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      if (managedForegroundController) {
        try {
          runForegroundSystemdUserServiceControllerAction(managedForegroundController, 'start', {
            stdio: isJsonMode(options) || isQuietMode(options) ? 'pipe' : 'inherit',
          });
        } catch {
        }
      }
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    let restartedByCliCount = 0;
    if (cliManagedInstances.length > 0) {
      updateSpin?.message(`Restarting ${cliManagedInstances.length} CLI-managed instance(s)...`);
      for (const instance of cliManagedInstances) {
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
        restartedByCliCount += 1;
      }
    }

    if (managedForegroundController) {
      updateSpin?.message(`Starting ${managedForegroundController.label}...`);
      runForegroundSystemdUserServiceControllerAction(managedForegroundController, 'start', {
        stdio: isJsonMode(options) || isQuietMode(options) ? 'pipe' : 'inherit',
      });
    }

    const restartedByServiceManagerCount = serviceManagedInstances.length;

    if (showOutput && !updateSpin) {
      logStatus('success', `updated to ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.stop(`Updated to ${updateInfo.version || 'latest'}`);
    if (isJsonMode(options)) {
      printJson({
        currentVersion,
        latestVersion: updateInfo.version || 'latest',
        updated: true,
        restartedCount: restartedByCliCount + restartedByServiceManagerCount,
        restartedByCliCount,
        restartedByServiceManagerCount,
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
