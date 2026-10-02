import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoadFailureWarningFilter, LOAD_FAILURE_REPEAT_WINDOW_MS } from './load-failure-warnings.mjs';

const electronWarning = (message) => Object.assign(new Error(message), { name: 'electron' });
const REFUSED = electronWarning('Failed to load URL: http://127.0.0.1:5173/ with error: ERR_CONNECTION_REFUSED');

test('reports the first load failure and demotes repeats inside the window', () => {
  let clock = 1_000;
  const shouldReport = createLoadFailureWarningFilter({ now: () => clock });

  assert.equal(shouldReport(REFUSED), true);
  for (let attempt = 0; attempt < 66; attempt += 1) {
    clock += 600;
    assert.equal(shouldReport(REFUSED), false);
  }
});

test('reports the same failure again once the window has passed', () => {
  let clock = 1_000;
  const shouldReport = createLoadFailureWarningFilter({ now: () => clock });

  assert.equal(shouldReport(REFUSED), true);
  clock += LOAD_FAILURE_REPEAT_WINDOW_MS;
  assert.equal(shouldReport(REFUSED), true);
});

test('tracks each URL and error separately', () => {
  const shouldReport = createLoadFailureWarningFilter({ now: () => 1_000 });

  assert.equal(shouldReport(REFUSED), true);
  assert.equal(shouldReport(electronWarning('Failed to load URL: http://127.0.0.1:3000/ with error: ERR_CONNECTION_REFUSED')), true);
  assert.equal(shouldReport(electronWarning('Failed to load URL: http://127.0.0.1:5173/ with error: ERR_BLOCKED_BY_CSP')), true);
});

test('never holds back unrelated warnings', () => {
  const shouldReport = createLoadFailureWarningFilter({ now: () => 1_000 });
  const deprecation = Object.assign(new Error('Buffer() is deprecated'), { name: 'DeprecationWarning' });
  const otherElectron = electronWarning('Some other Electron warning');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(shouldReport(deprecation), true);
    assert.equal(shouldReport(otherElectron), true);
  }
});
