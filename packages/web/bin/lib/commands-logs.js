import { getLogFilePath } from './cli-paths.js';
import { readTailLines, followFile } from './cli-log-files.js';
import { discoverRunningInstances, getLatestInstance } from './cli-lifecycle.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  shouldRenderHumanOutput,
  printJson,
  logStatus,
} from '../cli-output.js';

async function logsCommand(options) {
  const showFrames = shouldRenderHumanOutput(options);
  const shouldPrefixLines = options.all || !showFrames;
  let targets = [];
  const running = await discoverRunningInstances();

  if (options.all) {
    targets = running;
    if (targets.length === 0) {
      throw new Error('No running OpenChamber instance found.');
    }
  } else if (options.explicitPort) {
    const found = running.find((entry) => entry.port === options.port);
    if (!found) {
      throw new Error(`No running OpenChamber instance found on port ${options.port}.`);
    }
    targets = [found];
  } else {
    const latest = getLatestInstance(running);
    if (!latest) {
      throw new Error('No running OpenChamber instance found.');
    }
    targets = [latest];
    if (shouldRenderHumanOutput(options)) {
      logStatus('info', `no port specified; using latest started instance on port ${latest.port}`);
    }
  }

  if (isJsonMode(options)) {
    if (options.follow) {
      throw new Error('`openchamber logs --json` requires `--no-follow` for deterministic JSON output.');
    }
    const entries = targets.map((target) => {
      const logPath = getLogFilePath(target.port);
      return {
        port: target.port,
        logPath,
        lines: readTailLines(logPath, options.lines),
      };
    });
    printJson({ entries });
    return;
  }

  if (showFrames) {
    clackIntro('OpenChamber Logs');
  }

  for (const target of targets) {
    const logPath = getLogFilePath(target.port);
    const lines = readTailLines(logPath, options.lines);
    if (showFrames) {
      logStatus('info', `port ${target.port}`, logPath);
    }

    for (const line of lines) {
      if (shouldPrefixLines) {
        console.log(`[${target.port}] ${line}`);
      } else {
        console.log(line);
      }
    }
  }

  if (showFrames) {
    clackOutro(options.follow ? 'following (Ctrl+C to stop)' : 'tail complete');
  }

  if (!options.follow) {
    return;
  }

  const unsubs = targets.map((target) => {
    const logPath = getLogFilePath(target.port);
    return followFile(logPath, (line) => {
      if (shouldPrefixLines) {
        console.log(`[${target.port}] ${line}`);
      } else {
        console.log(line);
      }
    });
  });

  await new Promise((resolve) => {
    const onSignal = () => {
      for (const unsub of unsubs) {
        unsub();
      }
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

export { logsCommand };
