import { mock } from 'bun:test';

type ModuleFactory = Parameters<typeof mock.module>[1];

/** The exports a `mock.module` factory has to return. */
type ModuleExports = ReturnType<ModuleFactory>;

/**
 * Put a module back after this test file replaced it with `mock.module`.
 *
 * Bun keeps a module replacement for the rest of the process and
 * `mock.restore()` does not remove it, so a file that mocks a module other
 * files import has to restore the real exports when it finishes. Capture them
 * with `{ ...moduleNamespace }` before the first `mock.module` call: the mock
 * updates the namespace object in place, so a reference to it is no longer the
 * original.
 *
 * Re-importing the module after the restore is what makes the next test file see
 * the real exports again.
 */
export const restoreModuleMock = async <R>(
  specifier: string,
  original: ModuleExports,
  reload: () => Promise<R>,
): Promise<void> => {
  mock.module(specifier, () => original);
  await reload();
};
