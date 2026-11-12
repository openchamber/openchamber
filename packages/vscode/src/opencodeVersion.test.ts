import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenCodeVersionOutput, parseOpenCodeVersion } from './opencodeVersion';

describe('OpenCode version gate', () => {
  test('accepts an OpenCode 2.x CLI', () => {
    assert.deepEqual(checkOpenCodeVersionOutput('opencode v2.0.2\n'), { supported: true, version: '2.0.2' });
  });

  test('rejects a 1.x CLI and names the version it found', () => {
    const check = checkOpenCodeVersionOutput('1.18.30\n');
    assert.equal(check.supported, false);
    assert.equal(check.supported === false && check.version, '1.18.30');
    assert.match(check.supported === false ? check.reason : '', /requires OpenCode 2\.x/);
  });

  test('rejects output that names no version instead of guessing', () => {
    assert.equal(parseOpenCodeVersion('command not found: opencode'), null);
    const check = checkOpenCodeVersionOutput('command not found: opencode');
    assert.equal(check.supported, false);
    assert.equal(check.supported === false && check.version, null);
  });
});
