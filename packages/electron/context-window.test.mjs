import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextWindowUrl, isContextWindowOwnerId, readContextWindowState } from './context-window.mjs';

test('opens the owner page with only the owner id in the query', () => {
  assert.equal(buildContextWindowUrl('openchamber-ui://app/index.html?session=abc#x', 'a1b2c3d4-0000'), 'openchamber-ui://app/index.html?contextWindow=a1b2c3d4-0000');
  assert.equal(buildContextWindowUrl('http://localhost:5173/?settings=general', 'a1b2c3d4-0000'), 'http://localhost:5173/?contextWindow=a1b2c3d4-0000');
});

test('accepts only window ids the renderer makes', () => {
  assert.equal(isContextWindowOwnerId('6f1c2a7e-8b1d-4c3a-9f00-123456789abc'), true);
  assert.equal(isContextWindowOwnerId('short'), false);
  assert.equal(isContextWindowOwnerId('../etc/passwd'), false);
  assert.equal(isContextWindowOwnerId(42), false);
});

test('reads saved state and drops broken bounds', () => {
  assert.deepEqual(
    readContextWindowState({ owners: ['a1b2c3d4-0000'], bounds: { x: 10, y: 20, width: 800, height: 600, maximized: true } }),
    { owners: ['a1b2c3d4-0000'], bounds: { x: 10, y: 20, width: 800, height: 600, maximized: true } },
  );
  assert.deepEqual(readContextWindowState({ owners: 'yes', bounds: { x: 'a', y: 0, width: 1, height: 1 } }), { owners: [], bounds: null });
  assert.deepEqual(readContextWindowState(undefined), { owners: [], bounds: null });
});
