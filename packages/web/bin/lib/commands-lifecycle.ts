import type { CliOptions } from './cli-args.js';
import type { createServeCommand } from './commands-serve.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';
import { requestServerShutdown } from './cli-http.js';
import { isPortAvailable } from './cli-ports.js';
import {
  discoverLifecycleInstances,
  discoverUnconfirmedRegistryInstanceOnPort,
} from './cli-lifecycle.js';
import {
  readInstanceOptions,
  hasInstanceFields,
  removePidFile,
  removeInstanceFile,
  isProcessRunning,
  stopInstanceProcess,
  SERVER_SHUTDOWN_GRACE_MS,
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

type StopOptions = Pick<Partial<CliOptions>, 'port' | 'explicitPort' | 'json' | 'quiet'> & {
  host?: JsonValue | undefined;
  suppressQuietOutput?: boolean;
};
type RestartOptions = StopOptions & Pick<Partial<CliOptions>, 'explicitUiPassword' | 'uiPassword' | 'apiOnly'>;
type StopResult = { port: number | undefined; stopped: boolean; reason?: string; runtime?: string; pid?: number | null };
type RestartResult = { fromPort: number; toPort: number | undefined; launchMode: 'foreground' | 'daemon'; ok: true };
type ServeCommand = ReturnType<typeof createServeCommand>;
type RestartContext = { stop?: typeof stopCommand; serve?: ServeCommand };
export interface LifecycleCommandDependencies {
  serveCommand: ServeCommand;
}

function isFinitePid(value: unknown): value is number {
  return Number.isFinite(value);
}

function isRestartContext(value: unknown): value is RestartContext {
  return Boolean(value && typeof value === 'object');
}

function isLifecycleCallback<Callback>(value: Callback | undefined): value is Callback {
  return typeof value === 'function';
}

function assertLifecycleFailure(error: unknown): asserts error is { message?: unknown } {
  if (error === null || error === undefined) {
    if ('Bun' in globalThis) {
      throw new TypeError(`${error} is not an object (evaluating 'error.message')`);
    }
    throw new TypeError(`Cannot read properties of ${error} (reading 'message')`);
  }
}

async function stopCommand(options: StopOptions) {
    const showOutput = shouldRenderHumanOutput(options);
    const suppressQuietOutput = options?.suppressQuietOutput === true;
    const jsonResults: StopResult[] = [];
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
    const finish = (text: string) => {
      if (!showOutput) return;
      clackOutro(text);
    };

    if (showOutput) {
      clackIntro('OpenChamber Stop');
    }

    let runningInstances = await discoverLifecycleInstances(options);
    if (options.explicitPort) {
      const requestedPort = options.port;
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
      if (!explicitInstance) throw new TypeError('Missing explicit instance');
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
        const requested = await requestServerShutdown(requestedPort, options.host);

        if (isFinitePid(explicitInstance.pid) && isProcessRunning(explicitInstance.pid)) {
          await stopInstanceProcess(explicitInstance.pid, {
            shutdownWaitMs: requested ? SERVER_SHUTDOWN_GRACE_MS : 0,
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
          shutdownWaitMs: requested ? SERVER_SHUTDOWN_GRACE_MS : 0,
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
          assertLifecycleFailure(error);
          const detail = error.message;
          logStatus('error', `error stopping port ${instance.port}`, detail ? `${detail}` : undefined);
        } else if (!isJsonMode(options) && !isQuietMode(options)) {
          assertLifecycleFailure(error);
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

async function restartCommand(this: RestartContext, options: RestartOptions, serveCommand: ServeCommand) {
    const commandContext: RestartContext = isRestartContext(this) ? this : {};
    const runStop = isLifecycleCallback(commandContext.stop)
      ? commandContext.stop.bind(commandContext)
      : stopCommand;
    const runServe = isLifecycleCallback(commandContext.serve)
      ? commandContext.serve.bind(commandContext)
      : serveCommand;
    const showOutput = shouldRenderHumanOutput(options);
    const restarted: RestartResult[] = [];

    if (showOutput) {
      clackIntro('OpenChamber Restart');
    }

    const runningInstances = await discoverLifecycleInstances(options);
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

      const storedInput = instance.instanceFilePath
        ? (readInstanceOptions(instance.instanceFilePath) || { port: instance.port })
        : { port: instance.port };
      const storedOptions = hasInstanceFields(storedInput) ? storedInput : {};
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

function createLifecycleCommands({ serveCommand }: LifecycleCommandDependencies) {
  return {
    stop: stopCommand,
    restart(this: RestartContext, options: RestartOptions) {
      return restartCommand.call(this, options, serveCommand);
    },
  };
}

export { createLifecycleCommands };
