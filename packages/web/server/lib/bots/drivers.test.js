import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const execute = promisify(execFile);
const drivers = [
  new URL('./adapter-mutation.driver.mjs', import.meta.url),
  new URL('./adapters.driver.mjs', import.meta.url),
  new URL('./host-process.driver.mjs', import.meta.url),
  new URL('./merge-authorization.driver.mjs', import.meta.url),
  new URL('./notices-driver.mjs', import.meta.url),
  new URL('./questions-driver.mjs', import.meta.url),
  new URL('./production-driver.mjs', import.meta.url),
  new URL('./production-isolated-mutation.driver.mjs', import.meta.url),
  new URL('./production-isolated.driver.mjs', import.meta.url),
  new URL('./runtime-driver.mjs', import.meta.url),
  new URL('./scheduler-driver.mjs', import.meta.url),
  new URL('./services.driver.mjs', import.meta.url),
  new URL('./tool-dispatch.driver.mjs', import.meta.url),
];

for (const driver of drivers) {
  test(`bot driver ${fileURLToPath(driver).split('/').at(-1)}`, async () => {
    // execFile rejects on nonzero exit, including any driver assertion failure.
    await execute(process.execPath, [fileURLToPath(driver)], { timeout: 170_000, maxBuffer: 4 * 1024 * 1024 });
  }, 180_000);
}
