import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { requestServerShutdown } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
} from './cli-lifecycle.js';
import {
  getPidFilePath,
  readInstanceOptions,
  readPidFile,
  removePidFile,
  removeInstanceFile,
  isProcessRunning,
  stopInstanceProcess,
} from './cli-process.js';
import { SELF_HANDOFF_SIGNAL, isSelfHandoffEnabled, resolveHandoffTimeoutMs } from '../../server/lib/opencode/self-handoff.js';
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

async function stopCommand(options) {
    const showOutput = shouldRenderHumanOutput(options);
    const suppressQuietOutput = options?.suppressQuietOutput === true;
    const jsonResults = [];
    const printQuietStopResults = () => {
      if (suppressQuietOutput) return;
      if (!isQuietMode(options) || isJsonMode(options)) return;
      if (jsonResults.length === 0) {
        process.stdout.write('none\n');
        return;
      }
      for (const result of jsonResults) {
        if (result.stopped) {
          process.stdout.write(`stopped ${result.port}\n`);
        } else {
          const reason = result.reason || 'failed';
          process.stderr.write(`failed ${result.port} ${reason}\n`);
        }
      }
    };
    const finish = (text) => {
      if (!showOutput) return;
      clackOutro(text);
    };

    if (showOutput) {
      clackIntro('OpenChamber Stop');
    }

    let runningInstances = await discoverLifecycleInstances(options);
    if (options.explicitPort) {
      if (runningInstances.length === 0) {
        const unconfirmedInstance = await discoverUnconfirmedRegistryInstanceOnPort(options.port, options);
        if (unconfirmedInstance) {
          runningInstances = [unconfirmedInstance];
        }
      }

      if (runningInstances.length === 0) {
        jsonResults.push({ port: options.port, stopped: false, reason: 'not-found' });
        if (isJsonMode(options)) {
          printJson({ stoppedCount: 0, results: jsonResults });
        }
        if (showOutput) {
          logStatus('info', `no OpenChamber instance found on port ${options.port}`);
          finish('nothing to stop');
        }
        printQuietStopResults();
        return;
      }

      const explicitInstance = runningInstances[0];
      if (explicitInstance.runtime === 'desktop') {
        jsonResults.push({ port: options.port, runtime: 'desktop', stopped: false, reason: 'desktop-managed' });
        if (isJsonMode(options)) {
          printJson({ stoppedCount: 0, results: jsonResults, messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message: `Port ${options.port} is managed by OpenChamber Desktop and cannot be stopped with this command.` }] });
        }
        if (showOutput) {
          logStatus('warning', `port ${options.port} is managed by OpenChamber Desktop`, 'cannot be stopped with this command');
          finish('no changes applied');
        }
        printQuietStopResults();
        return;
      }

      if (explicitInstance.source === 'probe') {
        const unmanagedStopSpin = showOutput ? createSpinner(options) : null;
        if (showOutput && !unmanagedStopSpin) {
          logStatus('info', `found unmanaged OpenChamber instance on port ${options.port}`, 'attempting shutdown');
        }
        unmanagedStopSpin?.start(`Stopping unmanaged OpenChamber on port ${options.port}...`);
        const requested = await requestServerShutdown(options.port, options.host);

        if (Number.isFinite(explicitInstance.pid) && isProcessRunning(explicitInstance.pid)) {
          await stopInstanceProcess(explicitInstance.pid, {
            signal: 'SIGINT',
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          }).catch(() => false);
        }

        const stopped = await isPortAvailable(options.port, options.host);
        if (stopped) {
          unmanagedStopSpin?.stop(`Stopped unmanaged OpenChamber on port ${options.port}`);
          jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: true });
          if (isJsonMode(options)) {
            printJson({ stoppedCount: 1, results: jsonResults });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('success', `stopped OpenChamber on port ${options.port}`);
            finish('stop complete');
          }
          printQuietStopResults();
        } else if (requested) {
          unmanagedStopSpin?.stop(`Shutdown requested on port ${options.port} (still occupied)`);
          jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: false, reason: 'shutdown-requested-port-busy' });
          if (isJsonMode(options)) {
            printJson({
              status: 'warning',
              stoppedCount: 0,
              results: jsonResults,
              messages: [{ level: 'warning', code: 'SHUTDOWN_PARTIAL', message: `Shutdown was requested for port ${options.port}, but the port is still occupied.` }],
            });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('warning', `shutdown requested on port ${options.port}`, 'port is still occupied');
            finish('partial stop');
          }
          printQuietStopResults();
        } else {
          unmanagedStopSpin?.error(`Could not stop OpenChamber on port ${options.port}`);
          jsonResults.push({ port: options.port, runtime: 'unmanaged', stopped: false, reason: 'stop-failed' });
          if (isJsonMode(options)) {
            printJson({
              status: 'error',
              stoppedCount: 0,
              results: jsonResults,
              messages: [{ level: 'error', code: 'STOP_FAILED', message: `Could not stop OpenChamber on port ${options.port}.` }],
            });
          }
          if (showOutput && !unmanagedStopSpin) {
            logStatus('error', `could not stop OpenChamber on port ${options.port}`);
            finish('failed');
          }
          printQuietStopResults();
        }
        return;
      }

      if (explicitInstance.source === 'registry-unconfirmed') {
        const unconfirmedStopSpin = showOutput ? createSpinner(options) : null;
        if (showOutput && !unconfirmedStopSpin) {
          logStatus('info', `found unconfirmed OpenChamber pid ${explicitInstance.pid} on port ${options.port}`, 'HTTP shutdown endpoint is unreachable; stopping by PID');
        }
        unconfirmedStopSpin?.start(`Stopping unconfirmed OpenChamber on port ${options.port}...`);
        const stopped = await stopInstanceProcess(explicitInstance.pid, {
          signal: 'SIGINT',
          shutdownWaitMs: 0,
          gracefulTimeoutMs: 2500,
          forceTimeoutMs: 3000,
        }).catch(() => false);

        if (stopped || !isProcessRunning(explicitInstance.pid)) {
          removePidFile(explicitInstance.pidFilePath);
          removeInstanceFile(explicitInstance.instanceFilePath);
          unconfirmedStopSpin?.stop(`Stopped OpenChamber PID ${explicitInstance.pid}`);
          jsonResults.push({ port: options.port, pid: explicitInstance.pid, runtime: 'unconfirmed', stopped: true });
          if (isJsonMode(options)) {
            printJson({ stoppedCount: 1, results: jsonResults });
          }
          if (showOutput && !unconfirmedStopSpin) {
            logStatus('success', `stopped pid ${explicitInstance.pid}`);
            finish('stop complete');
          }
          printQuietStopResults();
          return;
        }

        unconfirmedStopSpin?.error(`Could not stop OpenChamber PID ${explicitInstance.pid}`);
        jsonResults.push({ port: options.port, pid: explicitInstance.pid, runtime: 'unconfirmed', stopped: false, reason: 'stop-failed' });
        if (isJsonMode(options)) {
          printJson({
            status: 'error',
            stoppedCount: 0,
            results: jsonResults,
            messages: [{ level: 'error', code: 'STOP_FAILED', message: `Could not stop OpenChamber PID ${explicitInstance.pid}.` }],
          });
        }
        if (showOutput && !unconfirmedStopSpin) {
          logStatus('error', `could not stop pid ${explicitInstance.pid}`);
          finish('failed');
        }
        printQuietStopResults();
        return;
      }
    } else if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ stoppedCount: 0, results: jsonResults });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances found');
        finish('nothing to stop');
      }
      printQuietStopResults();
      return;
    }

    for (const instance of runningInstances) {
      const stopSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !stopSpin) {
        logStatus('info', `stopping port ${instance.port} (PID: ${instance.pid})`);
      }
      stopSpin?.start(`Stopping OpenChamber on port ${instance.port}...`);
      try {
        const requested = await requestServerShutdown(instance.port, instance.host || options.host);
        const stopped = await stopInstanceProcess(instance.pid, {
          signal: 'SIGINT',
          shutdownWaitMs: requested ? 5000 : 0,
          gracefulTimeoutMs: 2500,
          forceTimeoutMs: 3000,
        });
        if (!stopped && isProcessRunning(instance.pid)) {
          throw new Error(`Timed out stopping pid ${instance.pid}`);
        }
        removePidFile(instance.pidFilePath);
        removeInstanceFile(instance.instanceFilePath);
        stopSpin?.stop(`Stopped OpenChamber on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: true });
        if (showOutput && !stopSpin) {
          logStatus('success', `stopped port ${instance.port}`);
        }
      } catch (error) {
        stopSpin?.error(`Failed to stop OpenChamber on port ${instance.port}`);
        jsonResults.push({ port: instance.port, pid: instance.pid, stopped: false, reason: error instanceof Error ? error.message : String(error) });
        if (showOutput) {
          logStatus('error', `error stopping port ${instance.port}`, error.message);
        } else if (!isJsonMode(options) && !isQuietMode(options)) {
          console.error(`Error stopping port ${instance.port}: ${error.message}`);
        }
      }
    }

    if (isJsonMode(options)) {
      const stoppedCount = jsonResults.filter((entry) => entry.stopped).length;
      const hasFailure = jsonResults.some((entry) => !entry.stopped);
      printJson({
        status: hasFailure ? 'warning' : 'ok',
        stoppedCount,
        results: jsonResults,
      });
      return;
    }

    finish(`${runningInstances.length} instance(s)`);
    printQuietStopResults();
}

async function restartCommand(options, serveCommand) {
    const commandContext = this && typeof this === 'object' ? this : {};
    const runStop = typeof commandContext.stop === 'function'
      ? commandContext.stop.bind(commandContext)
      : stopCommand;
    const runServe = typeof commandContext.serve === 'function'
      ? commandContext.serve.bind(commandContext)
      : serveCommand;
    const showOutput = shouldRenderHumanOutput(options);
    const restarted = [];

    if (showOutput) {
      clackIntro('OpenChamber Restart');
    }

    let runningInstances = await discoverLifecycleInstances(options);
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ restartedCount: 0, results: restarted });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances to restart');
        clackOutro('nothing to restart');
      } else if (isQuietMode(options)) {
        process.stdout.write('restarted 0\n');
      }
      return;
    }

    for (const instance of runningInstances) {
      if (instance.runtime === 'desktop') {
        const message = `Port ${instance.port} is managed by OpenChamber Desktop and cannot be restarted with this command.`;
        if (isJsonMode(options)) {
          printJson({
            status: 'warning',
            restartedCount: 0,
            results: [{ fromPort: instance.port, runtime: 'desktop', ok: false, reason: 'desktop-managed' }],
            messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message }],
          });
          return;
        }
        if (showOutput) {
          logStatus('warning', `port ${instance.port} is managed by OpenChamber Desktop`, 'cannot be restarted with this command');
          clackOutro('no changes applied');
        } else if (isQuietMode(options)) {
          process.stdout.write('restarted 0\n');
        }
        return;
      }

      const storedOptions = instance.instanceFilePath
        ? (readInstanceOptions(instance.instanceFilePath) || { port: instance.port })
        : { port: instance.port };
      const instanceHost = storedOptions.host || instance.host || options.host;
      const launchMode = instance.launchMode || 'daemon';
      const isForeground = launchMode === 'foreground';

      const restartPort = options.explicitPort ? options.port : instance.port;

      const restartSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !restartSpin) {
        logStatus('info', `restarting port ${instance.port}`, `mode: ${launchMode}`);
      }
      restartSpin?.start(`Restarting OpenChamber on port ${instance.port}...`);
      try {
        await runStop({
          explicitPort: true,
          port: instance.port,
          host: instanceHost,
          quiet: true,
          suppressQuietOutput: true,
        });

        // Foreground instances are managed by a process manager (systemd,
        // Docker, etc.) that will restart them automatically after stop.
        // Do not call serve() here — just record the stop as a successful
        // restart and let the process manager handle the actual restart.
        if (isForeground) {
          restarted.push({ fromPort: instance.port, toPort: restartPort, launchMode, ok: true });
          restartSpin?.stop(`Stopped foreground instance on port ${instance.port} (process manager will restart)`);
          if (showOutput && !restartSpin) {
            logStatus('success', `port ${instance.port} stopped`, 'process manager will restart');
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const restartedPort = await runServe({
          port: restartPort,
          host: instanceHost,
          explicitPort: true,
          uiPassword: options.explicitUiPassword ? options.uiPassword : (storedOptions.uiPassword || options.uiPassword),
          apiOnly: storedOptions.apiOnly === true || options.apiOnly === true,
          suppressStartupSummary: true,
          quiet: true,
          suppressUiPasswordWarning: true,
          suppressQuietOutput: true,
        });
        restarted.push({ fromPort: instance.port, toPort: restartedPort, launchMode, ok: true });
        restartSpin?.stop(`Restarted OpenChamber on port ${restartedPort}`);
        if (showOutput && !restartSpin) {
          logStatus('success', `port ${restartedPort} restarted`, `mode: ${launchMode}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        restartSpin?.error(`Failed to restart OpenChamber on port ${instance.port}`);
        if (showOutput && !restartSpin) {
          logStatus('error', `failed to restart port ${instance.port}`, message);
        }
        throw error;
      }
    }

    if (isJsonMode(options)) {
      printJson({ restartedCount: restarted.length, results: restarted.map((r) => ({ ...r, launchMode: r.launchMode })) });
      return;
    }

    if (showOutput) {
      clackOutro(`${runningInstances.length} instance(s) restarted`);
    } else if (isQuietMode(options)) {
      process.stdout.write(`restarted ${restarted.length}\n`);
    }
}

