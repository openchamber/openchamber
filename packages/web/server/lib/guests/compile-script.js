import fs from 'node:fs/promises';

const siblingTypeScript = (jsPath) => {
  if (!jsPath.endsWith('.js')) {
    return null;
  }
  return `${jsPath.slice(0, -3)}.ts`;
};

/** When a sibling `.ts` exists and this process is Bun, compile it to a classic IIFE. */
export const compileGuestScript = async (jsPath) => {
  const tsPath = siblingTypeScript(jsPath);
  if (!tsPath) {
    return null;
  }
  try {
    await fs.stat(tsPath);
    const bun = globalThis.Bun;
    if (!bun?.build) {
      return null;
    }
    const result = await bun.build({
      entrypoints: [tsPath],
      format: 'iife',
      target: 'browser',
      minify: true,
      write: false,
    });
    if (!result.success) {
      const message = result.logs.map((log) => log.message).join('\n');
      console.warn(
        'Guest script compile failed; serving on-disk JS instead.',
        message || 'Guest script build failed',
      );
      return null;
    }
    const artifact = result.outputs[0];
    if (!artifact) {
      console.warn('Guest script compile produced no output; serving on-disk JS instead.');
      return null;
    }
    return Buffer.from(await artifact.text());
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    // oc-dev compiles sibling .ts when present. Missing workspace links (or other
    // resolve errors) must not blank the panel when panel/main.js was already bundled.
    console.warn('Guest script compile failed; serving on-disk JS instead.', error);
    return null;
  }
};
