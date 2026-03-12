#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform === 'darwin';

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: useDetachedChildren,
    ...options,
  });

  child.on('error', (error) => {
    console.error(`[dev:web:full] Failed to start ${label}:`, error);
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (useDetachedChildren && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
  }
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

function waitForFirstBuildSuccess(buildChild) {
  return new Promise((resolve, reject) => {
    let done = false;

    const settleResolve = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const settleReject = (error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const onOutput = (chunk, source) => {
      const text = chunk.toString();
      if (source === 'stdout') {
        stdoutBuffer += text;
        if (stdoutBuffer.length > 8000) {
          stdoutBuffer = stdoutBuffer.slice(-4000);
        }
      } else {
        stderrBuffer += text;
        if (stderrBuffer.length > 8000) {
          stderrBuffer = stderrBuffer.slice(-4000);
        }
      }

      if (/\bbuilt in\b/i.test(text) || /watching for file changes/i.test(text)) {
        settleResolve();
      }
    };

    const onStdout = (chunk) => onOutput(chunk, 'stdout');
    const onStderr = (chunk) => onOutput(chunk, 'stderr');

    const onExit = (code, signal) => {
      if (done) return;
      const suffix = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      settleReject(new Error(`Build watcher exited before first successful build (${suffix}).`));
    };

    const onError = (error) => {
      settleReject(error);
    };

    const cleanup = () => {
      buildChild.stdout?.off('data', onStdout);
      buildChild.stderr?.off('data', onStderr);
      buildChild.off('exit', onExit);
      buildChild.off('error', onError);
    };

    buildChild.stdout?.on('data', onStdout);
    buildChild.stderr?.on('data', onStderr);
    buildChild.on('exit', onExit);
    buildChild.on('error', onError);
  });
}

let shuttingDown = false;
let api = null;
const build = run('build', 'bun', ['run', '--cwd', 'packages/web', 'build:watch']);

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(api), stopChildTree(build)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (code !== 0 || signal) {
      console.error(`[dev:web:full] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

build.on('exit', onChildExit('build'));

waitForFirstBuildSuccess(build)
  .then(() => {
    if (shuttingDown || api) {
      return;
    }
    console.log('[dev:web:full] Initial frontend build ready, starting API watcher...');
    api = run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch']);
    api.on('exit', onChildExit('api'));
  })
  .catch((error) => {
    console.error('[dev:web:full] Failed waiting for initial frontend build:', error.message || error);
    shutdown(1).catch(() => process.exit(1));
  });

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});

process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