// Asks a running instance to hand off: it starts a successor on its own listening socket and exits once the
// successor serves. The pid file moves to the successor only after that, so it is the signal that the handoff
// worked. A failed handoff leaves the old pid in place: the old process keeps serving.
async function handOffInstance(instance) {
  const pidFilePath = await getPidFilePath(instance.port);
  const fromPid = instance.pid;
  if (!Number.isInteger(fromPid) || fromPid <= 0) return { port: instance.port, ok: false, reason: 'unknown-pid' };
  try {
    process.kill(fromPid, SELF_HANDOFF_SIGNAL);
  } catch (error) {
    return { port: instance.port, ok: false, reason: 'signal-failed', message: error?.message };
  }

  const deadline = Date.now() + resolveHandoffTimeoutMs() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pid = readPidFile(pidFilePath);
    if (pid !== null && pid !== fromPid && isProcessRunning(pid)) {
      return { port: instance.port, ok: true, fromPid, pid };
    }
  }
  return { port: instance.port, ok: false, reason: `not-handed-off (see \`openchamber logs -p ${instance.port}\`)`, fromPid };
}

async function handoffCommand(options) {
    const showOutput = shouldRenderHumanOutput(options);
    const results = [];

    if (showOutput) {
      clackIntro('OpenChamber Handoff');
    }

    // Windows has no signal to send: process.kill with any signal other than 0 terminates the target there.
    if (process.platform === 'win32') {
      throw new TunnelCliError('Handoff needs POSIX signals and is not available on Windows. Use `openchamber restart`.', EXIT_CODE.USAGE_ERROR);
    }
    if (!isSelfHandoffEnabled()) {
      throw new TunnelCliError('Self-handoff is disabled here (OPENCHAMBER_SELF_HANDOFF=0). Restart with `openchamber restart` instead.', EXIT_CODE.USAGE_ERROR);
    }

    const runningInstances = await discoverLifecycleInstances(options);
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ handedOffCount: 0, results });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances to hand off');
        clackOutro('nothing to hand off');
      } else if (isQuietMode(options)) {
        process.stdout.write('handed 0\n');
      }
      return;
    }

    for (const instance of runningInstances) {
      if (instance.runtime === 'desktop') {
        results.push({ port: instance.port, ok: false, reason: 'desktop-managed' });
        if (showOutput) logStatus('warning', `port ${instance.port} is managed by OpenChamber Desktop`, 'cannot be handed off with this command');
        continue;
      }
      const result = await handOffInstance(instance);
      results.push(result);
      if (showOutput) {
        if (result.ok) logStatus('success', `port ${result.port} handed off`, `PID ${result.fromPid} -> ${result.pid}`);
        else logStatus('error', `port ${result.port} not handed off`, `${result.reason}; PID ${instance.pid} keeps serving`);
      }
    }

    const failed = results.filter((result) => !result.ok);
    if (isJsonMode(options)) {
      printJson({ handedOffCount: results.length - failed.length, results });
    } else if (showOutput) {
      clackOutro(failed.length === 0 ? `${results.length} instance(s) handed off` : `${failed.length} instance(s) not handed off`);
    } else if (isQuietMode(options)) {
      for (const result of results) {
        if (result.ok) process.stdout.write(`handed ${result.port} ${result.pid}\n`);
        else process.stdout.write(`failed ${result.port} ${result.reason}\n`);
      }
    }
    if (failed.length > 0) {
      process.exitCode = EXIT_CODE.GENERAL_ERROR;
    }
}


