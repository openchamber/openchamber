import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { remainingPercentToUsedPercent } from './quotaProviders';

describe('remainingPercentToUsedPercent', () => {
  test('maps MiniMax remaining percentages to used percentages', () => {
    assert.equal(remainingPercentToUsedPercent(100), 0);
    assert.equal(remainingPercentToUsedPercent(94), 6);
  });

  test('clamps invalid remaining percentages', () => {
    assert.equal(remainingPercentToUsedPercent(120), 0);
    assert.equal(remainingPercentToUsedPercent(-20), 100);
    assert.equal(remainingPercentToUsedPercent(null), null);
  });
});
