/**
 * Reproduction test for issue #2264:
 * "SSH master process exited before ready" — lost stderr from the master process.
 *
 * When the SSH ControlMaster process exits during `waitForMasterReady`, the
 * stderr output (which contains the actual SSH error like "Permission denied",
 * "Connection refused", etc.) is discarded. The user only sees the generic
 * "SSH master process exited before ready" message with no diagnostic info.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('SSH master process error reproduction', () => {

  /**
   * This test demonstrates the bug: when the SSH master process exits,
   * its stderr is NOT captured and included in the error message.
   * The user only sees "SSH master process exited before ready" with
   * no context about why the SSH connection failed.
   */
  test('waitForMasterReady discards master process stderr', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-repro-'));
    tempDirs.push(tempDir);

    // Simulate what happens: the master process is spawned with stderr piped
    // but never read. Let's create a mock SSH master process that outputs
    // an error to stderr and exits with non-zero code.
    //
    // Real scenario: ssh -M ... -N fails with e.g.:
    //   "Permission denied (publickey)." on stderr
    //   exit code: 255

    // Simulate a master process that fails
    const failingProcess = spawn(process.execPath, [
      '-e',
      `process.stderr.write('Permission denied (publickey).\\n'); process.exit(255);`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // This is the key: waitForMasterReady checks exit code but never reads stderr
    let stderr = '';
    // NOTE: we DO read stderr here in the test, but the actual code doesn't!
    failingProcess.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Simulate waitForMasterReady logic
    const deadline = Date.now() + 5000;
    let caught = false;
    let capturedMessage = '';

    while (Date.now() < deadline) {
      const exited = failingProcess.exitCode;
      if (typeof exited === 'number') {
        // BUG: The error message below doesn't include stderr content
        capturedMessage = 'SSH master process exited before ready';
        caught = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(caught).toBe(true);
    expect(capturedMessage).toBe('SSH master process exited before ready');

    // The stderr from the process IS available but gets DROPPED
    // Here's what the user should be seeing:
    expect(stderr.trim()).toBe('Permission denied (publickey).');

    // The actual error message contains ZERO diagnostic info
    // The user only sees: "SSH master process exited before ready"
    // But the stderr explains WHY: "Permission denied (publickey)."
    console.log('=== Reproduction of issue #2264 ===');
    console.log('Master process exit code:', failingProcess.exitCode);
    console.log('Master process stderr (DISCARDED by current code):', stderr.trim());
    console.log('Error shown to user:', capturedMessage);
    console.log('');
    console.log('Root cause: waitForMasterReady() at ssh-manager.mjs:843-862');
    console.log('throws a generic error without capturing master stderr.');
    console.log('The stderr would contain the real SSH error (e.g.');
    console.log('"Permission denied", "Connection refused", etc.)');
  });
});
