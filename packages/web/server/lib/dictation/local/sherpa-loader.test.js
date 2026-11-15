import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';

import { applySherpaLoaderEnv } from './sherpa-loader.js';

describe('sherpa platform package resolution', () => {
  // Regression guard: the platform package is an optional dependency of
  // sherpa-onnx-node, so an isolated install (bun's default layout, pnpm)
  // keeps it nested inside sherpa-onnx-node's node_modules and it cannot be
  // resolved from this module's own location. When resolution fell back to
  // this module only, loadSherpaOnnxNode() reported "platform package not
  // installed" while the addon was installed, and its retry never ran.
  it('finds the installed platform package through sherpa-onnx-node', () => {
    const env = {};
    const { key, libDir } = applySherpaLoaderEnv(env);

    expect(libDir, 'the platform package was not resolved').toBeTruthy();
    expect(key).toBeTruthy();
    expect(existsSync(path.join(libDir, 'sherpa-onnx.node'))).toBe(true);
    expect(String(env[key]).split(path.delimiter)[0]).toBe(libDir);
  });
});
