#!/usr/bin/env node

/**
 * Example custom usage provider script for OpenChamber.
 *
 * To test in OpenChamber, configure ~/.config/openchamber/usage-providers.json:
 * {
 *   "version": 1,
 *   "commands": {
 *     "codex": ["node", "/path/to/openchamber/scripts/example-usage-provider.mjs"]
 *   }
 * }
 */

const now = Date.now();

const payload = {
  version: 1,
  providerName: 'Codex',
  accounts: [
    {
      id: 'account-1',
      label: 'Work Account',
      email: 'w***@example.com',
      current: true,
      available: true,
      status: 'Active',
      planType: 'plus',
      credits: '12.50',
      limits: [
        {
          windowMinutes: 300,
          usedPercent: 24,
          resetAtMs: now + 2.5 * 3600 * 1000,
        },
        {
          windowMinutes: 10080,
          usedPercent: 48,
          resetAtMs: now + 3 * 86400 * 1000,
        },
      ],
    },
    {
      id: 'account-2',
      label: 'Personal Account',
      email: 'p***@example.com',
      current: false,
      available: true,
      status: 'Eligible',
      planType: 'pro',
      credits: '0.00',
      limits: [
        {
          windowMinutes: 300,
          usedPercent: 82,
          resetAtMs: now + 45 * 60 * 1000,
        },
        {
          windowMinutes: 10080,
          usedPercent: 65,
          resetAtMs: now + 5 * 86400 * 1000,
        },
      ],
    },
  ],
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