// Rotation is a stop plus a start that must not reuse the saved pair. The
// stop goes through the same SIGINT path as `openchamber stop`, which closes
// the managed OpenCode and clears state.json; the start then carries the
// rotation flag, so even a state file that survived the stop (the stop
// escalated and OpenChamber was killed) cannot be adopted with the old
// credentials: the server discards the saved password and agent tool token
// for that start and writes a fresh pair. Credential values are never read
// or printed here.
async function rotateCredentialsCommand(options, serveCommand) {
    const commandContext = this ?? {};
    const runStop = commandContext.stop ? commandContext.stop.bind(commandContext) : stopCommand;
    const runServe = commandContext.serve ? commandContext.serve.bind(commandContext) : serveCommand;
    const showOutput = shouldRenderHumanOutput(options);
    const rotated = [];

    if (showOutput) {
      clackIntro('OpenChamber Rotate Credentials');
    }

    let runningInstances = await discoverLifecycleInstances(options);
    if (runningInstances.length === 0) {
      if (isJsonMode(options)) {
        printJson({ rotatedCount: 0, results: rotated });
      }
      if (showOutput) {
        logStatus('info', 'No running OpenChamber instances to rotate credentials for');
        clackOutro('nothing to rotate');
      } else if (isQuietMode(options)) {
        process.stdout.write('rotated 0\n');
      }
      return;
    }

    for (const instance of runningInstances) {
      if (instance.runtime === 'desktop') {
        const message = `Port ${instance.port} is managed by OpenChamber Desktop and cannot be rotated with this command.`;
        if (isJsonMode(options)) {
          printJson({
            status: 'warning',
            rotatedCount: 0,
            results: [{ fromPort: instance.port, runtime: 'desktop', ok: false, reason: 'desktop-managed' }],
            messages: [{ level: 'warning', code: 'DESKTOP_MANAGED_PORT', message }],
          });
          return;
        }
        if (showOutput) {
          logStatus('warning', `port ${instance.port} is managed by OpenChamber Desktop`, 'cannot be rotated with this command');
          clackOutro('no changes applied');
        } else if (isQuietMode(options)) {
          process.stdout.write('rotated 0\n');
        }
        return;
      }

      const storedOptions = instance.instanceFilePath
        ? (readInstanceOptions(instance.instanceFilePath) || { port: instance.port })
        : { port: instance.port };
      const instanceHost = storedOptions.host || instance.host || options.host;
      const launchMode = instance.launchMode || 'daemon';
      const isForeground = launchMode === 'foreground';

      const restartPort = options.explicitPort ? options.port : instance.port;

      const rotateSpin = showOutput ? createSpinner(options) : null;
      if (showOutput && !rotateSpin) {
        logStatus('info', `rotating credentials for port ${instance.port}`, `mode: ${launchMode}`);
      }
      rotateSpin?.start(`Rotating credentials for OpenChamber on port ${instance.port}...`);
      try {
        await runStop({
          explicitPort: true,
          port: instance.port,
          host: instanceHost,
          quiet: true,
          suppressQuietOutput: true,
        });

        // Foreground instances are managed by a process manager (systemd,
        // Docker, etc.) that restarts them after the stop. The stop cleared
        // the saved managed state, so the restarted server generates a
        // fresh pair on its next start; there is nothing to serve here.
        if (isForeground) {
          rotated.push({ fromPort: instance.port, toPort: restartPort, launchMode, ok: true });
          rotateSpin?.stop(`Stopped foreground instance on port ${instance.port} (process manager will restart it with fresh credentials)`);
          if (showOutput && !rotateSpin) {
            logStatus('success', `port ${instance.port} stopped`, 'process manager will restart it with fresh credentials');
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const restartedPort = await runServe({
          port: restartPort,
          host: instanceHost,
          explicitPort: true,
          uiPassword: options.explicitUiPassword ? options.uiPassword : (storedOptions.uiPassword || options.uiPassword),
          apiOnly: storedOptions.apiOnly === true || options.apiOnly === true,
          rotateCredentials: true,
          suppressStartupSummary: true,
          quiet: true,
          suppressUiPasswordWarning: true,
          suppressQuietOutput: true,
        });
        rotated.push({ fromPort: instance.port, toPort: restartedPort, launchMode, ok: true });
        rotateSpin?.stop(`Rotated credentials for OpenChamber on port ${restartedPort}`);
        if (showOutput && !rotateSpin) {
          logStatus('success', `port ${restartedPort} restarted with fresh credentials`, `mode: ${launchMode}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rotateSpin?.error(`Failed to rotate credentials for OpenChamber on port ${instance.port}`);
        if (showOutput && !rotateSpin) {
          logStatus('error', `failed to rotate credentials for port ${instance.port}`, message);
        }
        throw error;
      }
    }

    if (isJsonMode(options)) {
      printJson({ rotatedCount: rotated.length, results: rotated.map((r) => ({ ...r, launchMode: r.launchMode })) });
      return;
    }

    if (showOutput) {
      clackOutro(`${runningInstances.length} instance(s) rotated`);
    } else if (isQuietMode(options)) {
      process.stdout.write(`rotated ${rotated.length}\n`);
    }
}

function createLifecycleCommands({ serveCommand }) {
  return {
    stop: stopCommand,
    restart(options) {
      return restartCommand.call(this, options, serveCommand);
    },
    handoff: handoffCommand,
    rotateCredentials(options) {
      return rotateCredentialsCommand.call(this, options, serveCommand);
    },
  };
}

export { createLifecycleCommands };
