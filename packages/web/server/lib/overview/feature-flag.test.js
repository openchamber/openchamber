import { afterEach, describe, expect, test } from 'bun:test';

import { isOverviewFeatureAvailable } from './feature-flag.js';

const original = process.env.OPENCHAMBER_OVERVIEW_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.OPENCHAMBER_OVERVIEW_ENABLED;
  else process.env.OPENCHAMBER_OVERVIEW_ENABLED = original;
});

describe('the overview gate', () => {
  test('is closed when the variable is unset', () => {
    delete process.env.OPENCHAMBER_OVERVIEW_ENABLED;
    expect(isOverviewFeatureAvailable()).toBe(false);
  });

  test('opens for the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      process.env.OPENCHAMBER_OVERVIEW_ENABLED = value;
      expect(isOverviewFeatureAvailable()).toBe(true);
    }
  });

  test('stays closed for anything else, including "false"', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'maybe']) {
      process.env.OPENCHAMBER_OVERVIEW_ENABLED = value;
      expect(isOverviewFeatureAvailable()).toBe(false);
    }
  });
});
