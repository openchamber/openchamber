import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from './args.mjs';

test('answers the version the lifecycle reads before every start', () => {
  assert.deepEqual(parseArgs(['--version']), { command: 'version' });
  assert.deepEqual(parseArgs(['-v']), { command: 'version' });
});

test('reads the serve command line the managed lifecycle builds', () => {
  assert.deepEqual(parseArgs(['serve', '--hostname', '127.0.0.1', '--port', '45678']), {
    command: 'serve', mode: 'default', cors: [], hostname: '127.0.0.1', port: 45678,
  });
  assert.deepEqual(parseArgs(['serve', '--stdio', '--hostname=0.0.0.0', '--port=0', '--cors', 'https://a.example']), {
    command: 'serve', mode: 'stdio', cors: ['https://a.example'], hostname: '0.0.0.0', port: 0,
  });
});

test('refuses commands other than serve and malformed options', () => {
  assert.deepEqual(parseArgs(['run', 'hello']), { command: 'unsupported' });
  assert.deepEqual(parseArgs([]), { command: 'unsupported' });
  assert.throws(() => parseArgs(['serve', '--port', '70000']), /Invalid --port/);
  assert.throws(() => parseArgs(['serve', '--port', '12ab']), /Invalid --port/);
  assert.throws(() => parseArgs(['serve', '--hostname']), /--hostname needs a value/);
  assert.throws(() => parseArgs(['serve', '--service']), /Unknown option: --service/);
});
