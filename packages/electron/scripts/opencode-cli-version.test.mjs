import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeCliVersion, readPinnedOpenCodeCliVersion } from './opencode-cli-version.mjs';

describe('bundled OpenCode CLI version', () => {
  test('reads the version out of the OpenCode 2.x --version line', () => {
    assert.equal(parseOpenCodeCliVersion('opencode v2.0.2\n'), '2.0.2');
    assert.equal(parseOpenCodeCliVersion('opencode v2.1.0-beta.3'), '2.1.0-beta.3');
  });

  test('answers empty for output that names no version', () => {
    assert.equal(parseOpenCodeCliVersion('command not found'), '');
    assert.equal(parseOpenCodeCliVersion(''), '');
  });

  test('pins the desktop CLI to an exact OpenCode 2.x release', () => {
    const version = readPinnedOpenCodeCliVersion();
    assert.match(version, /^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
